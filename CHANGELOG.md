# Changelog

All notable changes to Talkerbox. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

## [Unreleased]

## [0.5.0] - 2026-11-13

### Added
- **Remove speech input models**: each installed Vosk model on the Speech page shows its size on disk and has a
  delete button (with a confirmation that names the re-download size). Removal is refused while speech input is
  listening with that model.
- **Background under moved parts**: per character, choose what shows where an arm, hand or leg was before it moved:
  the original picture, transparent, a smooth classic fill, or an AI fill (LaMa, offline after a one-time download of
  about 93 MB, generated once in the part editor and saved with the character). Arms crossing the body no longer leave
  a copy behind.
- **Detect face parts**: "Face" in the part editor finds both eyes and the mouth with its upper and lower lip and the
  mouth corners in one click (MediaPipe face landmarks, offline after a one-time download of about 5 MB, removable).
  The parts are added as one undo step and can be adjusted like drawn ones; parts you already have are kept. Made for
  photos and realistic paintings; on cartoons the face is often not found or the eyes come out too flat (use Pick).
- **Third-party notices**: `THIRD_PARTY_NOTICES.md` lists every bundled and downloadable third-party component with
  its licence and copyright holder, includes the required licence texts and explains the GPL status of the TTS
  sidecar. The installer places it next to `talkerbox.exe`.

### Fixed
- Build guide: the sidecar exe is about 38 MB (not 48 MB); `npm ci` is its own step before the dev run and the
  build; notes that `tauri dev` needs port 1420, that `cargo test` prints one harmless LNK4199 warning, and that
  the build downloads packages but no model or voice files.

### Security
- The avatar window may now only call the commands it needs (load a character, read its image and fill, report ready)
  and listen for events; every other app command, event emitting and window or plugin API is rejected for it. The
  main window keeps access to all app commands.

## [0.4.0] - 2026-11-13

### Added
- **Talking avatar window**: a second window with a figure that talks along with the spoken replies. Its mouth
  follows the loudness of the speech in sync with the audio; it blinks, sways and gestures with its arms and legs
  while it speaks. Background: app theme, green screen or fully transparent, with an opacity slider; position and
  size are remembered. Windows "reduce motion" turns off sway and gestures. A built-in demo figure is shown until
  you add your own.
- **Your own characters**: import a PNG, JPEG or WebP picture (portrait or full figure), rename, delete and choose the
  character the avatar window shows. "Test speech" shows the avatar talking without a chat.
- **Mask editor**: cut the figure out with polygon, brush and magic wand tools, smooth the outline and snap it to
  the image edges; preview the cut-out on a checkerboard, green or dark background; undo, redo, zoom and pan.
- **Smart select** in the mask editor: click the figure and an on-device AI model (MobileSAM) proposes its outline;
  refine it with background clicks or a box, then add it to the mask or cut it out. Runs offline on the CPU after a
  one-time download of about 60 MB (model and ONNX Runtime, checked against fixed checksums); the download can be
  removed again on the Avatar page or from the Smart select bar.
- **Part editor**: mark eyes, mouth, arms, hands, legs, head, body and custom parts with outlines and pivots, attach
  parts to each other (a hand moves with its arm), set the drawing order and eyelid colour, and preview the
  animation with sliders or a demo.
- **Pick parts with Smart select**: choose a role, click the part, and the proposed outline becomes the part with a
  fitting pivot; after a mouth, the editor offers to split it into lips.
- **Lip-sync with mouth shapes**: the avatar's mouth takes the shape of the sounds (open, wide, round, nearly
  closed for F, V, S), analysed from the speech audio for every voice and language.
- **Lips with face warp**: outline the upper and lower lip (or let "Auto-split" derive them from the mouth); the
  lips part naturally and cheeks and chin follow, with an adjustable face-warp strength.
- **Avatar page** in the sidebar with the avatar window options, the character list, the editors and the Smart
  select model card.

### Changed
- The avatar options moved from the Speech page to the new Avatar page.

## [0.3.0] - 2026-11-12

### Added
- **Offline speech input** with Vosk (German or English): dictate with the microphone button, see the live
  transcript in the message box, and the text is sent after a pause; the speech model is downloaded on demand.
- **Keep listening**: hold the microphone button for 5 seconds to stay in continuous listening; every pause (or a
  sentence end after about 100 words) sends the text.
- **Microphone menu**: right-click the microphone button to choose the input device.
- **Ollama autostart**: the Ollama server starts automatically when Talkerbox opens (can be switched off on the
  Server page).
- Replies being read aloud are not picked up by the microphone.

### Changed
- Updated build documentation.

## [0.2.0] - 2026-11-12

### Changed
- **New interface**: a sidebar with Chat, Models, Speech and Server pages that collapses to an icon rail on narrow
  windows, a light/dark mode switch (follows Windows by default), buttons that shorten their labels or become icons
  when space runs out, and a minimum window size of 720 x 520.

## [0.1.0] - 2026-11-12

First early release.

### Added
- **Chat with a local LLM** through Ollama: streamed replies, model picker, stop button and live tokens per second.
- **Ollama control**: start and stop the server from the status light, a read-only server log, and a dialog to set
  the Ollama location if it is not found.
- **Model downloads** from Hugging Face links, `hf.co/user/repo[:quant]`, library names or direct `.gguf` URLs, with
  resume; short readable model names.
- **Spoken replies** with the bundled Kokoro speech engine: replies are read sentence by sentence, with a speak
  toggle, a replay button per reply, a speed slider and a voice picker with language flags. Code blocks are not read
  aloud.
- **Extra voices** (`.pt`, `.npy`, `.npz`, `.bin`) from a link.
- **Language packs** (Kokoro fine-tunes for other languages) and one-click German voices Martin and Kerstin, with a
  hint when a voice falls back to the base model.
- Explanatory tooltips on all controls.
- Size-optimised installer (per-user install, no admin rights).

### Security
- The speech engine only accepts local requests (local Host header, JSON content type) and rejects oversized or
  malformed voice files.

[Unreleased]: https://github.com/Grownz/Talkerbox/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Grownz/Talkerbox/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Grownz/Talkerbox/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Grownz/Talkerbox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Grownz/Talkerbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Grownz/Talkerbox/releases/tag/v0.1.0
