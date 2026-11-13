//! Avatar characters: rig data model (`avatars/<id>/rig.json` + `image.<ext>` in the app data dir),
//! validation, image import and the Tauri commands. Ids are always generated here; paths never come from the UI.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::ipc::Response;
use tauri::AppHandle;

pub const VERSION: u32 = 1;
const RIG_FILE: &str = "rig.json";
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_SIDE: u32 = 8192;
const MAX_RIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PARTS: usize = 64;
const MAX_MASK_POINTS: usize = 4096;
const MAX_POLYGON_POINTS: usize = 1024;
const MAX_MOUTH_STATES: usize = 8;
const MAX_NAME_CHARS: usize = 80;
const MAX_ID_CHARS: usize = 64;
const IMAGE_FILES: [&str; 3] = ["image.png", "image.jpg", "image.webp"];
/// Stored AI fill of the area under moved parts (optional, written by `save_fill`).
pub const FILL_FILE: &str = "fill.png";

pub type Point = [f64; 2];

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Portrait,
    Fullbody,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    EyeL,
    EyeR,
    Mouth,
    ArmL,
    ArmR,
    HandL,
    HandR,
    LegL,
    LegR,
    Head,
    Body,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Image {
    /// `image.png`, `image.jpg` or `image.webp` inside the character folder.
    pub file: String,
    pub width: u32,
    pub height: u32,
}

/// Outline of the figure; coordinates are normalised to the image (0..1). `points` is the outline as drawn;
/// `smoothed` is the baked result of the editor's Smooth/Snap sliders (`smooth`, `snap`: 0..1), used for rendering.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Mask {
    pub points: Vec<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smoothed: Option<Vec<Point>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smooth: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snap: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Part {
    pub id: String,
    pub role: Role,
    pub polygon: Vec<Point>,
    pub pivot: Point,
    #[serde(default)]
    pub z: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Display name in the part editor (1-80 characters); the role name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Eyelid colour of an eye part (`#rrggbb`), drawn while blinking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lid: Option<String>,
}

/// Optional mouth sprite states (e.g. closed/half/open), cut from the image like parts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MouthState {
    pub id: String,
    pub polygon: Vec<Point>,
}

/// Mouth animation data. `interior` is the open-mouth shape inside the mouth part (scaled vertically with the
/// loudness), `color` its fill (`#rrggbb`); without `interior` the renderer uses a shrunk mouth polygon.
/// `lip_upper`/`lip_lower` (both or neither) make the lips part and warp the face around them (`warp` 0..1);
/// `corners` are the left and right mouth corner, derived from the lips when absent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mouth {
    #[serde(default)]
    pub states: Vec<MouthState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interior: Option<Vec<Point>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lip_upper: Option<Vec<Point>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lip_lower: Option<Vec<Point>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corners: Option<[Point; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warp: Option<f64>,
}

/// How the area a moved part uncovers is drawn: `none` shows the original pixels (as before), `transparent` cuts it
/// out, `classic` fills it in the renderer (push-pull), `ai` uses the stored LaMa result (`image`, covering `rect`
/// = [x0, y0, x1, y1] of the image, 0..1) over the classic fill. `sig` identifies the parts the AI fill was made for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FillMode {
    #[default]
    None,
    Transparent,
    Classic,
    Ai,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub mode: FillMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rig {
    pub version: u32,
    pub id: String,
    pub name: String,
    /// Derived from the parts on save (full body iff arms or legs exist); stored for the UI.
    pub kind: Kind,
    pub image: Image,
    #[serde(default)]
    pub mask: Mask,
    #[serde(default)]
    pub parts: Vec<Part>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouth: Option<Mouth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<Fill>,
    /// Epoch ms.
    pub created_at: u64,
    pub updated_at: u64,
}

pub fn derive_kind(parts: &[Part]) -> Kind {
    let limb = |r: Role| matches!(r, Role::ArmL | Role::ArmR | Role::LegL | Role::LegR);
    if parts.iter().any(|p| limb(p.role)) {
        Kind::Fullbody
    } else {
        Kind::Portrait
    }
}

/// Character ids: lowercase letters, digits and inner '-', as made by `packs::slug`. No dots, so no traversal.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-')
}

fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err("Invalid character id".into())
    }
}

/// Trimmed display name, 1-80 characters, no control characters.
pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_NAME_CHARS || n.chars().any(char::is_control) {
        return Err(format!("The name must be 1-{MAX_NAME_CHARS} characters without control characters"));
    }
    Ok(n.to_string())
}

fn check_points(what: &str, pts: &[Point], max: usize) -> Result<(), String> {
    if pts.len() > max {
        return Err(format!("{what}: more than {max} points"));
    }
    if pts.iter().flatten().any(|v| !v.is_finite() || !(0.0..=1.0).contains(v)) {
        return Err(format!("{what}: coordinates must be numbers from 0 to 1"));
    }
    Ok(())
}

/// `#rrggbb`.
fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn check_polygon(what: &str, pts: &[Point], max: usize) -> Result<(), String> {
    if pts.len() < 3 {
        return Err(format!("{what}: a polygon needs at least 3 points"));
    }
    check_points(what, pts, max)
}

/// Checks everything a loaded or saved rig must satisfy.
pub fn validate(r: &Rig) -> Result<(), String> {
    if r.version != VERSION {
        return Err(format!("Unsupported character format version {} (this Talkerbox reads version {VERSION})", r.version));
    }
    check_id(&r.id)?;
    clean_name(&r.name)?;
    if !IMAGE_FILES.contains(&r.image.file.as_str()) {
        return Err("Invalid image file name".into());
    }
    if r.image.width == 0 || r.image.height == 0 || r.image.width > MAX_SIDE || r.image.height > MAX_SIDE {
        return Err(format!("Image size must be 1-{MAX_SIDE} px per side"));
    }
    if !r.mask.points.is_empty() {
        check_polygon("Mask", &r.mask.points, MAX_MASK_POINTS)?;
    }
    if let Some(s) = &r.mask.smoothed {
        check_points("Smoothed mask", s, MAX_MASK_POINTS)?;
    }
    if [r.mask.smooth, r.mask.snap].into_iter().flatten().any(|v| !(0.0..=1.0).contains(&v)) {
        return Err("Mask smoothing and snapping must be from 0 to 1".into());
    }
    if r.parts.len() > MAX_PARTS {
        return Err(format!("More than {MAX_PARTS} parts"));
    }
    for (i, p) in r.parts.iter().enumerate() {
        if !valid_id(&p.id) {
            return Err(format!("Part {}: invalid id", i + 1));
        }
        if r.parts[..i].iter().any(|q| q.id == p.id) {
            return Err(format!("Part id '{}' is used twice", p.id));
        }
        check_polygon(&format!("Part '{}'", p.id), &p.polygon, MAX_POLYGON_POINTS)?;
        check_points(&format!("Part '{}' pivot", p.id), &[p.pivot], 1)?;
        if !(-1000..=1000).contains(&p.z) {
            return Err(format!("Part '{}': z must be from -1000 to 1000", p.id));
        }
        if p.role != Role::Custom && r.parts[..i].iter().any(|q| q.role == p.role) {
            return Err(format!("Part '{}': only one part per role (except custom)", p.id));
        }
        if let Some(l) = &p.label {
            clean_name(l).map_err(|e| format!("Part '{}' label: {e}", p.id))?;
        }
        if p.lid.as_deref().is_some_and(|c| !valid_color(c)) {
            return Err(format!("Part '{}': eyelid colour must be #rrggbb", p.id));
        }
    }
    // Parents must exist and must not form a loop (a chain longer than the part count is one).
    for p in &r.parts {
        let mut cur = p.parent.as_deref();
        let mut steps = 0;
        while let Some(id) = cur {
            if steps >= r.parts.len() {
                return Err(format!("Part '{}': parent chain loops", p.id));
            }
            cur = r.parts.iter().find(|q| q.id == id).ok_or_else(|| format!("Part '{}': unknown parent '{id}'", p.id))?.parent.as_deref();
            steps += 1;
        }
    }
    if let Some(m) = &r.mouth {
        if m.states.len() > MAX_MOUTH_STATES {
            return Err(format!("More than {MAX_MOUTH_STATES} mouth states"));
        }
        for (i, s) in m.states.iter().enumerate() {
            if !valid_id(&s.id) || m.states[..i].iter().any(|q| q.id == s.id) {
                return Err(format!("Mouth state {}: invalid or duplicate id", i + 1));
            }
            check_polygon(&format!("Mouth state '{}'", s.id), &s.polygon, MAX_POLYGON_POINTS)?;
        }
        if let Some(p) = &m.interior {
            check_polygon("Open mouth shape", p, MAX_POLYGON_POINTS)?;
        }
        if m.color.as_deref().is_some_and(|c| !valid_color(c)) {
            return Err("Mouth colour must be #rrggbb".into());
        }
        match (&m.lip_upper, &m.lip_lower) {
            (Some(u), Some(l)) => {
                check_polygon("Upper lip", u, MAX_POLYGON_POINTS)?;
                check_polygon("Lower lip", l, MAX_POLYGON_POINTS)?;
            }
            (None, None) => {}
            _ => return Err("Define both lips or neither".into()),
        }
        if let Some(c) = &m.corners {
            check_points("Mouth corners", c, 2)?;
        }
        if m.warp.is_some_and(|w| !(0.0..=1.0).contains(&w)) {
            return Err("Face warp must be from 0 to 1".into());
        }
    }
    if let Some(f) = &r.fill {
        check_fill(f)?;
    }
    Ok(())
}

fn check_fill(f: &Fill) -> Result<(), String> {
    match (&f.image, &f.rect) {
        (None, None) => {}
        (Some(i), Some([x0, y0, x1, y1])) => {
            if i != FILL_FILE {
                return Err("Invalid fill image file name".into());
            }
            let ok = [x0, y0, x1, y1].iter().all(|v| v.is_finite() && (0.0..=1.0).contains(*v)) && x0 < x1 && y0 < y1;
            if !ok {
                return Err("Invalid fill area".into());
            }
        }
        _ => return Err("A fill image needs its area and the other way round".into()),
    }
    if f.sig.as_deref().is_some_and(|s| s.is_empty() || s.len() > 16 || !s.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err("Invalid fill signature".into());
    }
    Ok(())
}

/// Image format by magic bytes and its pixel size from the header: (file extension, width, height).
pub fn sniff_image(b: &[u8]) -> Result<(&'static str, u32, u32), String> {
    let be16 = |i: usize| b.get(i..i + 2).map(|s| u32::from(u16::from_be_bytes([s[0], s[1]])));
    let le16 = |i: usize| b.get(i..i + 2).map(|s| u32::from(u16::from_le_bytes([s[0], s[1]])));
    let le24 = |i: usize| b.get(i..i + 3).map(|s| u32::from_le_bytes([s[0], s[1], s[2], 0]));
    let dims = if b.starts_with(b"\x89PNG\r\n\x1a\n") && b.get(12..16) == Some(b"IHDR") {
        let be32 = |i: usize| b.get(i..i + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]));
        be32(16).zip(be32(20)).map(|(w, h)| ("png", w, h))
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        // Walk the JPEG segments up to the first start-of-frame marker. EXIF orientations 5-8 (turned by 90 degrees)
        // swap the size, so it matches the upright bitmap the WebView decodes.
        let mut i = 2;
        let mut found = None;
        let mut swap = false;
        while let (Some(&0xFF), Some(&m)) = (b.get(i), b.get(i + 1)) {
            if m == 0xFF {
                i += 1;
            } else if matches!(m, 0x01 | 0xD0..=0xD9) {
                i += 2;
            } else if matches!(m, 0xC0..=0xCF) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
                found = be16(i + 5).zip(be16(i + 7)).map(|(h, w)| if swap { ("jpg", h, w) } else { ("jpg", w, h) });
                break;
            } else {
                let Some(len) = be16(i + 2) else { break };
                if m == 0xE1 {
                    let seg = b.get(i + 4..i + 2 + len as usize);
                    swap |= seg.and_then(exif_orientation).is_some_and(|o| (5..=8).contains(&o));
                }
                i += 2 + len as usize;
            }
        }
        found
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        match b.get(12..16) {
            Some(b"VP8 ") if b.get(23..26) == Some(&[0x9D, 0x01, 0x2A]) => {
                le16(26).zip(le16(28)).map(|(w, h)| ("webp", w & 0x3FFF, h & 0x3FFF))
            }
            Some(b"VP8L") if b.get(20) == Some(&0x2F) => b.get(21..25).map(|s| {
                let v = u32::from_le_bytes([s[0], s[1], s[2], s[3]]);
                ("webp", (v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1)
            }),
            Some(b"VP8X") => le24(24).zip(le24(27)).map(|(w, h)| ("webp", w + 1, h + 1)),
            _ => None,
        }
    } else {
        return Err("Only PNG, JPEG and WebP images are supported".into());
    };
    let (ext, w, h) = dims.ok_or("The image file is damaged (no readable size)")?;
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
        return Err(format!("The image is {w} x {h} px; at most {MAX_SIDE} px per side is supported"));
    }
    Ok((ext, w, h))
}

/// Orientation tag (0x0112) in IFD0 of an APP1 payload (`Exif\0\0` + TIFF), if present.
fn exif_orientation(seg: &[u8]) -> Option<u16> {
    let t = seg.strip_prefix(b"Exif\0\0")?;
    let le = match t.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let rd = |i: usize, n: usize| {
        let s = t.get(i..i + n)?;
        Some(if le { s.iter().rev().fold(0u32, |a, &b| a << 8 | u32::from(b)) } else { s.iter().fold(0u32, |a, &b| a << 8 | u32::from(b)) })
    };
    let ifd = rd(4, 4)? as usize;
    let count = rd(ifd, 2)? as usize;
    let entry = (0..count).map(|k| ifd + 2 + k * 12).find(|&e| rd(e, 2) == Some(0x0112))?;
    rd(entry + 8, 2).map(|v| v as u16)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn read_rig(dir: &Path) -> Result<Rig, String> {
    let f = dir.join(RIG_FILE);
    let len = std::fs::metadata(&f).map_err(|_| "No such character")?.len();
    if len > MAX_RIG_BYTES {
        return Err("rig.json is too large".into());
    }
    let bytes = std::fs::read(&f).map_err(|e| format!("{}: {e}", f.display()))?;
    let rig: Rig = serde_json::from_slice(&bytes).map_err(|e| format!("rig.json is invalid: {e}"))?;
    validate(&rig)?;
    Ok(rig)
}

fn write_rig(dir: &Path, rig: &Rig) -> Result<(), String> {
    validate(rig)?;
    crate::config::write_atomic(&dir.join(RIG_FILE), &serde_json::to_vec_pretty(rig).map_err(|e| e.to_string())?)
}

pub fn load(root: &Path, id: &str) -> Result<Rig, String> {
    check_id(id)?;
    let rig = read_rig(&root.join(id))?;
    if rig.id != id {
        return Err("rig.json does not belong to its folder".into());
    }
    Ok(rig)
}

/// Valid characters, sorted by name (case-insensitive), then id. Unreadable folders are skipped.
pub fn list(root: &Path) -> Vec<Rig> {
    let mut v: Vec<Rig> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| load(root, e.file_name().to_str()?).ok())
        .collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    v
}

/// Copies an image into a new character folder. The folder is filled under a temporary name (not a valid id,
/// so `list` ignores it) and renamed at the end, so a failed import leaves nothing behind.
pub fn import(root: &Path, src: &Path) -> Result<Rig, String> {
    let len = std::fs::metadata(src).map_err(|e| format!("{}: {e}", src.display()))?.len();
    if len > MAX_IMAGE_BYTES {
        return Err(format!("The image is larger than {} MB", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let (ext, width, height) = sniff_image(&bytes)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = clean_name(&stem.chars().take(MAX_NAME_CHARS).collect::<String>()).unwrap_or_else(|_| "Character".into());
    std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let id = crate::packs::unique_id(&name, |c| root.join(c).exists());
    let now = now_ms();
    let rig = Rig {
        version: VERSION,
        id: id.clone(),
        name,
        kind: Kind::Portrait,
        image: Image { file: format!("image.{ext}"), width, height },
        mask: Mask::default(),
        parts: Vec::new(),
        mouth: None,
        fill: None,
        created_at: now,
        updated_at: now,
    };
    let tmp = root.join(format!(".import-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    let result = (|| {
        std::fs::create_dir_all(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::write(tmp.join(&rig.image.file), &bytes).map_err(|e| format!("Cannot copy the image: {e}"))?;
        write_rig(&tmp, &rig)?;
        std::fs::rename(&tmp, root.join(&id)).map_err(|e| format!("Cannot store the character: {e}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    result.map(|_| rig)
}

/// Saves edits to an existing character. Id, image and creation time always come from the stored rig;
/// the kind is re-derived from the parts.
pub fn save(root: &Path, mut rig: Rig) -> Result<Rig, String> {
    let old = load(root, &rig.id)?;
    rig.name = clean_name(&rig.name)?;
    rig.image = old.image;
    rig.created_at = old.created_at;
    rig.updated_at = now_ms().max(old.updated_at);
    rig.kind = derive_kind(&rig.parts);
    let dir = root.join(&rig.id);
    let uses_fill = rig.fill.as_ref().is_some_and(|f| f.image.is_some());
    if uses_fill && !dir.join(FILL_FILE).is_file() {
        return Err("The AI fill image is missing; generate it again".into());
    }
    write_rig(&dir, &rig)?;
    if !uses_fill {
        let _ = std::fs::remove_file(dir.join(FILL_FILE)); // no longer referenced
    }
    Ok(rig)
}

/// Stores the AI fill image of a character (`fill.png`, written atomically). PNG only, same limits as the image.
pub fn save_fill(root: &Path, id: &str, png: &[u8]) -> Result<(), String> {
    load(root, id)?;
    if png.len() as u64 > MAX_IMAGE_BYTES {
        return Err("The fill image is too large".into());
    }
    if sniff_image(png)?.0 != "png" {
        return Err("The fill image must be a PNG".into());
    }
    crate::config::write_atomic(&root.join(id).join(FILL_FILE), png)
}

/// The stored AI fill image of a character.
pub fn fill(root: &Path, id: &str) -> Result<Vec<u8>, String> {
    let rig = load(root, id)?;
    if !rig.fill.is_some_and(|f| f.image.is_some()) {
        return Err("This character has no AI fill".into());
    }
    std::fs::read(root.join(id).join(FILL_FILE)).map_err(|e| format!("Cannot read the fill image: {e}"))
}

pub fn rename(root: &Path, id: &str, name: &str) -> Result<Rig, String> {
    let rig = load(root, id)?;
    save(root, Rig { name: name.to_string(), ..rig })
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    let dir = root.join(id);
    if !dir.join(RIG_FILE).is_file() {
        return Err("No such character".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))
}

pub fn image(root: &Path, id: &str) -> Result<Vec<u8>, String> {
    let rig = load(root, id)?;
    std::fs::read(root.join(id).join(&rig.image.file)).map_err(|e| format!("Cannot read the character image: {e}"))
}

// ---------- commands ----------

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_dir(app)?.join("avatars"))
}

#[tauri::command]
pub fn avatar_list(app: AppHandle) -> Result<Vec<Rig>, String> {
    Ok(list(&root(&app)?))
}

/// `path` is the file the user picked in the open dialog; only its bytes are used (type checked by magic bytes).
#[tauri::command]
pub async fn avatar_import_image(app: AppHandle, path: String) -> Result<Rig, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || import(&root, Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn avatar_load(app: AppHandle, id: String) -> Result<Rig, String> {
    load(&root(&app)?, &id)
}

#[tauri::command]
pub fn avatar_save(app: AppHandle, rig: Rig) -> Result<Rig, String> {
    save(&root(&app)?, rig)
}

#[tauri::command]
pub fn avatar_rename(app: AppHandle, id: String, name: String) -> Result<Rig, String> {
    rename(&root(&app)?, &id, &name)
}

#[tauri::command]
pub fn avatar_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete(&root(&app)?, &id)
}

/// Raw image bytes of a character (shown as a blob URL in the UI and the avatar window).
#[tauri::command]
pub async fn avatar_image(app: AppHandle, id: String) -> Result<Response, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || image(&root, &id)).await.map_err(|e| e.to_string())?.map(Response::new)
}

/// Raw PNG bytes of the character's AI fill (the avatar window draws it under moved parts).
#[tauri::command]
pub async fn avatar_fill(app: AppHandle, id: String) -> Result<Response, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || fill(&root, &id)).await.map_err(|e| e.to_string())?.map(Response::new)
}

/// Stores the AI fill (raw body: PNG bytes; header `x-id`). The editor calls it right before saving the rig.
#[tauri::command]
pub async fn avatar_save_fill(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(png) = request.body() else {
        return Err("Expected raw PNG bytes".into());
    };
    let id = request.headers().get("x-id").and_then(|v| v.to_str().ok()).ok_or("Missing header x-id")?.to_string();
    let (root, png) = (root(&app)?, png.clone());
    tauri::async_runtime::spawn_blocking(move || save_fill(&root, &id, &png)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }

    fn tmp_root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("talkerbox-rig-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn import_png(root: &Path, file: &str, w: u32, h: u32) -> Rig {
        let src = root.join(file);
        std::fs::write(&src, png(w, h)).unwrap();
        import(&root.join("avatars"), &src).unwrap()
    }

    fn part(id: &str, role: Role) -> Part {
        Part { id: id.into(), role, polygon: vec![[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], pivot: [0.15, 0.15], z: 0, parent: None, label: None, lid: None }
    }

    #[test]
    fn sniffs_png_jpeg_webp() {
        assert_eq!(sniff_image(&png(640, 480)).unwrap(), ("png", 640, 480));
        // SOI, APP0 (len 4), SOF0 with height 300, width 200.
        let jpg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0x01, 0x2C, 0, 0xC8, 3];
        assert_eq!(sniff_image(&jpg).unwrap(), ("jpg", 200, 300));
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        vp8x.extend([0x7F, 0x02, 0, 0xDF, 0x01, 0]); // 640 x 480 stored minus one
        assert_eq!(sniff_image(&vp8x).unwrap(), ("webp", 640, 480));
        let mut vp8 = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\x9d\x01\x2a".to_vec();
        vp8.extend(100u16.to_le_bytes());
        vp8.extend(50u16.to_le_bytes());
        assert_eq!(sniff_image(&vp8).unwrap(), ("webp", 100, 50));
        let mut vp8l = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        vp8l.extend((99u32 | (49 << 14)).to_le_bytes());
        assert_eq!(sniff_image(&vp8l).unwrap(), ("webp", 100, 50));
    }

    #[test]
    fn rejects_bad_images() {
        assert!(sniff_image(b"GIF89a....").is_err());
        assert!(sniff_image(b"<svg xmlns=...").is_err());
        assert!(sniff_image(&png(640, 480)[..20]).is_err());
        assert!(sniff_image(&png(0, 10)).is_err());
        assert!(sniff_image(&png(MAX_SIDE + 1, 10)).is_err());
        assert!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 4]).is_err());
    }

    /// SOI, APP1 Exif with one orientation entry in IFD0, SOF0 with height 300 and width 200.
    fn exif_jpeg(orientation: u16, big_endian: bool) -> Vec<u8> {
        let b16 = |v: u16| if big_endian { v.to_be_bytes() } else { v.to_le_bytes() };
        let b32 = |v: u32| if big_endian { v.to_be_bytes() } else { v.to_le_bytes() };
        let mut p = b"Exif\0\0".to_vec();
        p.extend(if big_endian { b"MM\0*" } else { b"II*\0" });
        p.extend(b32(8));
        p.extend(b16(1));
        p.extend(b16(0x0112));
        p.extend(b16(3));
        p.extend(b32(1));
        p.extend(b16(orientation));
        p.extend([0; 6]);
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE1];
        b.extend(u16::try_from(p.len() + 2).unwrap().to_be_bytes());
        b.extend(p);
        b.extend([0xFF, 0xC0, 0, 17, 8, 0x01, 0x2C, 0, 0xC8, 3]);
        b
    }

    #[test]
    fn jpeg_exif_rotation_swaps_size() {
        for be in [false, true] {
            for o in 1..=4 {
                assert_eq!(sniff_image(&exif_jpeg(o, be)).unwrap(), ("jpg", 200, 300), "orientation {o}");
            }
            for o in 5..=8 {
                assert_eq!(sniff_image(&exif_jpeg(o, be)).unwrap(), ("jpg", 300, 200), "orientation {o}");
            }
        }
        // Truncated or foreign APP1 payloads are ignored.
        assert_eq!(exif_orientation(b"Exif\0\0II*\0\xff\0\0\0"), None);
        assert_eq!(exif_orientation(b"http://ns.adobe.com/xap/1.0/\0"), None);
        assert_eq!(exif_orientation(&exif_jpeg(6, false)[6..]), Some(6));
    }

    #[test]
    fn ids_are_sanitised() {
        assert!(valid_id("anna") && valid_id("anna-2") && valid_id("x1"));
        for bad in ["", "..", "../x", "a/b", "a\\b", "Anna", "a.b", "-a", "a-", ".import-a", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn validation() {
        let root = tmp_root("validate");
        let good = import_png(&root, "Anna.png", 64, 32);
        assert!(validate(&good).is_ok());
        let bad = |f: &dyn Fn(&mut Rig)| {
            let mut r = good.clone();
            f(&mut r);
            validate(&r).is_err()
        };
        assert!(bad(&|r| r.version = 2));
        assert!(bad(&|r| r.id = "../evil".into()));
        assert!(bad(&|r| r.name = "  ".into()));
        assert!(bad(&|r| r.name = "a\nb".into()));
        assert!(bad(&|r| r.image.file = "../../secret.png".into()));
        assert!(bad(&|r| r.image.file = "C:\\x\\image.png".into()));
        assert!(bad(&|r| r.image.width = 0));
        assert!(bad(&|r| r.mask.points = vec![[0.1, 0.1], [0.2, 0.2]]));
        assert!(bad(&|r| r.mask.points = vec![[0.1, 0.1], [0.2, 0.2], [1.5, 0.2]]));
        assert!(bad(&|r| r.mask.points = vec![[0.1, 0.1], [0.2, 0.2], [f64::NAN, 0.2]]));
        assert!(bad(&|r| r.mask.points = vec![[0.5, 0.5]; MAX_MASK_POINTS + 1]));
        assert!(bad(&|r| r.mask.smooth = Some(1.5)));
        assert!(bad(&|r| r.mask.snap = Some(f64::NAN)));
        assert!(!bad(&|r| r.mask = Mask { smooth: Some(1.0), snap: Some(0.0), ..Mask::default() }));
        assert!(bad(&|r| r.parts = vec![part("a", Role::EyeL), part("a", Role::EyeR)]));
        assert!(bad(&|r| r.parts = vec![part("A b", Role::EyeL)]));
        assert!(bad(&|r| r.parts = (0..=MAX_PARTS).map(|i| part(&format!("p{i}"), Role::Custom)).collect()));
        assert!(bad(&|r| r.parts = vec![Part { pivot: [f64::INFINITY, 0.0], ..part("a", Role::Head) }]));
        assert!(bad(&|r| r.parts = vec![Part { parent: Some("x".into()), ..part("a", Role::Head) }]));
        assert!(bad(&|r| r.parts = vec![Part { parent: Some("b".into()), ..part("a", Role::Head) }, Part { parent: Some("a".into()), ..part("b", Role::Body) }]));
        assert!(!bad(&|r| r.parts = vec![part("body", Role::Body), Part { parent: Some("body".into()), ..part("head", Role::Head) }]));
        assert!(bad(&|r| r.mouth = Some(Mouth { states: vec![MouthState { id: "open".into(), polygon: vec![[0.1, 0.1]] }], ..Mouth::default() })));
        // Phase 4 fields: one part per role (custom may repeat), labels, colours, open-mouth shape.
        assert!(bad(&|r| r.parts = vec![part("a", Role::ArmL), part("b", Role::ArmL)]));
        assert!(!bad(&|r| r.parts = vec![part("a", Role::Custom), part("b", Role::Custom)]));
        assert!(!bad(&|r| r.parts = vec![Part { label: Some("Left eye".into()), lid: Some("#a1B2c3".into()), ..part("e", Role::EyeL) }]));
        assert!(bad(&|r| r.parts = vec![Part { label: Some(" ".into()), ..part("e", Role::EyeL) }]));
        assert!(bad(&|r| r.parts = vec![Part { label: Some("x".repeat(81)), ..part("e", Role::EyeL) }]));
        assert!(bad(&|r| r.parts = vec![Part { lid: Some("red".into()), ..part("e", Role::EyeL) }]));
        assert!(bad(&|r| r.parts = vec![Part { lid: Some("#12345g".into()), ..part("e", Role::EyeL) }]));
        let tri = vec![[0.4, 0.6], [0.6, 0.6], [0.5, 0.7]];
        assert!(!bad(&|r| r.mouth = Some(Mouth { interior: Some(tri.clone()), color: Some("#301010".into()), ..Mouth::default() })));
        assert!(bad(&|r| r.mouth = Some(Mouth { interior: Some(vec![[0.4, 0.6], [0.6, 0.6]]), ..Mouth::default() })));
        assert!(bad(&|r| r.mouth = Some(Mouth { interior: Some(vec![[0.4, 0.6], [0.6, 0.6], [0.5, 1.2]]), ..Mouth::default() })));
        assert!(bad(&|r| r.mouth = Some(Mouth { interior: Some(vec![[0.5, 0.5]; MAX_POLYGON_POINTS + 1]), ..Mouth::default() })));
        assert!(bad(&|r| r.mouth = Some(Mouth { color: Some("#fff".into()), ..Mouth::default() })));
        // Phase 6 lips: both or neither, in the image, corners and warp in range; JSON uses camelCase.
        let up = vec![[0.4, 0.6], [0.6, 0.6], [0.5, 0.58]];
        let lips = |l: Vec<Point>| Mouth { lip_upper: Some(up.clone()), lip_lower: Some(l), ..Mouth::default() };
        assert!(!bad(&|r| r.mouth = Some(Mouth { corners: Some([[0.4, 0.6], [0.6, 0.6]]), warp: Some(0.0), ..lips(tri.clone()) })));
        assert!(bad(&|r| r.mouth = Some(Mouth { lip_upper: Some(up.clone()), ..Mouth::default() })));
        assert!(bad(&|r| r.mouth = Some(Mouth { lip_lower: Some(up.clone()), ..Mouth::default() })));
        assert!(bad(&|r| r.mouth = Some(lips(vec![[0.4, 0.6], [0.6, 0.6]]))));
        assert!(bad(&|r| r.mouth = Some(lips(vec![[0.4, 0.6], [0.6, 0.6], [0.5, f64::NAN]]))));
        assert!(bad(&|r| r.mouth = Some(lips(vec![[0.5, 0.5]; MAX_POLYGON_POINTS + 1]))));
        assert!(bad(&|r| r.mouth = Some(Mouth { corners: Some([[0.4, 0.6], [1.2, 0.6]]), ..lips(tri.clone()) })));
        for w in [-0.1, 1.5, f64::NAN, f64::INFINITY] {
            assert!(bad(&|r| r.mouth = Some(Mouth { warp: Some(w), ..Mouth::default() })), "{w}");
        }
        let json = r#"{"states":[],"lipUpper":[[0.4,0.6],[0.6,0.6],[0.5,0.58]],"lipLower":[[0.4,0.6],[0.6,0.6],[0.5,0.63]],"corners":[[0.4,0.6],[0.6,0.6]],"warp":0.5}"#;
        let m: Mouth = serde_json::from_str(json).unwrap();
        assert_eq!((m.lip_lower.as_ref().map(Vec::len), m.warp), (Some(3), Some(0.5)));
        assert_eq!(serde_json::to_string(&m).unwrap(), json);
        assert!(serde_json::from_str::<Mouth>(r#"{"corners":[[0.1,0.1]]}"#).is_err());
        // Files written before these fields existed still load.
        let old = r#"{"version":1,"id":"a","name":"A","kind":"portrait","image":{"file":"image.png","width":2,"height":2},
            "parts":[{"id":"m","role":"mouth","polygon":[[0.1,0.1],[0.2,0.1],[0.2,0.2]],"pivot":[0.1,0.1]}],
            "mouth":{"states":[]},"createdAt":1,"updatedAt":1}"#;
        assert!(validate(&serde_json::from_str::<Rig>(old).unwrap()).is_ok());
        // Unknown roles and kinds are rejected by the parser.
        let json = serde_json::to_string(&good).unwrap().replace("\"portrait\"", "\"robot\"");
        assert!(serde_json::from_str::<Rig>(&json).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn kind_follows_limbs() {
        assert_eq!(derive_kind(&[part("e", Role::EyeL), part("m", Role::Mouth)]), Kind::Portrait);
        assert_eq!(derive_kind(&[part("a", Role::ArmL)]), Kind::Fullbody);
        assert_eq!(derive_kind(&[part("l", Role::LegR)]), Kind::Fullbody);
    }

    #[test]
    fn import_save_load_roundtrip() {
        let root = tmp_root("roundtrip");
        let avatars = root.join("avatars");
        let rig = import_png(&root, "My Hero!.png", 300, 400);
        assert_eq!((rig.id.as_str(), rig.name.as_str(), rig.kind), ("my-hero", "My Hero!", Kind::Portrait));
        assert_eq!(rig.image, Image { file: "image.png".into(), width: 300, height: 400 });
        assert_eq!(image(&avatars, &rig.id).unwrap(), png(300, 400));
        assert_eq!(load(&avatars, &rig.id).unwrap(), rig);
        // No temporary folder is left behind.
        assert_eq!(std::fs::read_dir(&avatars).unwrap().count(), 1);

        // The UI cannot change id-bound fields: image and createdAt come from disk, kind is derived.
        let edited = Rig {
            image: Image { file: "image.webp".into(), width: 1, height: 1 },
            created_at: 1,
            kind: Kind::Portrait,
            parts: vec![part("arm", Role::ArmL)],
            mask: Mask {
                points: vec![[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]],
                smoothed: Some(vec![[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]]),
                smooth: Some(0.5),
                snap: Some(0.0),
            },
            ..rig.clone()
        };
        let saved = save(&avatars, edited).unwrap();
        assert_eq!(saved.image, rig.image);
        assert_eq!(saved.created_at, rig.created_at);
        assert_eq!(saved.kind, Kind::Fullbody);
        assert!(saved.updated_at >= rig.updated_at);
        assert_eq!(load(&avatars, &rig.id).unwrap(), saved);

        assert_eq!(rename(&avatars, &rig.id, "  Zed ").unwrap().name, "Zed");
        assert!(rename(&avatars, &rig.id, "").is_err());
        assert!(save(&avatars, Rig { id: "missing".into(), ..saved.clone() }).is_err());

        delete(&avatars, &rig.id).unwrap();
        assert!(load(&avatars, &rig.id).is_err());
        assert!(delete(&avatars, &rig.id).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fill_is_validated_stored_and_cleaned_up() {
        let root = tmp_root("fill");
        let avatars = root.join("avatars");
        let rig = import_png(&root, "f.png", 40, 30);
        let ok = |f: Fill| validate(&Rig { fill: Some(f), ..rig.clone() });
        let ai = Fill { mode: FillMode::Ai, image: Some(FILL_FILE.into()), rect: Some([0.1, 0.2, 0.5, 0.9]), sig: Some("0a1b2c3d".into()) };
        assert!(ok(Fill { mode: FillMode::Transparent, ..Fill::default() }).is_ok());
        assert!(ok(ai.clone()).is_ok());
        assert!(ok(Fill { image: Some("../x.png".into()), ..ai.clone() }).is_err());
        assert!(ok(Fill { rect: None, ..ai.clone() }).is_err(), "image without area");
        assert!(ok(Fill { image: None, ..ai.clone() }).is_err(), "area without image");
        assert!(ok(Fill { rect: Some([0.5, 0.2, 0.1, 0.9]), ..ai.clone() }).is_err());
        assert!(ok(Fill { rect: Some([0.0, 0.0, 1.0, f64::NAN]), ..ai.clone() }).is_err());
        assert!(ok(Fill { sig: Some("not hex!".into()), ..ai.clone() }).is_err());
        // JSON: lowercase modes, old rigs without `fill` still load (covered by the old-format test).
        assert_eq!(serde_json::from_str::<Fill>(r#"{"mode":"classic"}"#).unwrap().mode, FillMode::Classic);
        assert!(serde_json::from_str::<Fill>(r#"{"mode":"blur"}"#).is_err());

        // The image must be stored before a rig may reference it; dropping the reference deletes it.
        assert!(save(&avatars, Rig { fill: Some(ai.clone()), ..rig.clone() }).unwrap_err().contains("missing"));
        assert!(save_fill(&avatars, &rig.id, b"GIF89a....").is_err(), "PNG only");
        save_fill(&avatars, &rig.id, &png(10, 10)).unwrap();
        let saved = save(&avatars, Rig { fill: Some(ai.clone()), ..rig.clone() }).unwrap();
        assert_eq!(fill(&avatars, &rig.id).unwrap(), png(10, 10));
        assert_eq!(load(&avatars, &rig.id).unwrap().fill, Some(ai));
        save(&avatars, Rig { fill: Some(Fill { mode: FillMode::Classic, ..Fill::default() }), ..saved }).unwrap();
        assert!(!avatars.join(&rig.id).join(FILL_FILE).exists());
        assert!(fill(&avatars, &rig.id).is_err());
        assert!(save_fill(&avatars, "missing", &png(1, 1)).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn path_traversal_is_rejected() {
        let root = tmp_root("traversal");
        let avatars = root.join("avatars");
        let rig = import_png(&root, "a.png", 10, 10);
        for id in ["..", "../avatars/a", "a/../a", "C:\\Windows"] {
            assert!(load(&avatars, id).is_err() && delete(&avatars, id).is_err() && image(&avatars, id).is_err(), "{id}");
        }
        // A tampered rig.json pointing outside its folder is refused on load.
        let f = avatars.join(&rig.id).join(RIG_FILE);
        let json = std::fs::read_to_string(&f).unwrap().replace("image.png", "../../a.png");
        std::fs::write(&f, json).unwrap();
        assert!(load(&avatars, &rig.id).is_err() && image(&avatars, &rig.id).is_err());
        // A rig.json whose id differs from its folder is refused too.
        let json = std::fs::read_to_string(&f).unwrap().replace("../../a.png", "image.png").replace("\"id\": \"a\"", "\"id\": \"b\"");
        std::fs::write(&f, json).unwrap();
        assert!(load(&avatars, &rig.id).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn import_rejects_non_images_and_oversize() {
        let root = tmp_root("reject");
        let src = root.join("x.png");
        std::fs::write(&src, b"not an image").unwrap();
        assert!(import(&root.join("avatars"), &src).is_err());
        let big = std::fs::File::create(&src).unwrap();
        big.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        drop(big);
        assert!(import(&root.join("avatars"), &src).unwrap_err().contains("larger"));
        assert_eq!(list(&root.join("avatars")).len(), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn list_is_sorted_and_skips_junk() {
        let root = tmp_root("list");
        let avatars = root.join("avatars");
        import_png(&root, "bob.png", 10, 10);
        import_png(&root, "Alice.png", 10, 10);
        import_png(&root, "alice.png", 10, 10);
        std::fs::create_dir_all(avatars.join("junk")).unwrap();
        std::fs::write(avatars.join("junk").join(RIG_FILE), "{}").unwrap();
        std::fs::create_dir_all(avatars.join(".import-x")).unwrap();
        let ids: Vec<String> = list(&avatars).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["alice", "alice-2", "bob"]);
        let _ = std::fs::remove_dir_all(root);
    }
}
