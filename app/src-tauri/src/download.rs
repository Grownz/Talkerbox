//! Resumable streaming HTTP download with progress callbacks.

use crate::{net_err, Progress};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

/// Validates an http(s) URL and derives a safe local file name from its last path segment.
pub fn safe_file_name(url: &str) -> Result<(reqwest::Url, String), String> {
    let u = reqwest::Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("Only http(s) URLs are supported".into());
    }
    let last = u.path_segments().and_then(|mut s| s.next_back()).unwrap_or("");
    let name: String = last.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    let name = name.trim_start_matches('.').to_string();
    if name.is_empty() {
        return Err("URL does not end in a file name".into());
    }
    Ok((u, name))
}

/// First 16 hex chars of the SHA-256 of a URL: identifies downloads so different files never share a partial.
pub fn url_hash(url: &str) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(url.as_bytes()))[..16].to_string()
}

/// Partial file for `url` -> `dest`: `<dest>.<url hash>.part`, so a resume only ever continues the same URL.
pub fn part_path(dest: &Path, url: &str) -> PathBuf {
    let mut p = dest.as_os_str().to_owned();
    p.push(format!(".{}.part", url_hash(url)));
    PathBuf::from(p)
}

/// Downloads `url` to `dest`, resuming from its partial file (see `part_path`) if present. Returns Ok(true)
/// if cancelled (the partial file is kept so the next attempt resumes).
pub async fn download(
    http: &reqwest::Client,
    url: reqwest::Url,
    dest: &Path,
    max_bytes: Option<u64>,
    cancel: &Notify,
    on: impl Fn(Progress),
) -> Result<bool, String> {
    let too_big = |n: u64| max_bytes.is_some_and(|m| n > m);
    let too_big_msg = || format!("File is larger than the {:.1} MB limit", max_bytes.unwrap_or(0) as f64 / 1048576.0);
    let io = |p: &Path, e: std::io::Error| format!("{}: {e}", p.display());
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| io(dir, e))?;
    }
    let part = part_path(dest, url.as_str());
    let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);

    let mut req = http.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut resp = tokio::select! {
        _ = cancel.notified() => return Ok(true),
        r = req.send() => r.map_err(net_err)?,
    };
    let status = resp.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && have > 0 {
        // The part file already holds the whole resource.
        tokio::fs::rename(&part, dest).await.map_err(|e| io(dest, e))?;
        return Ok(false);
    }
    if !status.is_success() {
        return Err(format!("Download failed: HTTP {status}"));
    }
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed {
        have = 0; // Server ignored the Range header: start over.
    }
    let total = resp.content_length().map(|l| l + have);
    if total.is_some_and(too_big) {
        return Err(too_big_msg());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&part)
        .await
        .map_err(|e| io(&part, e))?;

    let mut last = Instant::now();
    on(Progress { message: "Downloading".into(), completed: Some(have), total });
    loop {
        let chunk = tokio::select! {
            _ = cancel.notified() => { file.flush().await.ok(); return Ok(true); }
            c = resp.chunk() => c.map_err(net_err)?,
        };
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk).await.map_err(|e| io(&part, e))?;
        have += chunk.len() as u64;
        if too_big(have) {
            // Server sent no or a wrong length: stop and drop the partial file.
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(too_big_msg());
        }
        if last.elapsed() > Duration::from_millis(200) {
            on(Progress { message: "Downloading".into(), completed: Some(have), total });
            last = Instant::now();
        }
    }
    file.flush().await.map_err(|e| io(&part, e))?;
    drop(file);
    if let Some(t) = total {
        if have != t {
            return Err(format!("Download incomplete ({have} of {t} bytes); retry to resume"));
        }
    }
    on(Progress { message: "Downloaded".into(), completed: Some(have), total });
    tokio::fs::rename(&part, dest).await.map_err(|e| io(dest, e))?;
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testsrv::{response, serve};

    fn body() -> Vec<u8> {
        (0..1000u32).map(|i| (i % 251) as u8).collect()
    }

    /// (result, final file, partial file)
    type Outcome = (Result<bool, String>, Option<Vec<u8>>, Option<Vec<u8>>);

    /// Runs one download into a fresh temp dir, optionally with a pre-existing partial file.
    /// Returns the result, the final file and the partial file contents.
    fn run(
        name: &str,
        base: &str,
        part: Option<&[u8]>,
        max: Option<u64>,
        cancel_first: bool,
    ) -> Outcome {
        let dir = std::env::temp_dir().join(format!("talkerbox-dl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let url = format!("{base}/file.bin");
        let dest = dir.join("file.bin");
        let part_file = part_path(&dest, &url);
        if let Some(p) = part {
            std::fs::write(&part_file, p).unwrap();
        }
        let cancel = Notify::new();
        if cancel_first {
            cancel.notify_one();
        }
        let http = reqwest::Client::new();
        let r = tauri::async_runtime::block_on(download(&http, reqwest::Url::parse(&url).unwrap(), &dest, max, &cancel, |_| {}));
        let out = (r, std::fs::read(&dest).ok(), std::fs::read(&part_file).ok());
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn fresh_download() {
        let base = serve(1, |req| {
            assert!(!req.contains("range:"));
            response("200 OK", Some(1000), &body())
        });
        let (r, dest, part) = run("fresh", &base, None, None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(body()));
        assert_eq!(part, None);
    }

    #[test]
    fn resume_appends_after_206() {
        let base = serve(1, |req| {
            assert!(req.contains("range: bytes=400-"), "{req}");
            response("206 Partial Content", Some(600), &body()[400..])
        });
        let (r, dest, _) = run("resume", &base, Some(&body()[..400]), None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(body()));
    }

    #[test]
    fn range_ignored_restarts_from_zero() {
        let base = serve(1, |_| response("200 OK", Some(1000), &body()));
        let (r, dest, _) = run("restart", &base, Some(&[0xAA; 400]), None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(body()));
    }

    #[test]
    fn range_not_satisfiable_means_complete() {
        let base = serve(1, |_| response("416 Range Not Satisfiable", Some(0), b""));
        let (r, dest, part) = run("416", &base, Some(&body()), None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(body()));
        assert_eq!(part, None);
    }

    #[test]
    fn over_limit_by_header_and_by_stream() {
        let base = serve(1, |_| response("200 OK", Some(1000), &body()));
        let (r, dest, _) = run("limit-hdr", &base, None, Some(500), false);
        assert!(r.unwrap_err().contains("limit"));
        assert_eq!(dest, None);

        // No Content-Length: the size is only known while streaming; the partial file is dropped.
        let base = serve(1, |_| response("200 OK", None, &body()));
        let (r, dest, part) = run("limit-stream", &base, None, Some(500), false);
        assert!(r.unwrap_err().contains("limit"));
        assert_eq!((dest, part), (None, None));
    }

    #[test]
    fn short_body_fails_and_keeps_partial() {
        let base = serve(1, |_| response("200 OK", Some(1000), &body()[..500]));
        let (r, dest, part) = run("short", &base, None, None, false);
        assert!(r.is_err());
        assert_eq!(dest, None);
        assert!(part.is_some_and(|p| p.len() <= 500), "partial file must stay for resume");
    }

    #[test]
    fn cancel_before_start() {
        let (r, dest, _) = run("cancel", "http://127.0.0.1:9", None, None, true);
        assert_eq!(r, Ok(true));
        assert_eq!(dest, None);
    }

    #[test]
    fn partial_files_are_per_url() {
        let dest = Path::new("C:/x/file.bin");
        assert_ne!(part_path(dest, "https://a/file.bin"), part_path(dest, "https://b/file.bin"));
        assert_eq!(url_hash("https://a/file.bin").len(), 16);
    }

    #[test]
    fn file_names_are_sanitised() {
        let ok = |u: &str| safe_file_name(u).map(|(_, n)| n);
        assert_eq!(ok("https://h/a/b/model-Q4_K_M.gguf?download=1").as_deref(), Ok("model-Q4_K_M.gguf"));
        assert_eq!(ok("https://h/x/..%2F..%2Fevil.exe").as_deref(), Ok("_2F.._2Fevil.exe"));
        assert_eq!(ok("https://h/a/my%20model.gguf").as_deref(), Ok("my_20model.gguf"));
        assert!(ok("https://h/").is_err());
        assert!(ok("file:///C:/x.gguf").is_err());
        assert!(ok("not a url").is_err());
    }
}
