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

/// `safe_file_name` for GGUF imports: the stored file name must end in `.gguf`, so nothing else (e.g. an .exe) lands on disk.
pub fn gguf_file_name(url: &str) -> Result<(reqwest::Url, String), String> {
    let (u, name) = safe_file_name(url)?;
    if !crate::tts::has_ext(&name, &["gguf"]) {
        return Err("The link must point to a .gguf file".into());
    }
    Ok((u, name))
}

/// Deletes every folder in `root` except `keep` (leftovers of aborted downloads).
pub fn remove_other_dirs(root: &Path, keep: &Path) {
    for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let p = e.path();
        if p != keep && e.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

/// Moves a finished partial file to `dest`, after checking its SHA-256 when one is pinned. A mismatch deletes the
/// partial file, so a corrupt or tampered download never becomes the final file and the next try starts over.
async fn finish(part: &Path, dest: &Path, sha256: Option<&str>) -> Result<(), String> {
    if let Some(want) = sha256 {
        let p = part.to_path_buf();
        let got = tauri::async_runtime::spawn_blocking(move || crate::sam::sha256_file(&p)).await.map_err(|e| e.to_string())??;
        if got != want {
            let _ = tokio::fs::remove_file(part).await;
            let name = dest.file_name().unwrap_or_default().to_string_lossy();
            return Err(format!("{name}: checksum mismatch; the download was deleted, retry to download it again"));
        }
    }
    tokio::fs::rename(part, dest).await.map_err(|e| format!("{}: {e}", dest.display()))
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
/// if cancelled (the partial file is kept so the next attempt resumes). With `sha256`, `dest` only ever appears
/// with that hash (see `finish`).
pub async fn download(
    http: &reqwest::Client,
    url: reqwest::Url,
    dest: &Path,
    max_bytes: Option<u64>,
    sha256: Option<&str>,
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

    // At most two requests: a Range request, then (after a 416) one without Range.
    let mut ranged = have > 0;
    let mut resp = loop {
        let mut req = http.get(url.clone());
        if ranged {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let resp = tokio::select! {
            _ = cancel.notified() => return Ok(true),
            r = req.send() => r.map_err(net_err)?,
        };
        if !ranged {
            // Retry after a 416 without a usable Content-Range: the same length means the part is complete.
            if have > 0 && resp.status() == reqwest::StatusCode::OK && resp.content_length() == Some(have) {
                drop(resp);
                finish(&part, dest, sha256).await?;
                return Ok(false);
            }
            break resp;
        }
        if resp.status() != reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            break resp;
        }
        ranged = false;
        let total = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("bytes */"))
            .and_then(|n| n.parse::<u64>().ok());
        match total {
            Some(n) if n == have => {
                // The part file already holds the whole resource.
                finish(&part, dest, sha256).await?;
                return Ok(false);
            }
            Some(_) => {
                // The resource changed upstream: drop the stale part and start over.
                tokio::fs::remove_file(&part).await.map_err(|e| io(&part, e))?;
                have = 0;
            }
            None => {} // Unknown size: ask for the whole file and compare its length.
        }
    };
    let status = resp.status();
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
    finish(&part, dest, sha256).await?;
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
        run_sha(name, base, part, max, None, cancel_first)
    }

    fn run_sha(name: &str, base: &str, part: Option<&[u8]>, max: Option<u64>, sha: Option<&str>, cancel_first: bool) -> Outcome {
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
        let r = tauri::async_runtime::block_on(download(&http, reqwest::Url::parse(&url).unwrap(), &dest, max, sha, &cancel, |_| {}));
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

    fn not_satisfiable(total: usize) -> Vec<u8> {
        format!("HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\n\r\n").into_bytes()
    }

    #[test]
    fn range_not_satisfiable_means_complete() {
        let base = serve(1, |_| not_satisfiable(1000));
        let (r, dest, part) = run("416", &base, Some(&body()), None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(body()));
        assert_eq!(part, None);
    }

    #[test]
    fn range_not_satisfiable_with_other_size_restarts() {
        // Upstream file was replaced by a smaller one: the longer stale partial must not become the final file.
        let fresh = body()[..300].to_vec();
        let base = serve(2, move |req| {
            if req.contains("range:") {
                not_satisfiable(300)
            } else {
                response("200 OK", Some(300), &body()[..300])
            }
        });
        let (r, dest, part) = run("416-stale", &base, Some(&[0xAA; 1000]), None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(fresh));
        assert_eq!(part, None);
    }

    #[test]
    fn range_not_satisfiable_without_header_and_same_length_keeps_part() {
        // The full response has the part's length: the part is complete, and its body (0xBB) is never written.
        let base = serve(2, |req| {
            if req.contains("range:") {
                response("416 Range Not Satisfiable", Some(0), b"")
            } else {
                response("200 OK", Some(1000), &[0xBB; 1000])
            }
        });
        let (r, dest, part) = run("416-nohdr-same", &base, Some(&body()), None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(body()));
        assert_eq!(part, None);
    }

    #[test]
    fn range_not_satisfiable_without_header_and_other_length_downloads_fresh() {
        let base = serve(2, |req| {
            if req.contains("range:") {
                response("416 Range Not Satisfiable", Some(0), b"")
            } else {
                response("200 OK", Some(300), &body()[..300])
            }
        });
        let (r, dest, part) = run("416-nohdr-other", &base, Some(&[0xAA; 1000]), None, false);
        assert_eq!(r, Ok(false));
        assert_eq!(dest, Some(body()[..300].to_vec()));
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
    fn checksum_is_checked_before_the_file_appears() {
        let sha = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(body()));
        let base = serve(1, |_| response("200 OK", Some(1000), &body()));
        assert_eq!(run_sha("sha-ok", &base, None, None, Some(&sha), false), (Ok(false), Some(body()), None));
        // Wrong bytes: neither the final file nor the partial file stays.
        let base = serve(1, |_| response("200 OK", Some(1000), &[0xAA; 1000]));
        let (r, dest, part) = run_sha("sha-bad", &base, None, None, Some(&sha), false);
        assert!(r.unwrap_err().contains("checksum"));
        assert_eq!((dest, part), (None, None));
        // A complete but corrupt partial file (416 path) is caught too.
        let base = serve(1, |_| not_satisfiable(1000));
        let (r, dest, part) = run_sha("sha-416", &base, Some(&[0xAA; 1000]), None, Some(&sha), false);
        assert!(r.unwrap_err().contains("checksum"));
        assert_eq!((dest, part), (None, None));
    }

    #[test]
    fn gguf_names_only() {
        let ok = |u: &str| gguf_file_name(u).map(|(_, n)| n);
        assert_eq!(ok("https://h/a/Model-Q4.GGUF?download=1").as_deref(), Ok("Model-Q4.GGUF"));
        assert!(ok("https://h/a/ollama.exe").is_err());
        assert!(ok("https://h/a/ollama.exe?x=.gguf").is_err());
        assert!(ok("https://h/a/x.gguf%00.exe").is_err());
        assert!(ok("https://h/a/.gguf").is_err());
    }

    #[test]
    fn other_dirs_are_removed() {
        let root = std::env::temp_dir().join(format!("talkerbox-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["keep", "old1", "old2"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
            std::fs::write(root.join(d).join("x.part"), b"x").unwrap();
        }
        std::fs::write(root.join("file.txt"), b"x").unwrap();
        remove_other_dirs(&root, &root.join("keep"));
        let mut left: Vec<String> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["file.txt", "keep"]);
        let _ = std::fs::remove_dir_all(&root);
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
