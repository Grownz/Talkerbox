//! Settings persisted as JSON in the Tauri app config dir.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub ollama_path: Option<String>,
    pub last_model: Option<String>,
    /// Let thinking models reason before answering (their default); false sends `think: false` to Ollama.
    pub think: bool,
    pub voice: Option<String>,
    pub tts_enabled: bool,
    pub tts_speed: f32,
    /// Folder with the Kokoro files; None = `tts` in the app data dir.
    pub tts_model_dir: Option<String>,
    /// Display names keyed by Ollama model id.
    pub display_names: HashMap<String, String>,
    /// Speech input language ("de" or "en").
    pub stt_language: String,
    /// Seconds without transcript change before speech input sends the text.
    pub stt_idle_secs: u32,
    /// Speech input microphone by name; None = system default.
    pub stt_device: Option<String>,
    /// Start `ollama serve` when the app opens.
    pub ollama_autostart: bool,
    /// Avatar window background: "normal", "green" or "transparent".
    pub avatar_bg: String,
    /// Avatar opacity 0-100: background alpha in transparent mode, figure opacity otherwise.
    pub avatar_opacity: u32,
    /// Avatar window position and inner size in logical px [x, y, w, h]; owned by the backend.
    pub avatar_bounds: Option<[f64; 4]>,
    /// Id of the character shown in the avatar window; None = built-in demo figure.
    pub avatar_active: Option<String>,
    /// The avatar is shown in the main window's sidebar instead of its own window (restored at start).
    pub avatar_docked: bool,
    /// The avatar window stays above other windows (its pin button); owned by the backend.
    pub avatar_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama_path: None,
            last_model: None,
            think: true,
            voice: None,
            tts_enabled: true,
            tts_speed: 1.0,
            tts_model_dir: None,
            display_names: HashMap::new(),
            stt_language: "en".into(),
            stt_idle_secs: 5,
            stt_device: None,
            ollama_autostart: true,
            avatar_bg: "normal".into(),
            avatar_opacity: 100,
            avatar_bounds: None,
            avatar_active: None,
            avatar_docked: false,
            avatar_on_top: false,
        }
    }
}

// Serialises load-modify-save cycles from different commands.
static LOCK: Mutex<()> = Mutex::new(());

// A file held briefly by antivirus or backup tools is read again before giving up.
const READ_RETRIES: u32 = 3;
const READ_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);

/// Applies `f` to the stored settings and saves them.
pub fn update<R>(app: &AppHandle, f: impl FnOnce(&mut Settings) -> R) -> Result<R, String> {
    update_at(&file(app)?, f)
}

fn update_at<R>(path: &Path, f: impl FnOnce(&mut Settings) -> R) -> Result<R, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut tries = 0;
    let read = loop {
        match std::fs::read(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound && tries < READ_RETRIES => {
                tries += 1;
                std::thread::sleep(READ_RETRY_DELAY);
            }
            r => break r,
        }
    };
    let mut s = match read {
        Ok(b) => match parse(&b) {
            Some(s) => s,
            None => keep_bad(path).map(|()| Settings::default())?,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        // An unreadable (e.g. locked) file must not be replaced by defaults.
        Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
    };
    let r = f(&mut s);
    write_atomic(path, &serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?)?;
    Ok(r)
}

/// Moves an unparseable settings file to `<name>.bad` (or `.bad.1`, `.bad.2`, ...) so it is not overwritten.
fn keep_bad(path: &Path) -> Result<(), String> {
    let bad = |n: u32| {
        let mut p = path.as_os_str().to_owned();
        p.push(if n == 0 { ".bad".to_string() } else { format!(".bad.{n}") });
        PathBuf::from(p)
    };
    let target = (0..).map(bad).find(|p| !p.exists()).expect("unbounded range");
    std::fs::rename(path, &target).map_err(|e| format!("Cannot keep unreadable {}: {e}", path.display()))
}

/// Saves settings coming from the UI. Fields owned by backend commands keep their stored values.
pub fn save_from_ui(app: &AppHandle, ui: Settings) -> Result<(), String> {
    update(app, |s| from_ui(s, ui))
}

fn from_ui(s: &mut Settings, ui: Settings) {
    *s = Settings {
        ollama_path: s.ollama_path.take(),
        tts_model_dir: s.tts_model_dir.take(),
        display_names: std::mem::take(&mut s.display_names),
        avatar_bounds: s.avatar_bounds.take(),
        avatar_on_top: s.avatar_on_top,
        ..ui
    }
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("No config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    file(app).map(|f| load_from(&f)).unwrap_or_default()
}

fn load_from(path: &Path) -> Settings {
    // A missing or corrupt file falls back to defaults rather than blocking startup.
    std::fs::read(path).ok().and_then(|b| parse(&b)).unwrap_or_default()
}

/// Parses settings field by field: a field with a wrong type or range keeps its default, the others are kept.
/// None only if the bytes are not a JSON object at all.
fn parse(bytes: &[u8]) -> Option<Settings> {
    let serde_json::Value::Object(stored) = serde_json::from_slice(bytes).ok()? else { return None };
    let serde_json::Value::Object(mut merged) = serde_json::to_value(Settings::default()).ok()? else { return None };
    for (k, v) in stored {
        // Unknown keys are dropped, as plain deserialisation did.
        let Some(old) = merged.insert(k.clone(), v) else {
            merged.remove(&k);
            continue;
        };
        if serde_json::from_value::<Settings>(serde_json::Value::Object(merged.clone())).is_err() {
            merged.insert(k, old);
        }
    }
    serde_json::from_value(serde_json::Value::Object(merged)).ok()
}

/// Writes `bytes` to a temp file next to `f`, then renames it over `f`, so readers never see half a file.
pub fn write_atomic(f: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    let mut tmp = f.as_os_str().to_owned();
    tmp.push(".tmp");
    let err = |e: std::io::Error| format!("Cannot write {}: {e}", f.display());
    // sync_all before the rename, so a crash cannot leave an empty file under the final name.
    let mut t = std::fs::File::create(&tmp).map_err(err)?;
    t.write_all(bytes).and_then(|()| t.sync_all()).map_err(err)?;
    drop(t);
    std::fs::rename(&tmp, f).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("talkerbox-cfg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn corrupt_file_is_kept_as_bad_and_never_overwritten() {
        let d = dir("corrupt");
        let f = d.join("settings.json");
        std::fs::write(&f, b"{ broken one").unwrap();
        update_at(&f, |s| s.last_model = Some("a".into())).unwrap();
        assert_eq!(std::fs::read(d.join("settings.json.bad")).unwrap(), b"{ broken one");
        assert_eq!(load_from(&f).last_model.as_deref(), Some("a"));
        // A second corrupt file must not replace the first backup.
        std::fs::write(&f, b"{ broken two").unwrap();
        update_at(&f, |_| ()).unwrap();
        assert_eq!(std::fs::read(d.join("settings.json.bad")).unwrap(), b"{ broken one");
        let bads = std::fs::read_dir(&d).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".bad")).count();
        assert_eq!(bads, 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn wrongly_typed_field_falls_back_alone() {
        let d = dir("lenient");
        let f = d.join("settings.json");
        std::fs::write(&f, br#"{"sttIdleSecs":5.5,"lastModel":"x","displayNames":{"m":"N"}}"#).unwrap();
        let s = load_from(&f);
        assert_eq!(s.last_model.as_deref(), Some("x"));
        assert_eq!(s.display_names.get("m").map(String::as_str), Some("N"));
        assert_eq!(s.stt_idle_secs, Settings::default().stt_idle_secs);
        update_at(&f, |_| ()).unwrap();
        assert!(!d.join("settings.json.bad").exists());
        assert_eq!(load_from(&f).last_model.as_deref(), Some("x"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unreadable_path_is_an_error_and_left_alone() {
        let d = dir("unreadable");
        let f = d.join("settings.json");
        std::fs::create_dir(&f).unwrap();
        let t = std::time::Instant::now();
        assert!(update_at(&f, |_| ()).is_err());
        assert!(t.elapsed() >= READ_RETRY_DELAY * READ_RETRIES, "the read was not retried");
        assert!(f.is_dir());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_file_gives_defaults_without_bad_copy() {
        let d = dir("missing");
        let f = d.join("settings.json");
        assert_eq!(load_from(&f).stt_idle_secs, Settings::default().stt_idle_secs);
        update_at(&f, |_| ()).unwrap();
        assert!(f.is_file());
        assert!(!d.join("settings.json.bad").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn save_from_ui_keeps_backend_owned_fields() {
        let d = dir("ui");
        let f = d.join("settings.json");
        update_at(&f, |s| {
            s.ollama_path = Some("C:/ollama.exe".into());
            s.tts_model_dir = Some("D:/tts".into());
            s.display_names.insert("m".into(), "Name".into());
            s.avatar_bounds = Some([1.0, 2.0, 3.0, 4.0]);
            s.avatar_on_top = true;
            s.last_model = Some("old".into());
        })
        .unwrap();
        let ui = Settings { last_model: Some("new".into()), stt_idle_secs: 9, ollama_path: None, ..Settings::default() };
        update_at(&f, |s| from_ui(s, ui)).unwrap();
        let s = load_from(&f);
        assert_eq!(s.ollama_path.as_deref(), Some("C:/ollama.exe"));
        assert_eq!(s.tts_model_dir.as_deref(), Some("D:/tts"));
        assert_eq!(s.display_names.get("m").map(String::as_str), Some("Name"));
        assert_eq!(s.avatar_bounds, Some([1.0, 2.0, 3.0, 4.0]));
        assert!(s.avatar_on_top);
        assert_eq!((s.last_model.as_deref(), s.stt_idle_secs), (Some("new"), 9));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn write_atomic_leaves_no_tmp() {
        let d = dir("atomic");
        let f = d.join("x.json");
        write_atomic(&f, b"1").unwrap();
        write_atomic(&f, b"22").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"22");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
