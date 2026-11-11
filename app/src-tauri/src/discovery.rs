//! Locating ollama.exe on disk. Pure logic, the filesystem check is injected for tests.

use std::path::{Path, PathBuf};

const EXE: &str = "ollama.exe";

/// Turns a user-supplied folder or exe path into the exe path it designates.
/// Returns None when the input cannot be an ollama.exe (wrong file name).
pub fn exe_from_user_path(input: &Path, is_dir: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    if is_dir(input) {
        return Some(input.join(EXE));
    }
    let name = input.file_name()?.to_str()?;
    name.eq_ignore_ascii_case(EXE).then(|| input.to_path_buf())
}

/// Candidate exe paths in priority order: saved path, PATH entries, per-user install, machine install.
pub fn candidates(
    saved: Option<&Path>,
    path_env: Option<&std::ffi::OsStr>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
    is_dir: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = saved.and_then(|s| exe_from_user_path(s, &is_dir)) {
        out.push(p);
    }
    if let Some(env) = path_env {
        out.extend(std::env::split_paths(env).filter(|d| !d.as_os_str().is_empty()).map(|d| d.join(EXE)));
    }
    if let Some(l) = local_app_data {
        out.push(l.join("Programs").join("Ollama").join(EXE));
    }
    out.push(program_files.map_or_else(|| PathBuf::from(r"C:\Program Files"), Path::to_path_buf).join("Ollama").join(EXE));
    out
}

/// First candidate that exists as a file.
pub fn find(candidates: Vec<PathBuf>, is_file: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.into_iter().find(|p| is_file(p))
}

/// Real-system discovery using the process environment.
pub fn find_on_system(saved: Option<&Path>) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH");
    let lad = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let pf = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let c = candidates(saved, path_env.as_deref(), lad.as_deref(), pf.as_deref(), |p| p.is_dir());
    find(c, |p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn no_dirs(_: &Path) -> bool {
        false
    }

    #[test]
    fn order_is_saved_path_lad_programfiles() {
        let path_env = std::env::join_paths([r"C:\a", r"C:\b"]).unwrap();
        let c = candidates(
            Some(Path::new(r"D:\tools\ollama.exe")),
            Some(&path_env),
            Some(Path::new(r"C:\Users\u\AppData\Local")),
            Some(Path::new(r"C:\Program Files")),
            no_dirs,
        );
        let expected: Vec<PathBuf> = [
            r"D:\tools\ollama.exe",
            r"C:\a\ollama.exe",
            r"C:\b\ollama.exe",
            r"C:\Users\u\AppData\Local\Programs\Ollama\ollama.exe",
            r"C:\Program Files\Ollama\ollama.exe",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(c, expected);
    }

    #[test]
    fn saved_folder_resolves_to_exe_and_bad_saved_is_skipped() {
        let c = candidates(Some(Path::new(r"D:\ollama")), None, None, None, |p| p == Path::new(r"D:\ollama"));
        assert_eq!(c[0], PathBuf::from(r"D:\ollama\ollama.exe"));
        let c = candidates(Some(Path::new(r"D:\evil.exe")), None, None, None, no_dirs);
        assert_eq!(c, vec![PathBuf::from(r"C:\Program Files\Ollama\ollama.exe")]);
    }

    #[test]
    fn find_takes_first_existing() {
        let path_env: OsString = std::env::join_paths([r"C:\a", r"C:\b"]).unwrap();
        let c = candidates(None, Some(&path_env), Some(Path::new(r"C:\L")), None, no_dirs);
        let hit = find(c, |p| p == Path::new(r"C:\b\ollama.exe") || p == Path::new(r"C:\L\Programs\Ollama\ollama.exe"));
        assert_eq!(hit, Some(PathBuf::from(r"C:\b\ollama.exe")));
    }

    #[test]
    fn user_path_validation() {
        assert_eq!(exe_from_user_path(Path::new(r"X:\OLLAMA.EXE"), no_dirs), Some(PathBuf::from(r"X:\OLLAMA.EXE")));
        assert_eq!(exe_from_user_path(Path::new(r"X:\notepad.exe"), no_dirs), None);
    }
}
