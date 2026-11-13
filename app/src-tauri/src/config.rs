//! Settings persisted as JSON in the Tauri app config dir.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub ollama_path: Option<String>,
    pub last_model: Option<String>,
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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama_path: None,
            last_model: None,
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
        }
    }
}

// Serialises load-modify-save cycles from different commands.
static LOCK: Mutex<()> = Mutex::new(());

/// Applies `f` to the stored settings and saves them.
pub fn update<R>(app: &AppHandle, f: impl FnOnce(&mut Settings) -> R) -> Result<R, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = load(app);
    let r = f(&mut s);
    save(app, &s)?;
    Ok(r)
}

/// Saves settings coming from the UI. Fields owned by backend commands keep their stored values.
pub fn save_from_ui(app: &AppHandle, ui: Settings) -> Result<(), String> {
    update(app, |s| {
        *s = Settings {
            ollama_path: s.ollama_path.take(),
            tts_model_dir: s.tts_model_dir.take(),
            display_names: std::mem::take(&mut s.display_names),
            avatar_bounds: s.avatar_bounds.take(),
            ..ui
        }
    })
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("No config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    // A missing or corrupt file falls back to defaults rather than blocking startup.
    file(app).ok().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let f = file(app)?;
    write_atomic(&f, &serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?)
}

/// Writes `bytes` to a temp file next to `f`, then renames it over `f`, so readers never see half a file.
pub fn write_atomic(f: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    let mut tmp = f.as_os_str().to_owned();
    tmp.push(".tmp");
    let err = |e: std::io::Error| format!("Cannot write {}: {e}", f.display());
    std::fs::write(&tmp, bytes).map_err(err)?;
    std::fs::rename(&tmp, f).map_err(err)
}
