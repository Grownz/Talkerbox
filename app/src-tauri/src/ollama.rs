//! Ollama HTTP API client (https://github.com/ollama/ollama/blob/main/docs/api.md) and `ollama serve` process control.

use crate::{net_err, Progress};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

pub const BASE: &str = "http://127.0.0.1:11434";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelDetails {
    #[serde(alias = "parameter_size")]
    pub parameter_size: Option<String>,
    #[serde(alias = "quantization_level")]
    pub quantization_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub details: ModelDetails,
}

/// Turns a non-2xx response into a readable error, preferring Ollama's `{"error": "..."}` body.
pub async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or(body);
    Err(format!("HTTP {status}: {msg}"))
}

/// Reads a newline-delimited JSON stream, calling `on` per object. Returns Ok(true) if cancelled.
pub async fn ndjson<T: DeserializeOwned>(
    mut resp: reqwest::Response,
    cancel: &Notify,
    mut on: impl FnMut(T) -> Result<(), String>,
) -> Result<bool, String> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = cancel.notified() => return Ok(true),
            c = resp.chunk() => c.map_err(net_err)?,
        };
        let end = chunk.is_none();
        if let Some(c) = chunk {
            buf.extend_from_slice(&c);
        } else {
            buf.push(b'\n');
        }
        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let v: Value = serde_json::from_slice(&line).map_err(|e| format!("Bad response from Ollama: {e}"))?;
            if let Some(err) = v.get("error").and_then(Value::as_str) {
                return Err(err.to_string());
            }
            on(serde_json::from_value(v).map_err(|e| format!("Unexpected response from Ollama: {e}"))?)?;
        }
        if end {
            return Ok(false);
        }
    }
}

pub async fn version(http: &reqwest::Client) -> Option<String> {
    let resp = http.get(format!("{BASE}/api/version")).timeout(Duration::from_secs(2)).send().await.ok()?;
    let v: Value = resp.error_for_status().ok()?.json().await.ok()?;
    v.get("version").and_then(Value::as_str).map(str::to_owned)
}

pub async fn tags(http: &reqwest::Client) -> Result<Vec<ModelInfo>, String> {
    #[derive(Deserialize)]
    struct Tags {
        models: Vec<ModelInfo>,
    }
    let resp = check(http.get(format!("{BASE}/api/tags")).send().await.map_err(net_err)?).await?;
    Ok(resp.json::<Tags>().await.map_err(net_err)?.models)
}

pub async fn delete(http: &reqwest::Client, model: &str) -> Result<(), String> {
    check(http.delete(format!("{BASE}/api/delete")).json(&json!({ "model": model })).send().await.map_err(net_err)?).await?;
    Ok(())
}

pub async fn chat(
    http: &reqwest::Client,
    model: &str,
    messages: &[ChatMessage],
    cancel: &Notify,
    mut on_token: impl FnMut(String) -> Result<(), String>,
) -> Result<bool, String> {
    #[derive(Deserialize)]
    struct Chunk {
        message: Option<ChatMessage>,
    }
    let body = json!({ "model": model, "messages": messages, "stream": true });
    let resp = tokio::select! {
        _ = cancel.notified() => return Ok(true),
        r = http.post(format!("{BASE}/api/chat")).json(&body).send() => check(r.map_err(net_err)?).await?,
    };
    ndjson(resp, cancel, |c: Chunk| match c.message {
        Some(m) if !m.content.is_empty() => on_token(m.content),
        _ => Ok(()),
    })
    .await
}

#[derive(Deserialize)]
struct StatusLine {
    status: String,
    total: Option<u64>,
    completed: Option<u64>,
}

pub async fn pull(http: &reqwest::Client, model: &str, cancel: &Notify, on: impl Fn(Progress)) -> Result<bool, String> {
    let resp = check(http.post(format!("{BASE}/api/pull")).json(&json!({ "model": model })).send().await.map_err(net_err)?).await?;
    ndjson(resp, cancel, |s: StatusLine| {
        on(Progress { message: s.status, completed: s.completed, total: s.total });
        Ok(())
    })
    .await
}

/// Imports a local GGUF: hash -> HEAD/POST /api/blobs/sha256:<hex> -> POST /api/create with `files`.
pub async fn import_gguf(
    http: &reqwest::Client,
    path: &Path,
    model: &str,
    cancel: &Notify,
    on: impl Fn(Progress),
) -> Result<bool, String> {
    let io = |e: std::io::Error| format!("{}: {e}", path.display());
    let total = tokio::fs::metadata(path).await.map_err(io)?.len();
    let mut file = tokio::fs::File::open(path).await.map_err(io)?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    loop {
        let n = tokio::select! {
            _ = cancel.notified() => return Ok(true),
            n = file.read(&mut buf) => n.map_err(io)?,
        };
        if n == 0 {
            break;
        }
        sha2::Digest::update(&mut hasher, &buf[..n]);
        done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            on(Progress { message: "Computing SHA-256".into(), completed: Some(done), total: Some(total) });
            last = std::time::Instant::now();
        }
    }
    let digest = format!("sha256:{:x}", sha2::Digest::finalize(hasher));
    let blob_url = format!("{BASE}/api/blobs/{digest}");

    let head = http.head(&blob_url).send().await.map_err(net_err)?;
    if head.status() == reqwest::StatusCode::NOT_FOUND {
        on(Progress { message: "Uploading blob to Ollama".into(), completed: None, total: Some(total) });
        let file = tokio::fs::File::open(path).await.map_err(io)?;
        let send = http.post(&blob_url).body(reqwest::Body::from(file)).send();
        tokio::select! {
            _ = cancel.notified() => return Ok(true),
            r = send => { check(r.map_err(net_err)?).await?; }
        }
    } else {
        check(head).await?;
    }

    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("model.gguf");
    let body = json!({ "model": model, "files": { file_name: digest } });
    let resp = check(http.post(format!("{BASE}/api/create")).json(&body).send().await.map_err(net_err)?).await?;
    ndjson(resp, cancel, |s: StatusLine| {
        on(Progress { message: s.status, completed: None, total: None });
        Ok(())
    })
    .await
}

/// Spawns `ollama serve` without a console window, logging to `log`.
pub fn spawn_serve(exe: &Path, log: &Path) -> Result<std::process::Child, String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("serve");
    crate::background(&mut cmd, log)?;
    cmd.spawn().map_err(|e| format!("Failed to start {}: {e}", exe.display()))
}
