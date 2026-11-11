fn main() {
    // Re-copy the externalBin sidecar into target/ when it is replaced.
    println!("cargo:rerun-if-changed=binaries");
    tauri_build::build()
}
