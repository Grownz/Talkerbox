//! Short, human-friendly display names for Ollama models. The Ollama id itself never changes.

const MAX: usize = 50;

/// Cuts to at most `MAX` characters, ending with an ellipsis when shortened.
pub fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX - 1).collect();
    out.push('…');
    out
}

fn strip_gguf_suffix(repo: &str) -> &str {
    for suffix in ["-gguf", "_gguf", ".gguf"] {
        let cut = repo.len().saturating_sub(suffix.len());
        if cut > 0 && repo.get(cut..).is_some_and(|t| t.eq_ignore_ascii_case(suffix)) {
            return &repo[..cut];
        }
    }
    repo
}

/// Quantization tag in a GGUF file name, e.g. `Llama-3.2-3B-Instruct-Q4_K_M.gguf` -> `Q4_K_M`.
pub fn quant_from_file(file: &str) -> Option<String> {
    let stem = file.strip_suffix(".gguf").or_else(|| file.strip_suffix(".GGUF")).unwrap_or(file);
    stem.rsplit(['-', '.']).find_map(|t| {
        let u = t.to_ascii_uppercase();
        let is_quant = matches!(u.as_str(), "F16" | "BF16" | "F32")
            || ((u.starts_with('Q') || u.starts_with("IQ")) && u.trim_start_matches('I')[1..].starts_with(|c: char| c.is_ascii_digit()));
        is_quant.then_some(u)
    })
}

/// Clean name for a HuggingFace repo id (`owner/Repo-GGUF`) plus an optional quant tag.
pub fn from_hf_repo(repo_id: &str, quant: Option<&str>) -> String {
    let repo = repo_id.rsplit('/').next().unwrap_or(repo_id);
    let name = strip_gguf_suffix(repo);
    match quant {
        Some(q) if !q.is_empty() && !q.eq_ignore_ascii_case("latest") => truncate(&format!("{name} {q}")),
        _ => truncate(name),
    }
}

/// `owner/repo` for huggingface.co / hf.co URLs.
pub fn hf_repo_from_url(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?.trim_start_matches("www.");
    if host != "huggingface.co" && host != "hf.co" {
        return None;
    }
    let mut seg = url.path_segments()?.filter(|s| !s.is_empty());
    Some(format!("{}/{}", seg.next()?, seg.next()?))
}

/// Display name for a model imported from a direct file URL.
pub fn for_import(hf_repo: Option<&str>, file: &str) -> String {
    match hf_repo {
        Some(r) => from_hf_repo(r, quant_from_file(file).as_deref()),
        None => {
            let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
            truncate(stem)
        }
    }
}

/// Display name derived from the Ollama id alone (used when no stored name exists).
pub fn from_id(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    if lower.starts_with("hf.co/") || lower.starts_with("huggingface.co/") {
        let path = id.split_once('/').map_or(id, |(_, p)| p);
        let (repo, tag) = path.split_once(':').map_or((path, None), |(r, t)| (r, Some(t)));
        return from_hf_repo(repo, tag);
    }
    truncate(id.strip_suffix(":latest").unwrap_or(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hf_ids_are_shortened() {
        assert_eq!(from_id("hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"), "Llama-3.2-3B-Instruct Q4_K_M");
        assert_eq!(from_id("hf.co/unsloth/Qwen3-4B-GGUF:latest"), "Qwen3-4B");
        assert_eq!(from_id("hf.co/user/model_gguf"), "model");
    }

    #[test]
    fn plain_ids_drop_latest_only() {
        assert_eq!(from_id("qwen2.5:0.5b"), "qwen2.5:0.5b");
        assert_eq!(from_id("mymodel:latest"), "mymodel");
    }

    #[test]
    fn quant_detection() {
        assert_eq!(quant_from_file("Llama-3.2-3B-Instruct-Q4_K_M.gguf").as_deref(), Some("Q4_K_M"));
        assert_eq!(quant_from_file("mistral-7b.IQ3_XS.gguf").as_deref(), Some("IQ3_XS"));
        assert_eq!(quant_from_file("phi-3-mini-f16.gguf").as_deref(), Some("F16"));
        assert_eq!(quant_from_file("model-v2.gguf"), None);
        assert_eq!(quant_from_file("Qwen-7B.gguf"), None);
    }

    #[test]
    fn import_names() {
        assert_eq!(for_import(Some("TheBloke/Mistral-7B-Instruct-v0.2-GGUF"), "mistral-7b-instruct-v0.2.Q5_K_M.gguf"), "Mistral-7B-Instruct-v0.2 Q5_K_M");
        let long = format!("{}.gguf", "a".repeat(80));
        let n = for_import(None, &long);
        assert_eq!(n.chars().count(), 50);
        assert!(n.ends_with('…') && !n.contains(".gguf"));
        assert_eq!(for_import(None, "tiny.gguf"), "tiny");
    }

    #[test]
    fn hf_repo_extraction() {
        let u = reqwest::Url::parse("https://huggingface.co/owner/Repo-GGUF/resolve/main/x.gguf?download=true").unwrap();
        assert_eq!(hf_repo_from_url(&u).as_deref(), Some("owner/Repo-GGUF"));
        assert_eq!(hf_repo_from_url(&reqwest::Url::parse("https://example.com/a/b/x.gguf").unwrap()), None);
    }
}
