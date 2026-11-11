//! TTS sidecar (`tts-sidecar.exe`) lifecycle and HTTP calls.
//! Contract: `--port <n> --model <onnx> --voices <bin>`; GET /health, GET /voices, POST /synthesize -> audio/wav.

use crate::net_err;
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

pub const KOKORO_MODEL_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
pub const KOKORO_VOICES_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";

/// Where the sidecar can be. Bundled/release builds: Tauri installs `externalBin` next to the main exe
/// without the target-triple suffix. Dev builds: that copy is only refreshed when the build script reruns,
/// so it can be a stale placeholder; fall back to the source file in `src-tauri/binaries`.
fn sidecar_candidates() -> Vec<PathBuf> {
    let mut c: Vec<PathBuf> = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| vec![d.join("tts-sidecar.exe")])).unwrap_or_default();
    if cfg!(debug_assertions) {
        c.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join("tts-sidecar-x86_64-pc-windows-msvc.exe"));
    }
    c
}

/// First non-empty sidecar exe, or a description of what was found where (the repo placeholder is an empty file).
pub fn sidecar_path() -> Result<PathBuf, String> {
    let mut why = Vec::new();
    for p in sidecar_candidates() {
        match std::fs::metadata(&p) {
            Ok(m) if m.len() > 0 => return Ok(p),
            Ok(_) => why.push(format!("{} is an empty placeholder", p.display())),
            Err(_) => why.push(format!("{} is missing", p.display())),
        }
    }
    Err(format!("TTS sidecar not installed: {}", why.join("; ")))
}

/// Size floors that reject placeholders and truncated downloads (real files: ~310 MB fp32 / ~88 MB int8 model, ~27 MB voices).
const MIN_MODEL: u64 = 20 << 20;
const MIN_VOICES: u64 = 1 << 20;

/// Picks the Kokoro model (.onnx) and voices (.bin) from the TTS model dir, preferring the default names.
pub fn model_files(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let big_enough = |p: &Path, min: u64| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() >= min);
    let pick = |default: &str, ext: &str, min: u64| {
        let d = dir.join(default);
        if big_enough(&d, min) {
            return Some(d);
        }
        let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)) && big_enough(p, min))
            .collect();
        found.sort();
        found.into_iter().next()
    };
    Some((pick("kokoro-v1.0.onnx", "onnx", MIN_MODEL)?, pick("voices-v1.0.bin", "bin", MIN_VOICES)?))
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("No free port: {e}"))?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

pub fn spawn(exe: &Path, model: &Path, voices: &Path, log: &Path) -> Result<(Child, u16), String> {
    let port = free_port()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--port").arg(port.to_string()).arg("--model").arg(model).arg("--voices").arg(voices);
    crate::background(&mut cmd, log)?;
    // The sidecar exits when its stdin closes. The pipe stays open while the Child is held, and closes
    // when Talkerbox exits or dies, so the sidecar never outlives us.
    cmd.stdin(std::process::Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("Failed to start TTS sidecar: {e}"))?;
    Ok((child, port))
}

pub async fn healthy(http: &reqwest::Client, port: u16) -> bool {
    let r = http.get(format!("http://127.0.0.1:{port}/health")).timeout(Duration::from_secs(2)).send().await;
    matches!(r, Ok(r) if r.status().is_success())
}

/// Polls /health until ready, failing early if the process exits.
pub async fn wait_ready(http: &reqwest::Client, port: u16, mut exited: impl FnMut() -> Option<String>) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(60) {
        if let Some(code) = exited() {
            return Err(format!("TTS sidecar exited ({code}); see sidecar.log in the app data folder"));
        }
        if healthy(http, port).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err("TTS sidecar did not become ready within 60 s".into())
}

pub async fn voices(http: &reqwest::Client, port: u16) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct V {
        voices: Vec<String>,
    }
    let r = http.get(format!("http://127.0.0.1:{port}/voices")).send().await.map_err(net_err)?;
    let r = crate::ollama::check(r).await?;
    Ok(r.json::<V>().await.map_err(net_err)?.voices)
}

pub async fn synthesize(http: &reqwest::Client, port: u16, text: &str, voice: &str, speed: f32) -> Result<Vec<u8>, String> {
    let r = http
        .post(format!("http://127.0.0.1:{port}/synthesize"))
        .json(&json!({ "text": text, "voice": voice, "speed": speed }))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(net_err)?;
    let r = crate::ollama::check(r).await?;
    Ok(r.bytes().await.map_err(net_err)?.to_vec())
}
