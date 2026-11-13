//! "Detect face parts" in the part editor: MediaPipe BlazeFace (short range) finds the face, Face Mesh V2 places 478
//! landmarks on it (both ONNX, on the ONNX Runtime that smart select downloads: same DLL in `sam\`, same single
//! process-wide environment, see `sam::environment`). The models are downloaded on demand into `face\` (sizes and
//! SHA-256 pinned). Like the AI fill, each click loads, runs and drops both sessions, so nothing stays in memory.
//! Made for photos and realistic paintings; stylised cartoons are usually rejected by the presence check.

use crate::sam::{self, Asset};
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// MediaPipe BlazeFace short-range detector (Apache-2.0, from the Face Landmarker bundle) as ONNX, pinned to one
/// commit. Input `input` [1, 128, 128, 3] RGB -1..1; outputs `regressors` [1, 896, 16] (box + 6 keypoints per anchor)
/// and `classificators` [1, 896, 1] (score logits).
pub const DETECTOR: Asset = Asset {
    url: "https://huggingface.co/fernandotonon/QtMeshEditor-blazeface-onnx/resolve/50f2c66ffbdf84beae8c267df2b49e5c5a5162e9/face_detector.onnx",
    file: "face_detector.onnx",
    size: 418_437,
    sha256: "02a04d5d37c3558dc4d5274f7f8f0f0f01ac94e46c5ffb2cee82395d47e23181",
};
/// MediaPipe Face Mesh V2 landmarks (Apache-2.0) as ONNX, pinned to one commit. Input [N, 256, 256, 3] RGB 0..1 (the
/// rotated face crop); outputs 478 x (x, y, z) in crop pixels and a face presence logit.
pub const MESH: Asset = Asset {
    url: "https://huggingface.co/fernandotonon/QtMeshEditor-facemesh-onnx/resolve/32714088ed9830a98df6ee653ad406a3b83ef014/face_landmarks.onnx",
    file: "face_landmarks.onnx",
    size: 4_920_979,
    sha256: "d16e5a55e6a480284d468ee32469692464049518c311662ab3956681de31e3e9",
};
pub const LANDMARKS: usize = 478;
const DET_SIDE: usize = 128;
const MESH_SIDE: usize = 256;
const MIN_SCORE: f32 = 0.5;

pub fn installed(dir: &Path, sam_dir: &Path) -> bool {
    let size = |a: &Asset| std::fs::metadata(dir.join(a.file)).map(|m| m.len()).ok();
    sam_dir.join(sam::RUNTIME_DLL).is_file() && size(&DETECTOR) == Some(DETECTOR.size) && size(&MESH) == Some(MESH.size)
}

// ---------- pure pre- and post-processing ----------

/// Output pixel (u, v) -> image point: x = a*u + b*v + c, y = d*u + e*v + f.
type Affine = [f32; 6];

fn apply(m: &Affine, u: f32, v: f32) -> [f32; 2] {
    [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]]
}

/// `side` x `side` RGB crop (HWC, 0..255) of the w x h RGB image (HWC, 0..255) through `m`, bilinear; outside is black.
pub fn warp(rgb: &[f32], w: usize, h: usize, m: &Affine, side: usize) -> Vec<f32> {
    let px = |x: isize, y: isize, c: usize| if x < 0 || y < 0 || x >= w as isize || y >= h as isize { 0.0 } else { rgb[(y as usize * w + x as usize) * 3 + c] };
    let mut out = Vec::with_capacity(side * side * 3);
    for v in 0..side {
        for u in 0..side {
            let [x, y] = apply(m, u as f32 + 0.5, v as f32 + 0.5);
            let (x, y) = (x - 0.5, y - 0.5);
            let (x0, y0) = (x.floor(), y.floor());
            let (fx, fy) = (x - x0, y - y0);
            let (x0, y0) = (x0 as isize, y0 as isize);
            for c in 0..3 {
                let top = px(x0, y0, c) * (1.0 - fx) + px(x0 + 1, y0, c) * fx;
                let bot = px(x0, y0 + 1, c) * (1.0 - fx) + px(x0 + 1, y0 + 1, c) * fx;
                out.push(top * (1.0 - fy) + bot * fy);
            }
        }
    }
    out
}

/// Square windows (x0, y0, side) in image pixels the detector looks at: the whole image (letterboxed, centred), then
/// windows of half the size each step (half overlapping) down to a quarter of the short side, so a face that is
/// small in a full-body picture is still large in some window. The short-range model wants large faces.
pub fn windows(w: usize, h: usize) -> Vec<(f32, f32, f32)> {
    let (w, h) = (w as f32, h as f32);
    let long = w.max(h);
    let mut out = vec![((w - long) / 2.0, (h - long) / 2.0, long)];
    let mut s = long / 2.0;
    while s >= (w.min(h) / 4.0).max(64.0) {
        let starts = |len: f32| {
            let n = ((len - s) / (s / 2.0)).ceil().max(0.0) as usize;
            (0..=n).map(move |i| if n == 0 { (len - s) / 2.0 } else { (len - s) * i as f32 / n as f32 }).collect::<Vec<_>>()
        };
        for y in starts(h) {
            for x in starts(w) {
                out.push((x, y, s));
            }
        }
        s /= 2.0;
    }
    out
}

/// BlazeFace anchors (centres, 0..1): strides 8 (2 per cell) and 16 (6 per cell), 896 in all.
fn anchors() -> Vec<[f32; 2]> {
    let mut a = Vec::with_capacity(896);
    for (stride, n) in [(8, 2), (16, 6)] {
        let g = DET_SIDE / stride;
        for y in 0..g {
            for x in 0..g {
                for _ in 0..n {
                    a.push([(x as f32 + 0.5) / g as f32, (y as f32 + 0.5) / g as f32]);
                }
            }
        }
    }
    a
}

/// A detected face in image pixels: score, box centre, box size, the eye keypoints (the person's right eye, which
/// is on the left in a frontal picture, first).
#[derive(Clone, Debug, PartialEq)]
pub struct Face {
    pub score: f32,
    pub centre: [f32; 2],
    pub size: f32,
    pub eyes: [[f32; 2]; 2],
}

fn sigmoid(v: f32) -> f32 {
    1.0 / (1.0 + (-v.clamp(-80.0, 80.0)).exp())
}

/// The best face of one detector run on window (x0, y0, side), or None below the score threshold.
pub fn decode(regs: &[f32], logits: &[f32], window: (f32, f32, f32)) -> Option<Face> {
    let a = anchors();
    if regs.len() != a.len() * 16 || logits.len() != a.len() {
        return None;
    }
    let (i, &l) = logits.iter().enumerate().filter(|(_, v)| v.is_finite()).max_by(|x, y| x.1.total_cmp(y.1))?;
    let score = sigmoid(l);
    if score < MIN_SCORE {
        return None;
    }
    let (x0, y0, s) = window;
    let r = &regs[i * 16..][..16];
    let at = |dx: f32, dy: f32| [x0 + (dx / DET_SIDE as f32 + a[i][0]) * s, y0 + (dy / DET_SIDE as f32 + a[i][1]) * s];
    Some(Face { score, centre: at(r[0], r[1]), size: r[2].max(r[3]) / DET_SIDE as f32 * s, eyes: [at(r[4], r[5]), at(r[6], r[7])] })
}

/// The face crop MediaPipe feeds to the mesh: square, 1.5 times the box, turned so the eyes are level.
pub fn mesh_roi(f: &Face) -> Affine {
    let [[ax, ay], [bx, by]] = f.eyes;
    let rot = (by - ay).atan2(bx - ax);
    let k = f.size * 1.5 / MESH_SIDE as f32;
    let (c, s) = (rot.cos() * k, rot.sin() * k);
    let half = MESH_SIDE as f32 / 2.0;
    [c, -s, f.centre[0] - half * c + half * s, s, c, f.centre[1] - half * s - half * c]
}

/// Mesh output (x, y, z per landmark, crop pixels) -> landmarks normalised to the w x h image.
pub fn landmarks(out: &[f32], m: &Affine, w: usize, h: usize) -> Option<Vec<[f32; 2]>> {
    if out.len() != LANDMARKS * 3 {
        return None;
    }
    let pts: Vec<[f32; 2]> = out.as_chunks::<3>().0.iter().map(|p| apply(m, p[0], p[1])).map(|[x, y]| [x / w as f32, y / h as f32]).collect();
    pts.iter().flatten().all(|v| v.is_finite()).then_some(pts)
}

// ---------- inference ----------

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    /// 478 MediaPipe landmarks, normalised to the image (may lie slightly outside it).
    pub points: Vec<[f32; 2]>,
    /// Detector score and mesh face presence, 0..1.
    pub score: f32,
    pub presence: f32,
    pub ms: f64,
}

/// Loads both models, detects the most likely face (trying the three best detections until the mesh confirms one),
/// and drops the sessions again. `rgba` is w x h, long side at most 1024.
pub fn run(sam_dir: &Path, dir: &Path, rgba: &[u8], w: usize, h: usize) -> Result<Detection, String> {
    let rgb = sam::rgba_to_rgb(rgba, w, h)?;
    let t = Instant::now();
    let err = |e: ort::Error| format!("Face detection: {e}");
    let env = sam::environment(sam_dir)?;
    let open = |a: &Asset| Session::builder(&env).and_then(|mut b| b.commit_from_file(dir.join(a.file))).map_err(err);
    let (mut det, mut mesh) = (open(&DETECTOR)?, open(&MESH)?);
    let mut faces = Vec::new();
    for win in windows(w, h) {
        let k = win.2 / DET_SIDE as f32;
        let img: Vec<f32> = warp(&rgb, w, h, &[k, 0.0, win.0, 0.0, k, win.1], DET_SIDE).iter().map(|v| v / 127.5 - 1.0).collect();
        let out = det.run(ort::inputs!["input" => Tensor::from_array(([1usize, DET_SIDE, DET_SIDE, 3], img)).map_err(err)?]).map_err(err)?;
        let (_, regs) = out["regressors"].try_extract_tensor::<f32>().map_err(err)?;
        let (_, logits) = out["classificators"].try_extract_tensor::<f32>().map_err(err)?;
        faces.extend(decode(regs, logits, win));
    }
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    for f in faces.iter().take(3) {
        let m = mesh_roi(f);
        let img: Vec<f32> = warp(&rgb, w, h, &m, MESH_SIDE).iter().map(|v| v / 255.0).collect();
        let out = mesh.run(ort::inputs![Tensor::from_array(([1usize, MESH_SIDE, MESH_SIDE, 3], img)).map_err(err)?]).map_err(err)?;
        let (_, lm) = out[0].try_extract_tensor::<f32>().map_err(err)?;
        let (_, p) = out[1].try_extract_tensor::<f32>().map_err(err)?;
        let presence = p.first().copied().map_or(0.0, sigmoid);
        if let Some(points) = landmarks(lm, &m, w, h).filter(|_| presence >= MIN_SCORE) {
            return Ok(Detection { points, score: f.score, presence, ms: t.elapsed().as_secs_f64() * 1000.0 });
        }
    }
    Err("No face found. Face detection is made for photos and realistic paintings with the face clearly visible; for drawings and cartoons use Pick.".into())
}

// ---------- commands ----------

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join("face"))
}
fn sam_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join("sam"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceStatus {
    installed: bool,
    /// Bytes of the model folder (the shared runtime is counted with smart select).
    bytes: u64,
    /// The ONNX Runtime DLL (shared with smart select) is present.
    runtime: bool,
}

#[tauri::command]
pub fn face_status(app: AppHandle) -> Result<FaceStatus, String> {
    let (d, s) = (dir(&app)?, sam_dir(&app)?);
    Ok(FaceStatus { installed: installed(&d, &s), bytes: sam::disk_size(&d), runtime: s.join(sam::RUNTIME_DLL).is_file() })
}

/// Downloads the runtime (into `sam\`, if smart select has not already) and both face models (into `face\`).
#[tauri::command]
pub async fn face_download(app: AppHandle, state: State<'_, crate::AppState>, id: String, on_progress: Channel<crate::Progress>) -> Result<bool, String> {
    let (d, s) = (dir(&app)?, sam_dir(&app)?);
    sam::clean_stale(&s);
    let op = state.op(&id);
    if sam::fetch_pinned(&state.http, &op.notify, &s, &sam::RUNTIME_WHEEL, "Runtime", &on_progress).await? {
        return Ok(true);
    }
    for (a, label) in [(&DETECTOR, "Face detector"), (&MESH, "Face landmarks")] {
        if sam::fetch_pinned(&state.http, &op.notify, &d, a, label, &on_progress).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Deletes both face models (the shared runtime stays; smart select's "Remove" deletes it).
#[tauri::command]
pub async fn face_remove(app: AppHandle) -> Result<(), String> {
    let d = dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || sam::remove(&d)).await.map_err(|e| e.to_string())?
}

/// Raw body: RGBA bytes, headers `x-width`, `x-height` (long side at most 1024). Returns the landmarks of the face.
#[tauri::command]
pub async fn face_detect(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Detection, String> {
    let tauri::ipc::InvokeBody::Raw(rgba) = request.body() else {
        return Err("Face detection expects raw image bytes".into());
    };
    let num = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()?.parse::<usize>().ok()).ok_or(format!("Missing or invalid header {k}"));
    let (w, h) = (num("x-width")?, num("x-height")?);
    let (d, s, rgba) = (dir(&app)?, sam_dir(&app)?, rgba.clone());
    if !installed(&d, &s) {
        return Err("The face detection models are not installed".into());
    }
    tauri::async_runtime::spawn_blocking(move || run(&s, &d, &rgba, w, h)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warp_samples_bilinear_and_pads_black() {
        // 2 x 1 image: red, then blue.
        let rgb = [255.0, 0.0, 0.0, 0.0, 0.0, 255.0];
        assert_eq!(warp(&rgb, 2, 1, &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0], 2)[..6], [255.0, 0.0, 0.0, 0.0, 0.0, 255.0], "identity");
        let half = warp(&rgb, 2, 1, &[1.0, 0.0, 0.5, 0.0, 1.0, 0.0], 1);
        assert_eq!(half, vec![127.5, 0.0, 127.5], "between both pixels");
        assert_eq!(warp(&rgb, 2, 1, &[1.0, 0.0, 10.0, 0.0, 1.0, 10.0], 1), vec![0.0; 3], "outside");
    }

    #[test]
    fn windows_cover_the_image_and_shrink() {
        let w = windows(400, 1000);
        assert_eq!(w[0], (-300.0, 0.0, 1000.0), "whole image, letterboxed");
        assert!(w.iter().all(|&(_, _, s)| s >= 100.0), "down to a quarter of the short side");
        for &(x, y, s) in &w[1..] {
            assert!(x >= -0.01 && y >= -0.01 && x + s <= 400.01 && y + s <= 1000.01 || s > 400.0, "{x} {y} {s} inside");
        }
        // Every point of the image is in some window of each size.
        for s in [500.0, 250.0, 125.0] {
            let ws: Vec<_> = w.iter().filter(|q| q.2 == s).collect();
            assert!(!ws.is_empty());
            for (px, py) in [(0.0, 0.0), (399.0, 999.0), (200.0, 500.0)] {
                assert!(ws.iter().any(|&&(x, y, s)| px >= x && px <= x + s && py >= y && py <= y + s), "{px},{py} at {s}");
            }
        }
        assert_eq!(windows(100, 100).len(), 1, "small images: only the whole image");
    }

    #[test]
    fn decode_picks_the_best_anchor_in_image_pixels() {
        assert_eq!(anchors().len(), 896);
        let mut regs = vec![0f32; 896 * 16];
        let mut logits = vec![-10f32; 896];
        // Anchor 0: centre of cell (0, 0) of the 16 x 16 grid = (4, 4) px of the 128 px window.
        logits[0] = 3.0;
        regs[..8].copy_from_slice(&[4.0, 0.0, 32.0, 40.0, -8.0, 0.0, 8.0, 0.0]);
        let f = decode(&regs, &logits, (100.0, 50.0, 256.0)).unwrap();
        assert!((f.score - sigmoid(3.0)).abs() < 1e-6);
        assert_eq!(f.centre, [100.0 + 16.0, 50.0 + 8.0], "(8, 4) px in the window, scaled by 2");
        assert_eq!(f.size, 80.0, "the larger side");
        assert_eq!(f.eyes, [[92.0, 58.0], [124.0, 58.0]], "(-4, 4) and (12, 4) px in the window");
        logits[0] = -1.0;
        assert_eq!(decode(&regs, &logits, (0.0, 0.0, 128.0)), None, "below the threshold");
        assert_eq!(decode(&regs[..16], &logits, (0.0, 0.0, 128.0)), None, "wrong size");
    }

    #[test]
    fn roi_levels_the_eyes_and_maps_back() {
        let f = Face { score: 1.0, centre: [200.0, 300.0], size: 100.0, eyes: [[150.0, 250.0], [250.0, 350.0]] };
        let m = mesh_roi(&f);
        let close = |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-3 && (a[1] - b[1]).abs() < 1e-3;
        assert!(close(apply(&m, 128.0, 128.0), [200.0, 300.0]), "crop centre is the face centre");
        // The crop's x axis runs along the eye line (45 degrees here), 150 px across 256 crop px.
        let k = 150.0 / 256.0 * std::f32::consts::FRAC_1_SQRT_2;
        assert!(close(apply(&m, 256.0, 128.0), [200.0 + 128.0 * k, 300.0 + 128.0 * k]));
        let out: Vec<f32> = (0..LANDMARKS).flat_map(|_| [128.0, 128.0, 0.0]).collect();
        let pts = landmarks(&out, &m, 400, 600).unwrap();
        assert!(close(pts[0], [0.5, 0.5]) && pts.len() == LANDMARKS);
        assert!(landmarks(&out[..30], &m, 400, 600).is_none());
    }

    /// Real run: `TALKERBOX_SAM_DIR=<dir with onnxruntime.dll> TALKERBOX_FACE_DIR=<dir with both models>
    /// TALKERBOX_FACE_IMAGES=<a.png;b.jpg;...> cargo test --release face_real -- --ignored --nocapture`. Prints the
    /// score, the time and the mouth corners and eye centres in pixels (or why no face was found) for each image, and
    /// writes the landmarks (normalised) to `<image>.json` for drawing them.
    #[test]
    #[ignore]
    fn face_real() {
        let s = PathBuf::from(std::env::var("TALKERBOX_SAM_DIR").unwrap());
        let d = PathBuf::from(std::env::var("TALKERBOX_FACE_DIR").unwrap());
        for f in std::env::var("TALKERBOX_FACE_IMAGES").unwrap().split(';') {
            let img = image_rgba(f);
            let (w, h) = (img.1, img.2);
            match run(&s, &d, &img.0, w, h) {
                Ok(r) => {
                    let px = |i: usize| [r.points[i][0] * w as f32, r.points[i][1] * h as f32];
                    let mean = |ids: &[usize]| {
                        let n = ids.len() as f32;
                        ids.iter().map(|&i| px(i)).fold([0.0, 0.0], |a, p| [a[0] + p[0] / n, a[1] + p[1] / n])
                    };
                    let (er, el) = (mean(&[33, 133, 159, 145]), mean(&[263, 362, 386, 374]));
                    println!(
                        "{f} ({w}x{h}): score {:.2}, presence {:.2}, {:.0} ms; corners {:.0?} {:.0?}; eye centres {er:.0?} {el:.0?}",
                        r.score, r.presence, r.ms, px(61), px(291)
                    );
                    std::fs::write(format!("{f}.json"), serde_json::to_string(&r.points).unwrap()).unwrap();
                }
                Err(e) => println!("{f} ({w}x{h}): {e}"),
            }
        }
    }

    /// Binary PPM (P6, maxval 255) -> RGBA; the crate has no image decoder, so test pictures are converted to PPM first.
    fn image_rgba(path: &str) -> (Vec<u8>, usize, usize) {
        let b = std::fs::read(path).unwrap();
        let mut it = b.split(|c| c.is_ascii_whitespace()).filter(|t| !t.is_empty());
        assert_eq!(it.next().unwrap(), b"P6", "binary PPM expected");
        let mut num = || std::str::from_utf8(it.next().unwrap()).unwrap().parse::<usize>().unwrap();
        let (w, h, _) = (num(), num(), num());
        let px = &b[b.len() - w * h * 3..];
        (px.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect(), w, h)
    }
}
