//! Settings persisted as JSON in the Tauri app config dir.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub ollama_path: Option<String>,
    pub last_model: Option<String>,
    pub voice: Option<String>,
    pub tts_enabled: bool,
    pub tts_speed: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { ollama_path: None, last_model: None, voice: None, tts_enabled: true, tts_speed: 1.0 }
    }
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("No config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    // A missing or corrupt file falls back to defaults rather than blocking startup.
    file(app).ok().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let f = file(app)?;
    write_atomic(&f, &serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?)
}

fn write_atomic(f: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Cannot write settings: {e}"))?;
    std::fs::rename(&tmp, f).map_err(|e| format!("Cannot write settings: {e}"))
}
