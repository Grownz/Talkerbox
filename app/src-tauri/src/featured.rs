//! Curated language packs that install with one click. They end up as normal packs (pack.json in `tts/packs/<id>`).
//!
//! Decisions (verified against the HuggingFace file trees and by test synthesis with the sidecar):
//! - Kerstin's voice ships as headerless little-endian float32 (510x1x256). The sidecar only reads raw `.bin`
//!   as npz, so the installer converts it to a `.npy` (see `raw_f32_to_npy`).
//! - Kerstin's tokenizer.json vocab equals kokoro-onnx's built-in vocab plus the `$` pad token at id 0, which
//!   kokoro-onnx already uses for padding, so no vocab file is needed. Martin ships no vocab either.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Convert {
    None,
    /// Headerless little-endian float32 voice of shape (510, 1, 256) -> `.npy`.
    RawStyleToNpy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturedFile {
    pub url: &'static str,
    /// Exact size in bytes from the repository listing; downloads must match it.
    pub size: u64,
    /// File name inside the pack folder (after conversion).
    pub file: &'static str,
    #[serde(skip)]
    pub convert: Convert,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Featured {
    pub id: &'static str,
    pub name: &'static str,
    pub language: &'static str,
    pub license: &'static str,
    pub source: &'static str,
    pub model: FeaturedFile,
    pub voices: &'static [FeaturedFile],
}

pub static FEATURED: [Featured; 2] = [
    Featured {
        id: "de-martin",
        name: "German - Martin (male)",
        language: "de",
        license: "Apache-2.0",
        source: "https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin",
        model: FeaturedFile {
            url: "https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin/resolve/main/kokoro-martin.onnx",
            size: 325_512_630,
            file: "kokoro-martin.onnx",
            convert: Convert::None,
        },
        voices: &[FeaturedFile {
            url: "https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin/resolve/main/voices-martin.npz",
            size: 522_506,
            file: "voices-martin.npz",
            convert: Convert::None,
        }],
    },
    Featured {
        id: "de-kerstin",
        name: "German - Kerstin (female)",
        language: "de",
        license: "Apache-2.0",
        source: "https://huggingface.co/crane-local-ai/Kokoro-82M-v1.0-German-ONNX",
        model: FeaturedFile {
            url: "https://huggingface.co/crane-local-ai/Kokoro-82M-v1.0-German-ONNX/resolve/main/onnx/model.onnx",
            size: 336_987_079,
            file: "model.onnx",
            convert: Convert::None,
        },
        voices: &[FeaturedFile {
            url: "https://huggingface.co/crane-local-ai/Kokoro-82M-v1.0-German-ONNX/resolve/main/voices/df_kerstin.bin",
            size: 522_240,
            file: "df_kerstin.npy",
            convert: Convert::RawStyleToNpy,
        }],
    },
];

pub fn find(id: &str) -> Option<&'static Featured> {
    FEATURED.iter().find(|f| f.id == id)
}

const STYLE_SHAPE: (usize, usize, usize) = (510, 1, 256);

/// Wraps raw little-endian float32 style data of shape (510, 1, 256) in an NPY v1.0 header.
pub fn raw_f32_to_npy(raw: &[u8]) -> Result<Vec<u8>, String> {
    let (a, b, c) = STYLE_SHAPE;
    let expected = a * b * c * 4;
    if raw.len() != expected {
        return Err(format!("voice data has {} bytes, expected {expected} (510x1x256 float32)", raw.len()));
    }
    let dict = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': ({a}, {b}, {c}), }}");
    // magic(6) + version(2) + header length(2) + dict + padding + '\n' must be a multiple of 64.
    let unpadded = 10 + dict.len() + 1;
    let header_len = dict.len() + 1 + (64 - unpadded % 64) % 64;
    let mut out = Vec::with_capacity(10 + header_len + raw.len());
    out.extend_from_slice(b"\x93NUMPY\x01\x00");
    out.extend_from_slice(&(header_len as u16).to_le_bytes());
    out.extend_from_slice(dict.as_bytes());
    out.resize(10 + header_len - 1, b' ');
    out.push(b'\n');
    out.extend_from_slice(raw);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npy_header_is_valid_and_aligned() {
        let raw: Vec<u8> = (0..510 * 256).flat_map(|i| (i as f32).to_le_bytes()).collect();
        let npy = raw_f32_to_npy(&raw).unwrap();
        assert_eq!(&npy[..8], b"\x93NUMPY\x01\x00");
        let hlen = u16::from_le_bytes([npy[8], npy[9]]) as usize;
        assert_eq!((10 + hlen) % 64, 0);
        let header = std::str::from_utf8(&npy[10..10 + hlen]).unwrap();
        assert!(header.starts_with("{'descr': '<f4', 'fortran_order': False, 'shape': (510, 1, 256), }"));
        assert!(header.ends_with('\n'));
        assert_eq!(&npy[10 + hlen..], &raw[..]);
    }

    #[test]
    fn npy_rejects_wrong_size() {
        assert!(raw_f32_to_npy(&[0u8; 100]).is_err());
    }

    #[test]
    fn featured_list_is_consistent() {
        for f in &FEATURED {
            assert!(crate::packs::slug(f.id) == f.id, "id must be a valid slug: {}", f.id);
            assert!(f.model.file.ends_with(".onnx") && f.model.url.starts_with("https://huggingface.co/"));
            for v in f.voices {
                if v.convert == Convert::RawStyleToNpy {
                    assert_eq!(v.size, 510 * 256 * 4);
                    assert!(v.file.ends_with(".npy"));
                }
            }
        }
        assert!(find("de-kerstin").is_some() && find("nope").is_none());
    }
}
