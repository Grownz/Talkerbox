# Changelog

All notable changes to Talkerbox. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

## [Unreleased]

## [0.6.0] - 2026-11-13

### Added
- **Dock the avatar into the main window**: a new button in the avatar window's title bar moves the avatar into the
  left sidebar, above the Ollama status, scaled to the sidebar width (also on the narrow icon rail). It keeps talking,
  blinking and moving, uses the sidebar background, and stops drawing while the app is minimised. Double-click it (or
  focus it and press Enter) to open the avatar window again where it was. A docked avatar is restored at the next
  start; the Avatar switch hides it.
- **Markdown in chat replies**: replies that use Markdown are shown formatted: headings, bold and italic, lists,
  quotes, inline code, code blocks (monospaced, scroll sideways, with a Copy button), tables (scroll sideways) and
  rules; plain replies stay plain text. The reply is untrusted model output: HTML in it is shown as text, links show
  their address and are never opened, and images are shown as their description, so nothing is loaded. While a reply
  streams it is redrawn at most about every 90 ms (markdown-it 15.0.3, MIT).
- **Docking makes room**: docking the avatar (or starting with a docked avatar) grows the main window, if needed, to
  show the full-width sidebar with all labels and the whole avatar (at least 1289 px wide; the height follows the
  sidebar). It only grows, stays within the screen (moving the window if needed) and leaves maximised and fullscreen
  windows alone.
- **Thinking models**: models that reason before answering (e.g. Qwen3.5) no longer leave the chat blank while they
  think. The reply shows "Thinking… N s" with the reasoning as it arrives; once the answer starts it collapses to
  "Thought for N s", which you can expand again. The reasoning is plain text: it is never read aloud and never sent
  back to the model. Older-style `<think>…</think>` tags at the start of a reply are split off the same way.
- **Thinking switch**: for models that support thinking (as reported by Ollama), a "Thinking" button next to the
  model picker turns it off, so answers (and speech) start right away. The choice is saved.

### Changed
- **App icon**: the program, taskbar, title bar and installer icon is now the blue sound-bars logo shown at the top of
  the sidebar (was a chat bubble). At 16 to 24 px it shows only the three bars, heavier, so it stays readable.
- **Speech skips more Markdown**: bare URLs, link and image targets, HTML tags, list bullets, rules and table
  separators are no longer read aloud.
- **Avatar window title bar**: the avatar window has its own title bar (dock, minimise, close; drag it to move the
  window, the edges still resize it). With a transparent background below 100 % opacity the title bar fades out and
  comes back while the mouse is over the window.

### Fixed
- **Ollama box in a narrow sidebar**: the "Path…" button no longer sticks out of the Ollama box at some window widths.
  "Log" shrinks to its icon when both labels do not fit, and a long status such as "Running (external)" with the
  version ends in an ellipsis instead of overflowing.
- **Docking the avatar left stray avatar windows behind**: after the dock button closed the avatar window, a settings
  update could open a new one (showing the demo figure) next to the docked avatar, and every further update added
  work. Option changes now only recreate a window that is open (new `puppet_retransparent`), and a window that
  opens while the avatar is docked is closed again.
- **Chat became very slow with the avatar docked**: every keystroke, streamed token and status update re-ran an
  options effect that the docked avatar answered synchronously, until Svelte stopped it after 1000 rounds (about
  0.6 s per update in `tauri dev`; typing and replies lagged by seconds and an error was logged each time). The docked
  avatar now receives its events asynchronously, like the window does, and draws at most 30 frames per second while
  talking and 15 while idle.

## [0.5.1] - 2026-11-13

### Added
- **About & licences page**: an "i" button at the bottom of the sidebar opens a page with the app version, links to
  the GitHub project and the MIT licence, and the main third-party components with their licences and links. "Full
  notices" opens `THIRD_PARTY_NOTICES.md` from the install folder (or on GitHub when it is not there). Links open in
  the default browser; the backend only opens https links to the hosts the page uses.

### Changed
- **Stop button on the reply**: the "Stop speaking" button in the chat header is gone. The reply that is being read
  aloud (or queued for it, also while it streams) shows a red stop button in place of its green play button; it stops
  the audio and the avatar's mouth, and the rest of a streaming reply is no longer spoken. "New chat" also stops
  speech.
- **Narrow chat header**: the voice picker always shows the flag and the voice name (it drops the gender and the
  arrow first, then shortens a long name with an ellipsis), and "New chat" shrinks to its "+" icon before the model
  name and the speed slider get cramped.

### Fixed
- **Triangle cut out of the character**: with lips and face warp, a moving mouth (talking, a viseme, or the demo
  stopped mid-word) cut a transparent triangle from the top left corner of the image to the face out of the picture,
  in the part editor preview and the avatar window. Lip data with invalid numbers now turns the warp off instead of
  drawing a broken mesh.

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

[Unreleased]: https://github.com/Grownz/Talkerbox/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Grownz/Talkerbox/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Grownz/Talkerbox/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Grownz/Talkerbox/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Grownz/Talkerbox/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Grownz/Talkerbox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Grownz/Talkerbox/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Grownz/Talkerbox/releases/tag/v0.1.0
