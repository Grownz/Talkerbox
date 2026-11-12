//! TTS sidecar (`tts-sidecar.exe`) lifecycle and HTTP calls.
//! Contract: `--port <n> --model <onnx> --voices <bin>`; GET /health, GET /voices, POST /synthesize -> audio/wav.

use crate::net_err;
use serde::{Deserialize, Serialize};
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

pub const VOICE_EXTS: [&str; 4] = ["pt", "npy", "npz", "bin"];
pub const MAX_VOICE_BYTES: u64 = 50 << 20;

pub const MAX_MODEL_BYTES: u64 = 1 << 30;
pub const MAX_VOCAB_BYTES: u64 = 10 << 20;

fn has_ext(name: &str, exts: &[&str]) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && exts.iter().any(|e| e.eq_ignore_ascii_case(ext)))
}

fn has_voice_ext(name: &str) -> bool {
    has_ext(name, &VOICE_EXTS)
}

/// Direct download URL for a link: HuggingFace `.../blob/<rev>/<path>` pages become `.../resolve/<rev>/<path>`.
pub fn direct_url(input: &str) -> Result<reqwest::Url, String> {
    let mut u = reqwest::Url::parse(input.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    let host = u.host_str().unwrap_or("").trim_start_matches("www.").to_string();
    if host == "huggingface.co" || host == "hf.co" {
        let mut segs: Vec<String> = u.path_segments().map(|s| s.map(str::to_owned).collect()).unwrap_or_default();
        if segs.get(2).is_some_and(|s| s == "blob") {
            segs[2] = "resolve".into();
            u.set_path(&segs.join("/"));
        }
    }
    Ok(u)
}

fn file_of(u: &reqwest::Url) -> &str {
    u.path_segments().and_then(|mut s| s.next_back()).unwrap_or("")
}

/// What a TTS link points to, by file extension.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Voice,
    Model,
    Vocab,
}

pub fn link_kind(input: &str) -> Result<LinkKind, String> {
    let u = direct_url(input)?;
    let f = file_of(&u);
    if has_voice_ext(f) {
        Ok(LinkKind::Voice)
    } else if has_ext(f, &["onnx"]) {
        Ok(LinkKind::Model)
    } else if has_ext(f, &["json"]) {
        Ok(LinkKind::Vocab)
    } else if has_ext(f, &["pth", "safetensors", "ckpt"]) {
        Err("This is a PyTorch checkpoint. Only ONNX Kokoro fine-tunes (.onnx) are supported; Talkerbox does not convert models.".into())
    } else {
        Err("Unsupported link: expected a voice (.pt, .npy, .npz, .bin) or an ONNX model (.onnx)".into())
    }
}

/// Validated direct URL of the expected kind.
pub fn url_of_kind(input: &str, kind: LinkKind) -> Result<String, String> {
    let k = link_kind(input)?;
    if k != kind {
        return Err(match kind {
            LinkKind::Voice => format!("Voice files must end in .{}", VOICE_EXTS.join(", .")),
            LinkKind::Model => "The model link must point to an .onnx file".into(),
            LinkKind::Vocab => "The vocab link must point to a .json file".into(),
        });
    }
    Ok(direct_url(input)?.to_string())
}

/// Voice ids are file stems and the sidecar accepts only `[A-Za-z0-9_-]{1,64}`.
pub fn valid_voice_stem(stem: &str) -> bool {
    (1..=64).contains(&stem.len()) && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Validated voice download URL. The file stem becomes the voice id, so it is checked here (before any download)
/// instead of being silently rewritten.
pub fn voice_url(input: &str) -> Result<String, String> {
    let url = url_of_kind(input, LinkKind::Voice)?;
    let u = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    let stem = file_of(&u).rsplit_once('.').map_or("", |(s, _)| s);
    if !valid_voice_stem(stem) {
        return Err(format!(
            "The voice file name '{stem}' becomes the voice id and may only contain letters, digits, '_' and '-' (max 64 characters)"
        ));
    }
    Ok(url)
}

/// Optional folder of extra voices, passed to the sidecar only when it holds at least one voice file.
pub fn voices_dir_arg(dir: &Path) -> Option<&Path> {
    let any = std::fs::read_dir(dir).ok()?.filter_map(Result::ok).any(|e| has_voice_ext(&e.file_name().to_string_lossy()));
    any.then_some(dir)
}

/// Installed custom voice files (sorted by name).
pub fn custom_voices(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|r| r.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_file() && has_voice_ext(&p.file_name().unwrap_or_default().to_string_lossy())).collect())
        .unwrap_or_default();
    v.sort();
    v
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("No free port: {e}"))?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

pub fn spawn(
    exe: &Path,
    model: &Path,
    voices: &Path,
    voices_dir: Option<&Path>,
    packs_dir: Option<&Path>,
    log: &Path,
) -> Result<(Child, u16), String> {
    let port = free_port()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--port").arg(port.to_string()).arg("--model").arg(model).arg("--voices").arg(voices);
    if let Some(d) = voices_dir {
        cmd.arg("--voices-dir").arg(d);
    }
    if let Some(d) = packs_dir {
        cmd.arg("--packs-dir").arg(d);
    }
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

#[derive(Debug, Serialize, Deserialize)]
pub struct VoiceDetail {
    pub id: String,
    #[serde(default)]
    pub pack: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    /// Unknown language and no pack: synthesised with the base model.
    #[serde(default)]
    pub fallback: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VoiceList {
    pub voices: Vec<String>,
    /// Missing from older sidecars.
    #[serde(default)]
    pub details: Vec<VoiceDetail>,
}

pub async fn voices(http: &reqwest::Client, port: u16) -> Result<VoiceList, String> {
    let r = http.get(format!("http://127.0.0.1:{port}/voices")).send().await.map_err(net_err)?;
    let r = crate::ollama::check(r).await?;
    r.json::<VoiceList>().await.map_err(net_err)
}

/// Returns the WAV bytes and whether the sidecar fell back to the base model (`X-TTS-Fallback: 1`).
pub async fn synthesize(http: &reqwest::Client, port: u16, text: &str, voice: &str, speed: f32) -> Result<(Vec<u8>, bool), String> {
    let r = http
        .post(format!("http://127.0.0.1:{port}/synthesize"))
        .json(&json!({ "text": text, "voice": voice, "speed": speed }))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(net_err)?;
    let r = crate::ollama::check(r).await?;
    let fallback = r.headers().get("x-tts-fallback").is_some_and(|v| v.as_bytes() == b"1");
    Ok((r.bytes().await.map_err(net_err)?.to_vec(), fallback))
}

#[cfg(test)]
mod tests {
    use super::{link_kind, voice_url, LinkKind};

    #[test]
    fn link_kinds() {
        assert_eq!(link_kind("https://huggingface.co/u/r/blob/main/kokoro-de.onnx"), Ok(LinkKind::Model));
        assert_eq!(link_kind("https://x.org/a/martin.npy"), Ok(LinkKind::Voice));
        assert_eq!(link_kind("https://x.org/a/vocab.json"), Ok(LinkKind::Vocab));
        assert!(link_kind("https://huggingface.co/u/r/blob/main/model.safetensors").unwrap_err().contains("ONNX"));
        assert!(link_kind("https://x.org/a/kokoro.pth").unwrap_err().contains("ONNX"));
        assert!(link_kind("https://x.org/a/readme.md").is_err());
    }

    #[test]
    fn voice_links() {
        assert_eq!(
            voice_url("https://huggingface.co/hexgrad/Kokoro-82M/blob/main/voices/af_heart.pt").as_deref(),
            Ok("https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices/af_heart.pt")
        );
        assert_eq!(
            voice_url("https://huggingface.co/u/r/resolve/main/x.npy?download=true").as_deref(),
            Ok("https://huggingface.co/u/r/resolve/main/x.npy?download=true")
        );
        assert_eq!(voice_url(" https://example.com/v/bf_test.NPZ ").as_deref(), Ok("https://example.com/v/bf_test.NPZ"));
        assert!(voice_url("https://example.com/model.gguf").is_err());
        assert!(voice_url("https://example.com/.pt").is_err());
        assert!(voice_url("https://example.com/my%20voice.pt").unwrap_err().contains("voice id"));
        assert!(voice_url("https://example.com/v.1.npy").is_err());
        assert!(voice_url(&format!("https://example.com/{}.npy", "a".repeat(65))).is_err());
        assert!(voice_url("https://example.com/df_kerstin-2.bin").is_ok());
        assert!(voice_url("not a url").is_err());
    }
}
