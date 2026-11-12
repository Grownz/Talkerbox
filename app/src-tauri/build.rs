fn main() {
    // Re-copy the externalBin sidecar into target/ when it is replaced.
    println!("cargo:rerun-if-changed=binaries");
    println!("cargo:rerun-if-changed=vosk");
    // Vosk (speech input): link against the import library in vosk/ (made by vosk/setup.ps1). The DLL is
    // delay-loaded, so the app and test binaries start without it; stt.rs checks for it before first use.
    let vosk = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vosk");
    println!("cargo:rustc-link-search=native={}", vosk.display());
    println!("cargo:rustc-link-arg=/DELAYLOAD:libvosk.dll");
    println!("cargo:rustc-link-lib=delayimp");
    // Dev runs load the DLLs from next to the exe (target/<profile>); release bundles them as resources.
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    if let Some(profile_dir) = out.ancestors().nth(3) {
        for e in std::fs::read_dir(&vosk).into_iter().flatten().flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "dll") {
                let _ = std::fs::copy(&p, profile_dir.join(e.file_name()));
            }
        }
    }
    tauri_build::build()
}
