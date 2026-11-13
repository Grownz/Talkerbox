//! AI fill for "Background under moved parts": LaMa (ONNX, 512 x 512) on the ONNX Runtime that smart select downloads
//! (same DLL in `sam\`, same single process-wide environment, see `sam::environment`). The model is downloaded on demand
//! into `inpaint\` (size and SHA-256 pinned). It runs once per "Generate with AI" click: the session is loaded, run and
//! dropped in one call, so nothing stays in memory and no exit path can leak it. The result is stored with the
//! character (`fill.png`), so the avatar window never needs the model.

use crate::sam::{self, Asset};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, State};

/// LaMa (Apache-2.0, advimman/lama) as the OpenCV Zoo ONNX export (Apache-2.0), pinned to one commit. Fixed input:
/// `image` [1, 3, 512, 512] RGB 0..1 and `mask` [1, 1, 512, 512] (1 = fill); output RGB 0..255.
pub const LAMA: Asset = Asset {
    url: "https://huggingface.co/opencv/inpainting_lama/resolve/aee6d22f0a13e5e35af1c9a1c3afd62841fc6f3f/inpainting_lama_2025jan.onnx",
    file: "inpainting_lama_2025jan.onnx",
    size: 92_591_623,
    sha256: "7df918ac3921d3daf0aae1d219776cf0dc4e4935f035af81841b40adcf74fdf2",
};
pub const SIDE: usize = 512;

pub fn installed(dir: &Path, sam_dir: &Path) -> bool {
    sam_dir.join(sam::RUNTIME_DLL).is_file() && std::fs::metadata(dir.join(LAMA.file)).is_ok_and(|m| m.len() == LAMA.size)
}

/// 512 x 512 RGBA (alpha 255 = fill this pixel, 0 = keep) -> LaMa inputs: RGB planes 0..1 and the mask plane.
pub fn split(rgba: &[u8]) -> Result<(Vec<f32>, Vec<f32>), String> {
    let n = SIDE * SIDE;
    if rgba.len() != n * 4 {
        return Err(format!("AI fill expects {SIDE} x {SIDE} RGBA, got {} bytes", rgba.len()));
    }
    let mut img = vec![0f32; 3 * n];
    let mut mask = vec![0f32; n];
    for (i, p) in rgba.as_chunks::<4>().0.iter().enumerate() {
        for c in 0..3 {
            img[c * n + i] = f32::from(p[c]) / 255.0;
        }
        mask[i] = if p[3] >= 128 { 1.0 } else { 0.0 };
    }
    Ok((img, mask))
}

/// LaMa output planes (0..255) -> RGBA bytes (alpha 255).
pub fn join(planes: &[f32]) -> Vec<u8> {
    let n = planes.len() / 3;
    (0..n).flat_map(|i| [0, 1, 2].map(|c| planes[c * n + i].clamp(0.0, 255.0).round() as u8).into_iter().chain([255])).collect()
}

/// Loads the model, fills, and drops the session again. Returns the RGBA result and the (load, run) times in ms.
pub fn run(sam_dir: &Path, dir: &Path, rgba: &[u8]) -> Result<(Vec<u8>, f64, f64), String> {
    let (img, mask) = split(rgba)?;
    let t = Instant::now();
    let env = sam::environment(sam_dir)?;
    // Basic graph optimisation: loading this 92 MB graph takes 6-9 s on a Ryzen 7 7700X at any level (the full level
    // is the slowest), and the session is used for one run per click anyway.
    let mut s = Session::builder(&env)
        .map_err(|e| format!("AI fill: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level1)
        .map_err(|e| format!("AI fill: {e}"))?
        .commit_from_file(dir.join(LAMA.file))
        .map_err(|e| format!("AI fill: {e}"))?;
    let load = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let err = |e: ort::Error| format!("AI fill: {e}");
    let out = s
        .run(ort::inputs![
            "image" => Tensor::from_array(([1usize, 3, SIDE, SIDE], img)).map_err(err)?,
            "mask" => Tensor::from_array(([1usize, 1, SIDE, SIDE], mask)).map_err(err)?,
        ])
        .map_err(err)?;
    let (_, planes) = out["output"].try_extract_tensor::<f32>().map_err(err)?;
    if planes.len() != 3 * SIDE * SIDE {
        return Err(format!("AI fill: unexpected output size {}", planes.len()));
    }
    Ok((join(planes), load, t.elapsed().as_secs_f64() * 1000.0))
}

// ---------- commands ----------

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join("inpaint"))
}
fn sam_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join("sam"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintStatus {
    installed: bool,
    /// Bytes of the model folder (the shared runtime is counted with smart select).
    bytes: u64,
    /// The ONNX Runtime DLL (shared with smart select) is present.
    runtime: bool,
}

#[tauri::command]
pub fn inpaint_status(app: AppHandle) -> Result<InpaintStatus, String> {
    let (d, s) = (dir(&app)?, sam_dir(&app)?);
    Ok(InpaintStatus { installed: installed(&d, &s), bytes: sam::disk_size(&d), runtime: s.join(sam::RUNTIME_DLL).is_file() })
}

/// Downloads the runtime (into `sam\`, if smart select has not already) and the LaMa model (into `inpaint\`).
#[tauri::command]
pub async fn inpaint_download(app: AppHandle, state: State<'_, crate::AppState>, id: String, on_progress: Channel<crate::Progress>) -> Result<bool, String> {
    let (d, s) = (dir(&app)?, sam_dir(&app)?);
    sam::clean_stale(&s);
    let op = state.op(&id);
    if sam::fetch_pinned(&state.http, &op.notify, &s, &sam::RUNTIME_WHEEL, "Runtime", &on_progress).await? {
        return Ok(true);
    }
    sam::fetch_pinned(&state.http, &op.notify, &d, &LAMA, "Inpainting model", &on_progress).await
}

/// Deletes the LaMa model (the shared runtime stays; smart select's "Remove" deletes it).
#[tauri::command]
pub async fn inpaint_remove(app: AppHandle) -> Result<(), String> {
    let d = dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || sam::remove(&d)).await.map_err(|e| e.to_string())?
}

/// Raw body: 512 x 512 RGBA (alpha marks the pixels to fill). Returns the filled RGBA.
#[tauri::command]
pub async fn inpaint_run(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Response, String> {
    let tauri::ipc::InvokeBody::Raw(rgba) = request.body() else {
        return Err("AI fill expects raw image bytes".into());
    };
    let (d, s, rgba) = (dir(&app)?, sam_dir(&app)?, rgba.clone());
    if !installed(&d, &s) {
        return Err("The AI fill model is not installed".into());
    }
    let (out, _, _) = tauri::async_runtime::spawn_blocking(move || run(&s, &d, &rgba)).await.map_err(|e| e.to_string())??;
    Ok(Response::new(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_and_join_round_trip() {
        let mut rgba = vec![0u8; SIDE * SIDE * 4];
        rgba[..8].copy_from_slice(&[255, 128, 0, 255, 10, 20, 30, 0]);
        let (img, mask) = split(&rgba).unwrap();
        let n = SIDE * SIDE;
        assert_eq!((img[0], img[n], img[2 * n], mask[0]), (1.0, 128.0 / 255.0, 0.0, 1.0));
        assert_eq!(mask[1], 0.0);
        assert!(split(&rgba[..100]).is_err());
        let planes: Vec<f32> = img.iter().map(|v| v * 255.0).collect();
        let back = join(&planes);
        assert_eq!(&back[..8], &[255, 128, 0, 255, 10, 20, 30, 255]);
        assert_eq!(join(&[300.0, -5.0, 7.4]), vec![255, 0, 7, 255], "clamped and rounded");
    }

    /// Real run: `TALKERBOX_SAM_DIR=<dir with onnxruntime.dll> TALKERBOX_LAMA_DIR=<dir with the model>
    /// cargo test --release lama_real -- --ignored --nocapture`. A flat image with a square of another colour to remove:
    /// the filled square must come back close to the surrounding colour.
    #[test]
    #[ignore]
    fn lama_real() {
        let s = PathBuf::from(std::env::var("TALKERBOX_SAM_DIR").unwrap());
        let d = PathBuf::from(std::env::var("TALKERBOX_LAMA_DIR").unwrap());
        let mut rgba = Vec::with_capacity(SIDE * SIDE * 4);
        for y in 0..SIDE {
            for x in 0..SIDE {
                let hole = (200..300).contains(&x) && (200..300).contains(&y);
                rgba.extend_from_slice(&if hole { [20, 200, 20, 255] } else { [180, 160, 140, 0] });
            }
        }
        for i in 0..2 {
            let (out, load, ms) = run(&s, &d, &rgba).unwrap();
            let p = &out[(250 * SIDE + 250) * 4..][..3];
            println!("run {i}: load {load:.0} ms, inference {ms:.0} ms, centre {p:?}");
            assert!(p.iter().zip([180u8, 160, 140]).all(|(a, b)| a.abs_diff(b) < 25));
        }
    }
}
