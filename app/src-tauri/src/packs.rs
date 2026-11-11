//! Kokoro language packs: one subfolder per pack in `tts/packs`, described by `pack.json`
//! (contract shared with the TTS sidecar's `--packs-dir`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MANIFEST: &str = "pack.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Pack {
    pub id: String,
    pub name: String,
    /// espeak-ng language code, e.g. `de`.
    pub language: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocab: Option<String>,
    #[serde(default)]
    pub voices: Vec<String>,
}

/// Lowercase ASCII slug of a pack name (`German (Martin)` -> `german-martin`).
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    let s = s.trim_end_matches('-').chars().take(48).collect::<String>();
    if s.is_empty() {
        "pack".into()
    } else {
        s
    }
}

/// Slug that does not collide with an existing id (`name`, `name-2`, `name-3`, ...).
pub fn unique_id(name: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = slug(name);
    if !taken(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|c| !taken(c)).unwrap()
}

/// Valid espeak-ng style code: letters, digits and '-' only.
pub fn valid_language(code: &str) -> bool {
    !code.is_empty() && code.len() <= 16 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Installed packs (folders with a readable manifest), sorted by name.
pub fn list(dir: &Path) -> Vec<(PathBuf, Pack)> {
    let mut v: Vec<(PathBuf, Pack)> = std::fs::read_dir(dir)
        .map(|r| {
            r.filter_map(Result::ok)
                .map(|e| e.path())
                .filter_map(|p| {
                    let pack = serde_json::from_slice(&std::fs::read(p.join(MANIFEST)).ok()?).ok()?;
                    Some((p, pack))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    v
}

/// Packs folder for the sidecar, only when at least one pack is installed.
pub fn dir_arg(dir: &Path) -> Option<&Path> {
    (!list(dir).is_empty()).then_some(dir)
}

pub fn write_manifest(folder: &Path, pack: &Pack) -> Result<(), String> {
    let tmp = folder.join("pack.json.tmp");
    let bytes = serde_json::to_vec_pretty(pack).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, folder.join(MANIFEST)).map_err(|e| e.to_string())
}

/// Language codes from HuggingFace repo tags (2-3 letter tags such as `de`, `ko`).
pub fn languages_from_tags(tags: &[String]) -> Vec<String> {
    tags.iter()
        .map(|t| t.strip_prefix("language:").unwrap_or(t))
        .filter(|t| (2..=3).contains(&t.len()) && t.chars().all(|c| c.is_ascii_lowercase()))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slug("German (Martin)"), "german-martin");
        assert_eq!(slug("  Ünïcode  Pack!! "), "n-code-pack");
        assert_eq!(slug("???"), "pack");
    }

    #[test]
    fn ids_avoid_collisions() {
        let taken = ["german", "german-2"];
        assert_eq!(unique_id("German", |c| taken.contains(&c)), "german-3");
        assert_eq!(unique_id("Polish", |c| taken.contains(&c)), "polish");
    }

    #[test]
    fn languages() {
        assert!(valid_language("de") && valid_language("pt-br") && valid_language("cmn"));
        assert!(!valid_language("") && !valid_language("de/../x"));
        let tags: Vec<String> = ["text-to-speech", "de", "license:apache-2.0", "onnx", "language:ko", "kokoro"].map(String::from).into();
        assert_eq!(languages_from_tags(&tags), vec!["de", "ko"]);
    }

    #[test]
    fn manifest_roundtrip() {
        let p = Pack { id: "de".into(), name: "German".into(), language: "de".into(), model: "model.onnx".into(), vocab: None, voices: vec!["m.npy".into()] };
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("vocab"));
        assert_eq!(serde_json::from_str::<Pack>(&json).unwrap(), p);
    }
}
