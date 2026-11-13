// Main third-party components for the About page, taken from THIRD_PARTY_NOTICES.md (the full list and licence texts).
// Every link must use a host listed in src-tauri/src/links.rs (a Rust test checks this file).

export const REPO_URL = 'https://github.com/Grownz/Talkerbox'
export const LICENSE_URL = 'https://github.com/Grownz/Talkerbox/blob/main/LICENSE'
export const NOTICES_URL = 'https://github.com/Grownz/Talkerbox/blob/main/THIRD_PARTY_NOTICES.md'

export interface Component {
  name: string
  licence: string
  /** Project home or licence page (https). */
  url: string
  /** In the installer, or downloaded on request in the app. */
  source: 'shipped' | 'download'
}

export const COMPONENTS: Component[] = [
  { name: 'Tauri and other Rust crates', licence: 'MIT OR Apache-2.0 (a few MPL-2.0, BSD, Zlib, ISC)', url: 'https://github.com/tauri-apps/tauri', source: 'shipped' },
  { name: 'Svelte', licence: 'MIT', url: 'https://github.com/sveltejs/svelte', source: 'shipped' },
  { name: 'flag-icons', licence: 'MIT', url: 'https://github.com/lipis/flag-icons', source: 'shipped' },
  { name: 'markdown-it', licence: 'MIT (its entities tables: BSD-2-Clause)', url: 'https://github.com/markdown-it/markdown-it', source: 'shipped' },
  { name: 'Vosk API', licence: 'Apache-2.0', url: 'https://github.com/alphacep/vosk-api', source: 'shipped' },
  { name: 'GCC runtime libraries', licence: 'GPL-3.0-or-later with GCC Runtime Library Exception', url: 'https://gcc.gnu.org', source: 'shipped' },
  { name: 'eSpeak NG (TTS sidecar)', licence: 'GPL-3.0-or-later', url: 'https://github.com/espeak-ng/espeak-ng', source: 'shipped' },
  { name: 'phonemizer (TTS sidecar)', licence: 'GPL-3.0-or-later', url: 'https://github.com/bootphon/phonemizer', source: 'shipped' },
  { name: 'kokoro-onnx', licence: 'MIT', url: 'https://github.com/thewh1teagle/kokoro-onnx', source: 'shipped' },
  { name: 'ONNX Runtime', licence: 'MIT', url: 'https://github.com/microsoft/onnxruntime', source: 'shipped' },
  { name: 'NumPy', licence: 'BSD-3-Clause', url: 'https://github.com/numpy/numpy', source: 'shipped' },
  { name: 'Python runtime', licence: 'PSF-2.0', url: 'https://docs.python.org/3/license.html', source: 'shipped' },
  { name: 'PyInstaller bootloader', licence: 'GPL-2.0-or-later with bootloader exception', url: 'https://github.com/pyinstaller/pyinstaller', source: 'shipped' },
  { name: 'Kokoro-82M model and voices', licence: 'Apache-2.0', url: 'https://huggingface.co/hexgrad/Kokoro-82M', source: 'download' },
  { name: 'Vosk speech models', licence: 'Apache-2.0', url: 'https://alphacephei.com/vosk/models', source: 'download' },
  { name: 'MobileSAM (Smart select)', licence: 'Apache-2.0', url: 'https://github.com/ChaoningZhang/MobileSAM', source: 'download' },
  { name: 'LaMa inpainting (AI fill)', licence: 'Apache-2.0', url: 'https://github.com/advimman/lama', source: 'download' },
  { name: 'MediaPipe face models', licence: 'Apache-2.0', url: 'https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker', source: 'download' },
]
