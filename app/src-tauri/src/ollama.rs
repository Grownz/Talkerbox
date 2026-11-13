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
    /// Filled in by Talkerbox, not by Ollama.
    #[serde(default, rename = "displayName")]
    pub display_name: String,
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

/// Removes every complete, non-blank line from `buf`; a trailing partial line (which may end inside a
/// multi-byte UTF-8 character) stays for the next chunk.
fn take_lines(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(i) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=i).collect();
        if !line.iter().all(u8::is_ascii_whitespace) {
            out.push(line);
        }
    }
    out
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
        match chunk {
            Some(c) => buf.extend_from_slice(&c),
            None => buf.push(b'\n'), // flush a last line without trailing newline
        }
        for line in take_lines(&mut buf) {
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

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    pub cancelled: bool,
    /// Generated tokens and generation time in ns, from Ollama's final chunk (absent when cancelled).
    pub eval_count: Option<u64>,
    pub eval_duration: Option<u64>,
}

/// Ollama's `/api/show` capabilities of a model, e.g. ["completion", "tools", "thinking"].
pub async fn capabilities(http: &reqwest::Client, model: &str) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct Show {
        #[serde(default)]
        capabilities: Vec<String>,
    }
    let resp = check(http.post(format!("{BASE}/api/show")).json(&json!({ "model": model })).send().await.map_err(net_err)?).await?;
    Ok(resp.json::<Show>().await.map_err(net_err)?.capabilities)
}

/// A piece of a streamed reply: the answer, or the model's reasoning before it (never spoken, never sent back).
#[derive(Debug, Clone, PartialEq)]
pub enum Piece {
    Content(String),
    Thinking(String),
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
enum Phase {
    /// Nothing visible yet: a reply may still open with `<think>`.
    #[default]
    Start,
    Thinking,
    /// Right after `</think>`: whitespace before the answer is dropped.
    Gap,
    Answer,
}

/// Splits `<think>…</think>` at the start of `content` (older Ollama versions and some templates) into thinking
/// and answer, also when a tag is cut across chunks. Current Ollama sends thinking in its own field instead.
#[derive(Debug, Default)]
struct ThinkTags {
    phase: Phase,
    held: String,
}

impl ThinkTags {
    const OPEN: &'static str = "<think>";
    const CLOSE: &'static str = "</think>";

    fn feed(&mut self, s: &str) -> Vec<Piece> {
        self.held.push_str(s);
        let mut out = Vec::new();
        loop {
            match self.phase {
                Phase::Start => {
                    let t = self.held.trim_start();
                    if let Some(rest) = t.strip_prefix(Self::OPEN) {
                        self.held = rest.to_string();
                        self.phase = Phase::Thinking;
                    } else if Self::OPEN.starts_with(t) {
                        break; // blank or a cut-off "<thi": wait for more
                    } else {
                        self.phase = Phase::Answer;
                    }
                }
                Phase::Thinking => {
                    if let Some(i) = self.held.find(Self::CLOSE) {
                        let rest = self.held.split_off(i + Self::CLOSE.len());
                        self.held.truncate(i);
                        push(&mut out, Piece::Thinking(std::mem::replace(&mut self.held, rest)));
                        self.phase = Phase::Gap;
                        continue;
                    }
                    // Keep a possible cut-off "</thi" (ASCII, so the cut is a char boundary).
                    let keep = (1..Self::CLOSE.len()).rev().find(|&k| self.held.ends_with(&Self::CLOSE[..k])).unwrap_or(0);
                    let rest = self.held.split_off(self.held.len() - keep);
                    push(&mut out, Piece::Thinking(std::mem::replace(&mut self.held, rest)));
                    break;
                }
                Phase::Gap => {
                    self.held = self.held.trim_start().to_string();
                    if self.held.is_empty() {
                        break;
                    }
                    self.phase = Phase::Answer;
                }
                Phase::Answer => {
                    push(&mut out, Piece::Content(std::mem::take(&mut self.held)));
                    break;
                }
            }
        }
        out
    }

    /// End of the stream: whatever is still held back.
    fn finish(&mut self) -> Vec<Piece> {
        let held = std::mem::take(&mut self.held);
        let mut out = Vec::new();
        match self.phase {
            Phase::Thinking => push(&mut out, Piece::Thinking(held)),
            Phase::Start => push(&mut out, Piece::Content(held)),
            Phase::Gap | Phase::Answer => {}
        }
        out
    }
}

fn push(out: &mut Vec<Piece>, p: Piece) {
    if !matches!(&p, Piece::Content(s) | Piece::Thinking(s) if s.is_empty()) {
        out.push(p);
    }
}

#[derive(Deserialize)]
struct Chunk {
    message: Option<StreamMessage>,
    eval_count: Option<u64>,
    eval_duration: Option<u64>,
}

/// A streamed message delta; separate from `ChatMessage` so thinking never ends up in the history.
#[derive(Deserialize)]
struct StreamMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    thinking: String,
}

/// Streams a reply. `think_off` sends `"think": false`; only pass it for models with the "thinking" capability.
pub async fn chat(
    http: &reqwest::Client,
    model: &str,
    messages: &[ChatMessage],
    think_off: bool,
    cancel: &Notify,
    on_piece: impl FnMut(Piece) -> Result<(), String>,
) -> Result<ChatResult, String> {
    chat_at(http, BASE, model, messages, think_off, cancel, on_piece).await
}

async fn chat_at(
    http: &reqwest::Client,
    base: &str,
    model: &str,
    messages: &[ChatMessage],
    think_off: bool,
    cancel: &Notify,
    mut on_piece: impl FnMut(Piece) -> Result<(), String>,
) -> Result<ChatResult, String> {
    let mut body = json!({ "model": model, "messages": messages, "stream": true });
    if think_off {
        body["think"] = json!(false);
    }
    let mut retried = false;
    let resp = loop {
        let r = tokio::select! {
            _ = cancel.notified() => return Ok(ChatResult { cancelled: true, ..Default::default() }),
            r = http.post(format!("{base}/api/chat")).json(&body).send() => check(r.map_err(net_err)?).await,
        };
        match r {
            // Safety net: Ollama rejects `think` for models without thinking support (HTTP 400).
            Err(e) if !retried && think_off && e.contains("does not support thinking") => {
                body.as_object_mut().map(|o| o.remove("think"));
                retried = true;
            }
            r => break r?,
        }
    };
    let mut tags = ThinkTags::default();
    let mut result = ChatResult::default();
    result.cancelled = ndjson(resp, cancel, |c: Chunk| {
        if c.eval_count.is_some() {
            result.eval_count = c.eval_count;
            result.eval_duration = c.eval_duration;
        }
        let Some(m) = c.message else { return Ok(()) };
        if !m.thinking.is_empty() {
            on_piece(Piece::Thinking(m.thinking))?;
        }
        tags.feed(&m.content).into_iter().try_for_each(&mut on_piece)
    })
    .await?;
    tags.finish().into_iter().try_for_each(on_piece)?;
    Ok(result)
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

/// Spawns `ollama serve` without a console window; stdout/stderr are piped for the terminal view.
pub fn spawn_serve(exe: &Path) -> Result<std::process::Child, String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("serve");
    crate::hidden(&mut cmd);
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    cmd.spawn().map_err(|e| format!("Failed to start {}: {e}", exe.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testsrv::{response, serve};

    #[test]
    fn lines_reassemble_across_chunks() {
        let stream = "{\"a\":\"Grüße\"}\n\n{\"a\":\"日本\"}\r\n{\"a\":3}".as_bytes();
        // Split at every possible position, including inside multi-byte characters.
        for cut in 0..stream.len() {
            let mut buf = Vec::new();
            let mut lines = Vec::new();
            for part in [&stream[..cut], &stream[cut..], b"\n"] {
                buf.extend_from_slice(part);
                lines.extend(take_lines(&mut buf));
            }
            let parsed: Vec<Value> = lines.iter().map(|l| serde_json::from_slice(l).unwrap()).collect();
            assert_eq!(parsed, vec![json!({"a":"Grüße"}), json!({"a":"日本"}), json!({"a":3})], "cut at {cut}");
            assert!(buf.is_empty());
        }
    }

    #[derive(Deserialize)]
    struct Line {
        n: u32,
    }

    fn stream(body: &'static str) -> (Result<bool, String>, Vec<u32>) {
        let base = serve(1, move |_| response("200 OK", None, body.as_bytes()));
        let mut seen = Vec::new();
        let r = tauri::async_runtime::block_on(async {
            let resp = reqwest::get(&base).await.unwrap();
            ndjson(resp, &Notify::new(), |l: Line| {
                seen.push(l.n);
                Ok(())
            })
            .await
        });
        (r, seen)
    }

    #[test]
    fn ndjson_parses_last_line_without_newline() {
        assert_eq!(stream("{\"n\":1}\n{\"n\":2}"), (Ok(false), vec![1, 2]));
    }

    /// Joins adjacent pieces of the same kind, so tests do not depend on how the text was cut.
    fn merged(pieces: Vec<Piece>) -> Vec<Piece> {
        let mut out: Vec<Piece> = Vec::new();
        for p in pieces {
            match (out.last_mut(), p) {
                (Some(Piece::Content(a)), Piece::Content(b)) | (Some(Piece::Thinking(a)), Piece::Thinking(b)) => a.push_str(&b),
                (_, p) => out.push(p),
            }
        }
        out
    }

    fn split_tags(parts: &[&str]) -> Vec<Piece> {
        let mut t = ThinkTags::default();
        let mut out: Vec<Piece> = parts.iter().flat_map(|p| t.feed(p)).collect();
        out.extend(t.finish());
        merged(out)
    }

    #[test]
    fn think_tags_split_at_every_cut() {
        let s = "\n<think>Grüße, 2+2?</think>\n\nIt is 4. <think> stays</think>";
        let want = vec![Piece::Thinking("Grüße, 2+2?".into()), Piece::Content("It is 4. <think> stays</think>".into())];
        for cut in (0..=s.len()).filter(|&i| s.is_char_boundary(i)) {
            assert_eq!(split_tags(&[&s[..cut], &s[cut..]]), want, "cut at {cut}");
        }
        // One character per chunk.
        let chars: Vec<String> = s.chars().map(String::from).collect();
        assert_eq!(split_tags(&chars.iter().map(String::as_str).collect::<Vec<_>>()), want);
    }

    #[test]
    fn think_tags_leave_plain_replies_alone() {
        assert_eq!(split_tags(&["Hello", " <b>"]), vec![Piece::Content("Hello <b>".into())]);
        assert_eq!(split_tags(&["<", "b>"]), vec![Piece::Content("<b>".into())]);
        assert_eq!(split_tags(&["<thi"]), vec![Piece::Content("<thi".into())]); // stream ended mid-tag
        assert_eq!(split_tags(&["<think>still going"]), vec![Piece::Thinking("still going".into())]); // cancelled
        assert_eq!(split_tags(&["", "", "Hi"]), vec![Piece::Content("Hi".into())]);
    }

    fn chat_with(responses: Vec<Vec<u8>>, think_off: bool) -> (Result<ChatResult, String>, Vec<Piece>, usize) {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = calls.clone();
        let base = serve(responses.len(), move |_| responses[c.fetch_add(1, std::sync::atomic::Ordering::SeqCst)].clone());
        let mut seen = Vec::new();
        let r = tauri::async_runtime::block_on(chat_at(&reqwest::Client::new(), &base, "m", &[], think_off, &Notify::new(), |p| {
            seen.push(p);
            Ok(())
        }));
        (r, merged(seen), calls.load(std::sync::atomic::Ordering::SeqCst))
    }

    #[test]
    fn chat_parses_a_real_thinking_stream() {
        // Recorded from Ollama 0.40.15 (Qwen3.5 4B, `think` omitted), shortened: thinking first, then content.
        let body = include_bytes!("../tests/fixtures/ollama-thinking-stream.ndjson").to_vec();
        let (r, seen, _) = chat_with(vec![response("200 OK", None, &body)], false);
        let r = r.unwrap();
        assert_eq!((r.cancelled, r.eval_count, r.eval_duration), (false, Some(425), Some(2542706000)));
        assert_eq!(
            seen,
            vec![
                Piece::Thinking("Thinking Process:\n the selected draft)".into()),
                Piece::Content("17 multiplied by".into())
            ]
        );
    }

    #[test]
    fn chat_mixes_thinking_field_and_content() {
        let body = concat!(
            "{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"thinking\":\"hmm\"}}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"A\",\"thinking\":\"!\"}}\n",
            "{\"message\":{\"role\":\"assistant\",\"content\":\"B\"},\"done\":true,\"eval_count\":3,\"eval_duration\":9}\n",
        );
        let (r, seen, _) = chat_with(vec![response("200 OK", None, body.as_bytes())], false);
        assert_eq!(r.unwrap().eval_count, Some(3));
        // Within one chunk the thinking delta goes first.
        assert_eq!(seen, vec![Piece::Thinking("hmm!".into()), Piece::Content("AB".into())]);
    }

    #[test]
    fn chat_surfaces_stream_errors() {
        let body = "{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"thinking\":\"a\"}}\n{\"error\":\"out of memory\"}\n";
        let (r, seen, _) = chat_with(vec![response("200 OK", None, body.as_bytes())], false);
        assert_eq!(r.unwrap_err(), "out of memory");
        assert_eq!(seen, vec![Piece::Thinking("a".into())]);
    }

    #[test]
    fn chat_retries_once_without_think() {
        let err = br#"{"error":"\"m\" does not support thinking"}"#;
        let ok = b"{\"message\":{\"role\":\"assistant\",\"content\":\"Hi\"}}\n";
        let (r, seen, calls) = chat_with(vec![response("400 Bad Request", Some(err.len()), err), response("200 OK", None, ok)], true);
        assert!(r.is_ok());
        assert_eq!((seen, calls), (vec![Piece::Content("Hi".into())], 2));
        // Without `think` there is nothing to drop, so the error is final.
        let (r, _, calls) = chat_with(vec![response("400 Bad Request", Some(err.len()), err)], false);
        assert_eq!((r.unwrap_err(), calls), ("HTTP 400 Bad Request: \"m\" does not support thinking".to_string(), 1));
    }

    /// Against a running Ollama: TALKERBOX_OLLAMA (e.g. http://127.0.0.1:11500) and TALKERBOX_THINK_MODEL.
    #[test]
    #[ignore]
    fn chat_real_thinking_model() {
        let base = std::env::var("TALKERBOX_OLLAMA").unwrap();
        let model = std::env::var("TALKERBOX_THINK_MODEL").unwrap();
        let msgs = [ChatMessage { role: "user".into(), content: "What is 17 * 23? One short sentence.".into() }];
        for think_off in [false, true] {
            let t0 = std::time::Instant::now();
            let (mut first_think, mut first_content) = (None, None);
            let mut kinds = Vec::new();
            let r = tauri::async_runtime::block_on(chat_at(&reqwest::Client::new(), &base, &model, &msgs, think_off, &Notify::new(), |p| {
                match &p {
                    Piece::Thinking(_) => first_think = first_think.or(Some(t0.elapsed())),
                    Piece::Content(_) => first_content = first_content.or(Some(t0.elapsed())),
                }
                kinds.push(p);
                Ok(())
            }))
            .unwrap();
            let kinds = merged(kinds);
            println!("think_off={think_off}: first thinking {first_think:?}, first content {first_content:?}, total {:?}, {} tokens", t0.elapsed(), r.eval_count.unwrap_or(0));
            assert!(matches!(kinds.last(), Some(Piece::Content(_))));
            assert_eq!(think_off, first_think.is_none(), "{kinds:?}");
        }
    }

    #[test]
    fn ndjson_surfaces_ollama_errors() {
        let (r, seen) = stream("{\"n\":1}\n{\"error\":\"model not found\"}\n{\"n\":2}\n");
        assert_eq!(r, Err("model not found".into()));
        assert_eq!(seen, vec![1]);
    }
}
