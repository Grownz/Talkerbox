//! About page: opens web links and the third-party notices in the OS. The webview never chooses a program or a
//! file path: links must be https to an allow-listed host, and the notices path is fixed next to the exe.

use std::process::Command;
use tauri::{AppHandle, Manager, Url};

/// Hosts the About page links to (`src/lib/licences.ts`, `src/lib/About.svelte`); a test keeps them in sync.
const HOSTS: &[&str] = &["github.com", "huggingface.co", "gcc.gnu.org", "docs.python.org", "alphacephei.com", "ai.google.dev"];

fn allowed(url: &str) -> Option<Url> {
    let u = Url::parse(url).ok()?;
    let plain = u.username().is_empty() && u.password().is_none() && u.port().is_none();
    (u.scheme() == "https" && plain && u.host_str().is_some_and(|h| HOSTS.contains(&h))).then_some(u)
}

/// Explorer hands a URL or file to its default program; it is passed as one argument, no shell is involved.
fn shell_open(target: &std::ffi::OsStr) -> Result<(), String> {
    Command::new("explorer").arg(target).spawn().map(drop).map_err(|e| format!("Could not open it: {e}"))
}

/// Opens an allow-listed https link in the default browser.
#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    let u = allowed(&url).ok_or("This link is not allowed")?;
    shell_open(u.as_str().as_ref())
}

/// Opens `THIRD_PARTY_NOTICES.md` from the install folder; `false` when it is not there (dev runs).
#[tauri::command]
pub fn open_notices(app: AppHandle) -> Result<bool, String> {
    let path = app.path().resource_dir().map_err(|e| e.to_string())?.join("THIRD_PARTY_NOTICES.md");
    if !path.is_file() {
        return Ok(false);
    }
    // Notepad, because `.md` often has no default program on Windows (the notices are plain text).
    Command::new("notepad").arg(&path).spawn().map(|_| true).map_err(|e| format!("Could not open it: {e}"))
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn only_https_to_listed_hosts() {
        assert!(allowed("https://github.com/Grownz/Talkerbox").is_some());
        for bad in [
            "http://github.com/x",
            "https://evil.example/x",
            "https://github.com.evil.example/x",
            "https://user@github.com/x",
            "https://github.com:444/x",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(allowed(bad).is_none(), "{bad} must be refused");
        }
    }

    #[test]
    fn every_about_page_link_is_allowed() {
        let sources = [include_str!("../../src/lib/licences.ts"), include_str!("../../src/lib/About.svelte")];
        let mut n = 0;
        for src in sources {
            for part in src.split("https://").skip(1) {
                let end = part.find(['\'', '"', '`', ')', ' ', '\n', '$', '{']).unwrap_or(part.len());
                let url = format!("https://{}", &part[..end]);
                assert!(allowed(&url).is_some(), "{url} is not allowed by HOSTS");
                n += 1;
            }
        }
        assert!(n > 10, "found only {n} links");
    }
}
