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

/// Downloads `url` to `dest`, resuming from `<dest>.part` if present. Returns Ok(true) if cancelled
/// (the partial file is kept so the next attempt resumes).
pub async fn download(
    http: &reqwest::Client,
    url: reqwest::Url,
    dest: &Path,
    max_bytes: Option<u64>,
    cancel: &Notify,
    on: impl Fn(Progress),
) -> Result<bool, String> {
    let too_big = |n: u64| max_bytes.is_some_and(|m| n > m);
    let too_big_msg = || format!("File is larger than the {} MB limit", max_bytes.unwrap_or(0) >> 20);
    let io = |p: &Path, e: std::io::Error| format!("{}: {e}", p.display());
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| io(dir, e))?;
    }
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
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
    use super::safe_file_name;

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
