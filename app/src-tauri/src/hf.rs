//! Normalising user input into a model name that `POST /api/pull` accepts.

fn valid_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// Accepts a HuggingFace URL, `hf.co/user/repo[:quant]`, `huggingface.co/...`,
/// a copied `ollama run hf.co/...` command, or a plain Ollama model name.
/// Returns `hf.co/user/repo[:quant]` for HuggingFace input, the trimmed name otherwise.
pub fn pull_target(input: &str) -> Result<String, String> {
    let mut s = input.trim();
    for prefix in ["ollama run ", "ollama pull "] {
        if s.get(..prefix.len()).is_some_and(|h| h.eq_ignore_ascii_case(prefix)) {
            s = s[prefix.len()..].trim();
        }
    }
    let lower = s.to_ascii_lowercase();
    let mut rest = lower.as_str();
    let mut offset = 0;
    for p in ["https://", "http://"] {
        if let Some(r) = rest.strip_prefix(p) {
            rest = r;
            offset += p.len();
        }
    }
    if let Some(r) = rest.strip_prefix("www.") {
        rest = r;
        offset += 4;
    }
    let host = ["hf.co/", "huggingface.co/"].into_iter().find(|h| rest.starts_with(h));
    let Some(host) = host else {
        // Plain Ollama names like `llama3.2:3b` or `library/qwen3`.
        if !s.is_empty() && !s.contains("://") && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/".contains(c)) {
            return Ok(s.to_string());
        }
        return Err("Not a HuggingFace link or Ollama model name. For a direct .gguf URL use \"Import GGUF from URL\".".into());
    };
    // Keep the original case of user/repo (HF repo names are case-preserving).
    let path = &s[offset + host.len()..];
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    let user = parts.next().ok_or("Missing HuggingFace user in link")?;
    let repo_and_tag = parts.next().ok_or("Missing HuggingFace repository in link")?;
    let (repo, quant) = match repo_and_tag.split_once(':') {
        Some((r, q)) => (r, Some(q)),
        None => (repo_and_tag, None),
    };
    if !valid_segment(user) || !valid_segment(repo) {
        return Err(format!("Invalid HuggingFace repository '{user}/{repo}'"));
    }
    match quant {
        Some(q) if !valid_segment(q) => Err(format!("Invalid quantization tag '{q}'")),
        Some(q) => Ok(format!("hf.co/{user}/{repo}:{q}")),
        None => Ok(format!("hf.co/{user}/{repo}")),
    }
}

#[cfg(test)]
mod tests {
    use super::pull_target;

    #[test]
    fn normalises_hf_variants() {
        let cases = [
            ("https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF", "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF"),
            ("https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/tree/main", "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF"),
            ("https://huggingface.co/u/r/blob/main/x.gguf?download=true", "hf.co/u/r"),
            ("http://www.huggingface.co/u/r/", "hf.co/u/r"),
            ("https://hf.co/u/r#readme", "hf.co/u/r"),
            ("huggingface.co/u/r:Q4_K_M", "hf.co/u/r:Q4_K_M"),
            ("  hf.co/u/r:IQ3_M  ", "hf.co/u/r:IQ3_M"),
            ("HF.CO/User/Repo", "hf.co/User/Repo"),
            ("ollama run hf.co/u/r:Q8_0", "hf.co/u/r:Q8_0"),
        ];
        for (input, want) in cases {
            assert_eq!(pull_target(input).as_deref(), Ok(want), "input: {input}");
        }
    }

    #[test]
    fn passes_plain_ollama_names() {
        assert_eq!(pull_target("llama3.2:3b").as_deref(), Ok("llama3.2:3b"));
    }

    #[test]
    fn rejects_bad_input() {
        for bad in ["", "https://huggingface.co/", "https://huggingface.co/u", "hf.co/u/r:bad tag", "hf.co/../r", "https://example.com/x.gguf"] {
            assert!(pull_target(bad).is_err(), "should reject: {bad}");
        }
    }
}
