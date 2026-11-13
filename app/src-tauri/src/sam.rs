//! Smart select for the mask editor: MobileSAM (image encoder + single-mask decoder, ONNX) on the CPU provider of
//! ONNX Runtime through the `ort` crate. Neither the runtime nor the model is bundled: `sam_download` fetches them on
//! demand into `sam\` of the app data dir (sizes and SHA-256 pinned below), and `onnxruntime.dll` is loaded from there
//! at runtime (`ort` feature `load-dynamic`), so the installer does not grow and nothing is linked at build time.

use ort::environment::Environment;
use ort::session::Session;
use std::sync::Mutex;
use ort::value::{Tensor, TensorRef};
use std::io::Read;
use std::path::Path;
use std::time::Instant;

/// A pinned download: the file must have exactly this size and SHA-256.
pub struct Asset {
    pub url: &'static str,
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// ONNX Runtime 1.31.1 (MIT). The Python wheel is a zip of 14.9 MB holding the same C API `onnxruntime.dll` as the
/// 83 MB GitHub release zip (which also carries debug symbols); only the DLL is unpacked from it.
pub const RUNTIME_WHEEL: Asset = Asset {
    url: "https://files.pythonhosted.org/packages/45/b2/793b4051d8dc6acb379ead9b72050f0ffa283ca49a6904add2e218b83e2e/onnxruntime-1.31.1-cp312-cp312-win_amd64.whl",
    file: "onnxruntime.whl",
    size: 14_888_466,
    sha256: "ae8a9a351efda685cc59a66226cdefaa37a126c1d66872ca23a2de9425326130",
};
const RUNTIME_ENTRY: &str = "onnxruntime/capi/onnxruntime.dll";
pub const RUNTIME_DLL: &str = "onnxruntime.dll";
const MAX_DLL_BYTES: u64 = 64 * 1024 * 1024;

/// MobileSAM (Apache-2.0) as ONNX from huggingface.co/Acly/MobileSAM, pinned to one commit. The encoder takes an
/// RGB image (H x W x 3, 0..255, long side 1024) and normalises and pads it itself.
pub const ENCODER: Asset = Asset {
    url: "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/mobile_sam_image_encoder.onnx",
    file: "mobile_sam_image_encoder.onnx",
    size: 28_157_093,
    sha256: "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749",
};
pub const DECODER: Asset = Asset {
    url: "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/sam_mask_decoder_single.onnx",
    file: "sam_mask_decoder_single.onnx",
    size: 16_501_323,
    sha256: "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d",
};

/// Long side of the image the encoder gets.
pub const LONG_SIDE: u32 = 1024;
const MAX_POINTS: usize = 64;
const EMBED_LEN: usize = 256 * 64 * 64;

/// Runtime and both models are in place (sizes are checked; hashes were checked when they were downloaded).
pub fn installed(dir: &Path) -> bool {
    let size = |f: &str| std::fs::metadata(dir.join(f)).map(|m| m.len()).ok();
    dir.join(RUNTIME_DLL).is_file() && size(ENCODER.file) == Some(ENCODER.size) && size(DECODER.file) == Some(DECODER.size)
}

/// Bytes of everything in the smart select folder (models, runtime, partial downloads).
pub fn disk_size(dir: &Path) -> u64 {
    let files = std::fs::read_dir(dir).into_iter().flatten().flatten();
    files.filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}

/// Deletes copies of the runtime that were renamed away while loaded (see `remove`) and are no longer in use.
pub fn clean_stale(dir: &Path) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().ends_with(".old") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Deletes every downloaded smart select file. Call it with no `Sam` loaded. Once `onnxruntime.dll` has been loaded it
/// stays mapped until the process ends (`ort` never unloads it) and Windows refuses to delete it, but renaming a
/// loaded DLL is allowed: it is renamed to `*.old`, which no longer counts as installed and is deleted by
/// `clean_stale` on a later start or download.
pub fn remove(dir: &Path) -> Result<(), String> {
    clean_stale(dir);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if !p.is_file() || std::fs::remove_file(&p).is_ok() {
            continue;
        }
        let old = (0..100).map(|i| dir.join(format!("{}.{i}.old", e.file_name().to_string_lossy()))).find(|o| !o.exists());
        if let Some(o) = old.filter(|o| std::fs::rename(&p, o).is_ok()) {
            let _ = std::fs::remove_file(o);
        } else {
            return Err(format!("Cannot delete {}; close the mask editor and try again", p.display()));
        }
    }
    let _ = std::fs::remove_dir(dir); // only succeeds once nothing is left
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = sha2::Sha256::new();
    std::io::copy(&mut f, &mut h).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(format!("{:x}", h.finalize()))
}

/// Checks a downloaded file against its pinned size and hash; a bad file is deleted so the next try starts over.
pub fn verify(path: &Path, a: &Asset) -> Result<(), String> {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let r = if size != a.size {
        Err(format!("{}: got {size} bytes, expected {}", a.file, a.size))
    } else if sha256_file(path)? != a.sha256 {
        Err(format!("{}: checksum mismatch", a.file))
    } else {
        Ok(())
    };
    if r.is_err() {
        let _ = std::fs::remove_file(path);
    }
    r
}

/// Unpacks `onnxruntime.dll` from the runtime wheel into `dir` (via a temp file, at most 64 MB).
pub fn extract_runtime(wheel: &Path, dir: &Path) -> Result<(), String> {
    let f = std::fs::File::open(wheel).map_err(|e| format!("{}: {e}", wheel.display()))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("Invalid runtime archive: {e}"))?;
    let mut e = z.by_name(RUNTIME_ENTRY).map_err(|_| format!("The runtime archive has no {RUNTIME_ENTRY}"))?;
    let tmp = dir.join(format!("{RUNTIME_DLL}.tmp"));
    let io = |e: std::io::Error| format!("{}: {e}", tmp.display());
    let mut w = std::fs::File::create(&tmp).map_err(io)?;
    let n = std::io::copy(&mut (&mut e).take(MAX_DLL_BYTES + 1), &mut w).map_err(io)?;
    drop(w);
    if n > MAX_DLL_BYTES {
        let _ = std::fs::remove_file(&tmp);
        return Err("The runtime DLL is larger than expected".into());
    }
    std::fs::rename(&tmp, dir.join(RUNTIME_DLL)).map_err(io)
}

// ---------- pure pre- and post-processing ----------

/// RGBA bytes (w * h * 4, as a canvas gives them) -> RGB floats 0..255 in H x W x 3 order for the encoder.
pub fn rgba_to_rgb(rgba: &[u8], w: usize, h: usize) -> Result<Vec<f32>, String> {
    if w == 0 || h == 0 || w.max(h) > LONG_SIDE as usize || rgba.len() != w * h * 4 {
        return Err(format!("Invalid image for smart select: {w} x {h}, {} bytes", rgba.len()));
    }
    Ok(rgba.as_chunks::<4>().0.iter().flat_map(|p| [f32::from(p[0]), f32::from(p[1]), f32::from(p[2])]).collect())
}

/// Decoder logits -> mask bytes (1 = inside).
pub fn threshold(logits: &[f32]) -> Vec<u8> {
    logits.iter().map(|&v| u8::from(v > 0.0)).collect()
}

/// Prompt checks: points (encoder pixels) and labels of equal length, 1..=64, labels -1 (padding), 0 (background),
/// 1 (figure), 2/3 (box corners), every point finite.
pub fn check_prompt(points: &[[f32; 2]], labels: &[f32]) -> Result<(), String> {
    if points.is_empty() || points.len() > MAX_POINTS || points.len() != labels.len() {
        return Err("Invalid smart select prompt".into());
    }
    if points.iter().flatten().any(|v| !v.is_finite() || v.abs() > 4.0 * LONG_SIDE as f32) || labels.iter().any(|l| ![-1.0, 0.0, 1.0, 2.0, 3.0].contains(l)) {
        return Err("Invalid smart select prompt".into());
    }
    Ok(())
}

// ---------- inference ----------

fn ort_err(e: impl std::fmt::Display) -> String {
    format!("Smart select: {e}")
}

pub struct Sam {
    encoder: Session,
    decoder: Session,
    /// Embedding of the last encoded image and its key (image id and size): encoding runs once per image.
    embedding: Option<(String, Vec<f32>)>,
}

/// The process-wide ONNX Runtime environment. `ort` allows only one per process, ever: its registry is set on the
/// first `build()` and never cleared, so even after that environment was dropped a second `build()` fails ("only one
/// environment is allowed per process"). It is therefore created once and kept; only the sessions come and go.
/// The DLL itself also stays loaded for the rest of the process (`ort` never unloads it).
static ENV: Mutex<Option<Environment>> = Mutex::new(None);

fn environment(dir: &Path) -> Result<Environment, String> {
    let mut env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = env.as_ref() {
        return Ok(e.clone());
    }
    let e = ort::init_from(dir.join(RUNTIME_DLL))
        .map_err(|e| {
            format!(
                "Cannot load the smart select runtime ({e}). If a DLL is missing, install the Microsoft Visual C++ \
                 Redistributable (x64); otherwise download the smart select files again."
            )
        })?
        .with_name("talkerbox")
        .build()
        .map_err(ort_err)?;
    *env = Some(e.clone());
    Ok(e)
}

impl Sam {
    /// Loads both models from `dir` (and on first use in this process `onnxruntime.dll`). Dropping a `Sam` frees the
    /// sessions and the cached embedding; a later `load` works again.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let env = environment(dir)?;
        let open = |a: &Asset| Session::builder(&env).and_then(|mut b| b.commit_from_file(dir.join(a.file))).map_err(ort_err);
        Ok(Self { encoder: open(&ENCODER)?, decoder: open(&DECODER)?, embedding: None })
    }

    /// Encodes the image (RGBA, long side at most 1024) unless `key` is the one encoded last. Returns the encoder
    /// time in ms (0 when cached).
    pub fn encode(&mut self, key: &str, rgba: &[u8], w: usize, h: usize) -> Result<f64, String> {
        if self.embedding.as_ref().is_some_and(|(k, _)| k == key) {
            return Ok(0.0);
        }
        let img = Tensor::from_array(([h, w, 3], rgba_to_rgb(rgba, w, h)?)).map_err(ort_err)?;
        let t = Instant::now();
        let out = self.encoder.run(ort::inputs!["input_image" => img]).map_err(ort_err)?;
        let (_, e) = out["image_embeddings"].try_extract_tensor::<f32>().map_err(ort_err)?;
        if e.len() != EMBED_LEN {
            return Err(format!("Smart select: unexpected embedding size {}", e.len()));
        }
        let emb = e.to_vec();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        drop(out);
        self.embedding = Some((key.to_string(), emb));
        Ok(ms)
    }

    /// Mask (out_w * out_h bytes, 1 = inside) for the prompt on the last encoded image. `out_w` x `out_h` must have
    /// the aspect ratio of that image; points are in the pixels of the encoded image.
    pub fn decode(&mut self, points: &[[f32; 2]], labels: &[f32], out_w: usize, out_h: usize) -> Result<Vec<u8>, String> {
        check_prompt(points, labels)?;
        if out_w == 0 || out_h == 0 || out_w.max(out_h) > 4096 {
            return Err("Invalid smart select mask size".into());
        }
        let (_, emb) = self.embedding.as_ref().ok_or("Smart select: no image encoded yet")?;
        let n = points.len();
        let coords: Vec<f32> = points.iter().flatten().copied().collect();
        let out = self
            .decoder
            .run(ort::inputs![
                "image_embeddings" => TensorRef::from_array_view(([1usize, 256, 64, 64], emb.as_slice())).map_err(ort_err)?,
                "point_coords" => Tensor::from_array(([1usize, n, 2], coords)).map_err(ort_err)?,
                "point_labels" => Tensor::from_array(([1usize, n], labels.to_vec())).map_err(ort_err)?,
                "mask_input" => Tensor::from_array(([1usize, 1, 256, 256], vec![0f32; 256 * 256])).map_err(ort_err)?,
                "has_mask_input" => Tensor::from_array(([1usize], vec![0f32])).map_err(ort_err)?,
                "orig_im_size" => Tensor::from_array(([2usize], vec![out_h as f32, out_w as f32])).map_err(ort_err)?,
            ])
            .map_err(ort_err)?;
        let (_, m) = out["masks"].try_extract_tensor::<f32>().map_err(ort_err)?;
        if m.len() != out_w * out_h {
            return Err(format!("Smart select: unexpected mask size {}", m.len()));
        }
        Ok(threshold(m))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_is_converted_and_checked() {
        let px = [10u8, 20, 30, 255, 40, 50, 60, 0];
        assert_eq!(rgba_to_rgb(&px, 2, 1).unwrap(), vec![10.0, 20.0, 30.0, 40.0, 50.0, 60.0]);
        assert!(rgba_to_rgb(&px, 1, 1).is_err(), "length must match");
        assert!(rgba_to_rgb(&[], 0, 0).is_err());
        assert!(rgba_to_rgb(&vec![0; 1025 * 4], 1025, 1).is_err(), "long side over 1024");
    }

    #[test]
    fn logits_threshold_at_zero() {
        assert_eq!(threshold(&[-3.0, 0.0, 0.01, 5.0, f32::NAN]), vec![0, 0, 1, 1, 0]);
    }

    #[test]
    fn prompts_are_validated() {
        assert!(check_prompt(&[[10.0, 20.0], [0.0, 0.0]], &[1.0, -1.0]).is_ok());
        assert!(check_prompt(&[[1.0, 2.0], [30.0, 40.0]], &[2.0, 3.0]).is_ok());
        assert!(check_prompt(&[], &[]).is_err());
        assert!(check_prompt(&[[1.0, 2.0]], &[1.0, 0.0]).is_err());
        assert!(check_prompt(&[[f32::NAN, 2.0]], &[1.0]).is_err());
        assert!(check_prompt(&[[1.0, 2.0]], &[4.0]).is_err());
        assert!(check_prompt(&vec![[1.0, 1.0]; 65], &[1.0; 65]).is_err());
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("talkerbox-sam-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn verify_checks_size_and_hash_and_drops_bad_files() {
        let d = temp("verify");
        let f = d.join("a.bin");
        std::fs::write(&f, b"abc").unwrap();
        let ok = Asset { url: "", file: "a.bin", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
        assert!(verify(&f, &ok).is_ok());
        assert!(verify(&f, &Asset { size: 4, ..ok }).unwrap_err().contains("expected 4"));
        assert!(!f.exists(), "a bad file is deleted");
        std::fs::write(&f, b"abd").unwrap();
        assert!(verify(&f, &Asset { size: 3, ..ok }).unwrap_err().contains("checksum"));
        assert!(!installed(&d));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn runtime_is_extracted_from_the_wheel() {
        use std::io::Write;
        let d = temp("wheel");
        let whl = d.join("x.whl");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&whl).unwrap());
        let opt = zip::write::SimpleFileOptions::default();
        w.start_file("onnxruntime/__init__.py", opt).unwrap();
        w.start_file(RUNTIME_ENTRY, opt).unwrap();
        w.write_all(b"MZdll").unwrap();
        w.finish().unwrap();
        extract_runtime(&whl, &d).unwrap();
        assert_eq!(std::fs::read(d.join(RUNTIME_DLL)).unwrap(), b"MZdll");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&whl).unwrap());
        w.start_file("other.dll", opt).unwrap();
        w.finish().unwrap();
        assert!(extract_runtime(&whl, &d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Real run with the downloaded files (`sam\` of the app data dir, or any folder with the three files):
    /// `TALKERBOX_SAM_DIR=<dir> cargo test --release sam_real -- --ignored --nocapture`. The files are copied to a temp
    /// folder first. Three editor sessions (load, encode, clicks, release) on three different synthetic images (a red
    /// disc on a gradient, moved each time) must each select their disc; then `remove` deletes the copy while the DLL
    /// is still loaded.
    #[test]
    #[ignore]
    fn sam_real() {
        let src = std::path::PathBuf::from(std::env::var("TALKERBOX_SAM_DIR").unwrap());
        let dir = temp("real");
        for f in [RUNTIME_DLL, ENCODER.file, DECODER.file] {
            std::fs::copy(src.join(f), dir.join(f)).unwrap();
        }
        let (w, h, ow, oh) = (1024usize, 768usize, 512usize, 384usize);
        for (round, cx) in [300.0, 450.0, 600.0].into_iter().enumerate() {
            let disc = |x: usize, y: usize| (x as f64 - cx).powi(2) + (y as f64 - 380.0).powi(2) < 180f64.powi(2);
            let mut rgba = Vec::with_capacity(w * h * 4);
            for y in 0..h {
                for x in 0..w {
                    let p = if disc(x, y) { [220, 40, 40] } else { [(60 + x * 120 / w) as u8, (60 + y * 120 / h) as u8, 150] };
                    rgba.extend_from_slice(&[p[0], p[1], p[2], 255]);
                }
            }
            let t = Instant::now();
            let mut sam = Sam::load(&dir).unwrap();
            let load = t.elapsed().as_secs_f64() * 1000.0;
            let enc = sam.encode(&format!("img{round}"), &rgba, w, h).unwrap();
            assert_eq!(sam.encode(&format!("img{round}"), &rgba, w, h).unwrap(), 0.0, "cached");
            let mut mask = Vec::new();
            let mut dec = 0.0;
            for _ in 0..5 {
                let t = Instant::now();
                mask = sam.decode(&[[cx as f32, 380.0], [0.0, 0.0]], &[1.0, -1.0], ow, oh).unwrap();
                dec = t.elapsed().as_secs_f64() * 1000.0;
            }
            drop(sam); // what sam_release does
            let (mut inter, mut union) = (0, 0);
            for y in 0..oh {
                for x in 0..ow {
                    let (a, b) = (mask[y * ow + x] == 1, disc(x * 2, y * 2));
                    inter += usize::from(a && b);
                    union += usize::from(a || b);
                }
            }
            let iou = inter as f64 / union as f64;
            println!("session {round}: load {load:.0} ms, encode {enc:.0} ms, decode {dec:.1} ms, IoU {iou:.3}");
            assert!(iou > 0.9);
        }
        assert!(installed(&dir));
        remove(&dir).unwrap();
        assert!(!installed(&dir) && !dir.join(RUNTIME_DLL).exists() && !dir.join(ENCODER.file).exists());
        // Only a renamed, still loaded runtime may be left; it goes on the next start.
        let left: Vec<_> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.file_name()).collect();
        println!("left after remove: {left:?}");
        assert!(left.iter().all(|n| n.to_string_lossy().ends_with(".old")));
    }

    #[test]
    fn remove_deletes_everything_and_size_counts_files() {
        let d = temp("remove");
        std::fs::write(d.join(ENCODER.file), [0u8; 10]).unwrap();
        std::fs::write(d.join("x.onnx.abc.part"), [0u8; 5]).unwrap();
        std::fs::write(d.join("onnxruntime.dll.0.old"), [0u8; 1]).unwrap();
        assert_eq!(disk_size(&d), 16);
        remove(&d).unwrap();
        assert!(!d.exists(), "the empty folder is removed too");
        assert_eq!(disk_size(&d), 0);
        assert!(remove(&d).is_ok(), "nothing to remove is fine");
    }
}
