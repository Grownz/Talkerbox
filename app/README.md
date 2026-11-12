# Talkerbox (desktop app)

Windows desktop chatbot with spoken replies. Tauri v2 (Rust backend), Svelte 5 + TypeScript frontend, Vite.
The LLM comes from a locally installed [Ollama](https://ollama.com), which Talkerbox never installs. Speech comes from the
separate TTS sidecar in `../tts-sidecar` (Kokoro ONNX).

## Features

- **Ollama discovery**: checks `http://127.0.0.1:11434/api/version` first, then looks for `ollama.exe` at the saved
  path, on `PATH`, in `%LOCALAPPDATA%\Programs\Ollama`, and in `C:\Program Files\Ollama`. If none is found, a dialog asks
  for the folder or exe. The path is checked and then saved.
- **Start/stop `ollama serve`**: click the status light in the sidebar or on the Server page (its tooltip says what a click does). Only a server
  that Talkerbox started can be stopped. When the window closes, that server is killed together with its runner
  processes. Spawned processes are also placed in a Windows job object with kill-on-close, so they die even if
  Talkerbox crashes or is killed.
- **Layout**: a left sidebar with Chat, Models, Speech and Server pages and the Ollama status at the bottom. Below
  1024 px window width it collapses to a 64 px icon rail. Toolbar buttons shorten their labels, then become icons
  (tooltip and accessible name stay) when space runs out; text inputs shrink first. The window cannot be made smaller
  than 720 x 520.
- **Light/dark mode**: follows the Windows setting by default. The sun/moon switch at the bottom of the sidebar
  overrides it; the choice is kept in the webview's localStorage.
- **Chat**: streamed replies (`/api/chat`), model picker (`/api/tags`), history kept in memory, stop button.
- **Models**: pull from a HuggingFace link, `hf.co/user/repo[:quant]` or a library name (`/api/pull`, with progress).
  You can also import a `.gguf` from any direct URL: it downloads with resume, is uploaded through `/api/blobs`, and is
  imported through `/api/create` with `files`. The file goes to `gguf\<first 16 hex chars of sha256(url)>\`. A retry
  after a failed import reuses the finished file, and the folder is deleted once Ollama has imported it. Every
  download's partial file is named `<file>.<url hash>.part`, so a resume never mixes data from two URLs. The view
  lists and deletes models and downloads the TTS model files.
- **Short display names**: `hf.co/owner/Repo-GGUF:Q4_K_M` is shown as `Repo Q4_K_M`. GGUF imports from HuggingFace use
  the repo id from the HF API plus the quant parsed from the file name. Other hosts use the file name without its
  extension, cut to 50 characters. Names are stored in settings, keyed by the Ollama id; the id itself never changes.
  For non-HF hosts the page title is not fetched: a direct `.gguf` link has no HTML page, and requesting it would
  download the model.
- **TTS**: the "Speak replies" checkbox starts the sidecar right away. If the start fails, the box unchecks itself and
  the reason is shown. Unchecking stops the sidecar and all speech at once. With the setting on, TTS starts
  automatically when the app opens. Replies are spoken sentence by sentence (queued, played with WebAudio). There is a
  stop button and a speed slider. Each finished assistant reply gets a green play button that re-reads it from the
  start and cancels any current speech. Sentences also end at CJK `。！？`, and any piece over 1500 characters is cut
  at the last space or comma (the sidecar rejects texts over 2000). TTS start, stop and restart run one at a time.
  Stopping closes the sidecar's stdin and waits up to 3 s before killing it: only a clean exit lets the PyInstaller
  exe delete its `%TEMP%\_MEI*` folder. App exit uses the same path, and the job object stays as a safety net.
- **Extra voices**: on the Speech page, "Add model or voice from link" accepts a HuggingFace link (`/blob/` pages are turned into
  `/resolve/` links) or any direct URL to a `.pt`/`.npy`/`.npz`/`.bin` file of at most 50 MB. Files are stored in
  `tts\voices` in the local app data dir. The sidecar gets `--voices-dir` when that folder holds a voice file, and a
  running sidecar is restarted after a voice is added or deleted. The voice id is the file stem, so a link whose stem
  is not `[A-Za-z0-9_-]{1,64}` is rejected before downloading. After a pack is installed or changed, the app checks
  that the restarted sidecar lists the pack. If it does not, an error points to `logs\sidecar.log`; the files stay
  installed.
- **Language packs** (Kokoro fine-tunes for other languages): "Add model or voice from link…" picks the action from
  the file extension. Voice files are installed as above. An `.onnx` link opens a "New language pack" dialog with these
  fields:
  - pack name (suggested from the repo or file name)
  - espeak-ng language code (dropdown of common codes, free text allowed; suggested from HuggingFace repo tags
    within 5 s)
  - optional vocab JSON link
  - voice links, one per line

  Everything goes into `tts\packs\<id>\` (model max 1 GB, voices max 50 MB). `pack.json` is written last, so the
  sidecar never sees a half-installed pack, and a failed or cancelled install removes the folder. The id is a slug of
  the name with `-2`, `-3`, … added on collision. Installed packs are listed with their flag and voices, with "Add voice
  to this pack" and "Delete pack". `.pth`, `.safetensors` and `.ckpt` links are rejected: only ONNX fine-tunes are
  supported, with no conversion. The sidecar gets `--packs-dir` when at least one pack is installed and is restarted
  after every pack change.
- **Featured language packs** (`src-tauri/src/featured.rs`): one-click installs of two German Kokoro fine-tunes, both
  Apache-2.0. They install through the same pack mechanism, so they behave exactly like user-made packs.
  - **Martin (male)**, from `Godelaune/Kokoro-82M-ONNX-German-Martin`: the `kokoro-martin.onnx` model and
    `voices-martin.npz` (voice `martin`).
  - **Kerstin (female)**, from `crane-local-ai/Kokoro-82M-v1.0-German-ONNX`: the `onnx/model.onnx` model and
    `voices/df_kerstin.bin` (voice `df_kerstin`).

  File URLs and exact sizes come from the HuggingFace file trees, and every download must match its size. Kerstin's
  voice is headerless float32 (510x1x256), so the installer wraps it in an NPY header as `df_kerstin.npy`; the sidecar
  is unchanged. Her `tokenizer.json` vocab is kokoro-onnx's built-in vocab plus the `$` pad token at id 0, and every
  espeak-ng `de` phoneme of a test sentence is in it, so no vocab file is installed.
- **Fallback hint**: a voice without a pack whose language is unknown is spoken with the base model. When the sidecar
  reports this (`details[].fallback` from `/voices`, or `X-TTS-Fallback: 1` on a synthesize response), a single hint
  appears under the chat toolbar while that voice is selected. `tts_synthesize` passes the header to the webview as a
  leading flag byte before the WAV.
- **Ollama terminal**: the Log button under the status light (or Open log on the Server page) opens a read-only view of the stdout/stderr of the
  `ollama serve` that Talkerbox started. It keeps a ring buffer of the last 5000 lines and receives new lines through
  `ollama-log` events. It scrolls automatically and pauses while you are scrolled up; Clear empties it. Output of an
  externally started Ollama cannot be captured, and the view says so.
- **Tokens/s**: shown at the bottom-right of each reply. While streaming it is a 3-second rolling estimate from chunk
  timestamps, measured from the first token and updated once per second. When the reply is done it shows the exact
  figure from Ollama's `eval_count / eval_duration`. The rate logic is in `src/lib/rate.ts` (tested).
- **Voice picker**: a custom accessible listbox (arrow keys, Home/End, Enter, Escape) grouped by language, with
  bundled SVG flags from [flag-icons](https://github.com/lipis/flag-icons) (MIT). A native `<select>` cannot show
  images, and Windows has no flag emoji. Voice labels look like "Heart (female)", with the raw id as tooltip. The
  language mapping lives in `src/lib/voices.ts` (Kokoro prefix letters a/b/e/f/h/i/j/p/z per Kokoro-82M VOICES.md).
  Unknown prefixes get a globe.
- **Speech input** (`src-tauri/src/stt.rs`, offline, in-process): the microphone button in the composer starts and
  stops listening (red while listening). Audio from the default recording device is captured with `cpal`, downmixed
  to mono, resampled to 16 kHz (box-filter averaging) and fed to Vosk in 100 ms chunks on its own thread, off the
  async runtime. The live transcript fills the composer (italic, read-only, red frame) through `stt://partial` and
  `stt://final` events; text typed before stays in front of it. When the transcript is non-empty and has not changed
  for the "send after silence" time (default 5 s, setting `sttIdleSecs`), Rust emits `stt://send`, stops listening
  and the text is sent like a typed message. While listening, Send (or Enter) sends at once, Discard drops the
  dictated text, and the mic button stops and leaves the text for editing. Starting to listen stops any speech
  playback so the microphone does not hear the reply; listening while a reply is generated is allowed (the text then
  waits in the composer). Errors (no microphone, access blocked by Windows privacy settings, device unplugged) are
  shown in the chat (`stt://error`). Audio is never written to disk or sent anywhere. Listening stops on app exit.
  The Speech page's "Speech input" section picks the language (`sttLanguage`: German or English) and downloads the
  Vosk small models on demand from alphacephei.com (`vosk-model-small-de-0.15`, `vosk-model-small-en-us-0.15`, about
  45 MB each). The zip is downloaded with resume (max 150 MB), unpacked to a temp folder (entries escaping it are
  rejected, max 500 MB unpacked), checked for `am/final.mdl` and moved to `stt\<model>`. If the model for the chosen
  language is missing, the mic button shows a hint instead of starting.
- **Settings** (`settings.json` in the app config dir, `%APPDATA%\com.talkerbox.app`): Ollama path, last model, voice,
  TTS on/off and speed, speech input language and idle time.

Downloads, logs and models are stored in the local app data dir (`%LOCALAPPDATA%\com.talkerbox.app`): `gguf\` (temporary),
`tts\`, `stt\` and `logs\sidecar.log`. Ollama's output is not written to disk: it is kept in memory for the terminal view.

## Prerequisites

- Node.js 20+ and npm
- Rust (stable, `x86_64-pc-windows-msvc`) and the MSVC C++ Build Tools
- WebView2 (preinstalled on Windows 11)
- Ollama installed separately (needed only at runtime)

## Development

```powershell
cd app
npm install
npm run tauri dev      # Vite dev server on :1420 + Rust app with hot reload
```

Checks:

```powershell
npm run check                          # svelte-check + tsc
npm test                               # frontend unit tests (node --test, voice/flag mapping)
npm run build                          # frontend production build
cd src-tauri; cargo test; cargo clippy # Rust unit tests (HF links, Ollama path order, file names, speech input)
```

## Release build

```powershell
npm run tauri build    # NSIS installer in src-tauri/target/release/bundle/nsis/
```

## TTS sidecar

The sidecar is bundled as a Tauri `externalBin` (`binaries/tts-sidecar`). Tauri expects this file:

```
app/src-tauri/binaries/tts-sidecar-x86_64-pc-windows-msvc.exe
```

Without the real exe, an empty placeholder with that name lets builds succeed. Talkerbox treats an empty or missing
file as unavailable and shows the paths it checked on the Speech page; everything else keeps working. To enable speech,
build `../tts-sidecar` and copy the result over the placeholder under the name above, then rebuild.

Where the app looks for the sidecar:
1. Next to `talkerbox.exe` as `tts-sidecar.exe`. Tauri puts it there at build time, and the installer puts it there
   for release builds.
2. In debug builds only, as a fallback: `src-tauri/binaries/tts-sidecar-x86_64-pc-windows-msvc.exe`. The copy in
   `target/debug` is refreshed only when the build script reruns, so it could go stale. `build.rs` now reruns whenever
   `binaries/` changes.

The sidecar is started as
`tts-sidecar.exe --port <free port> --model <*.onnx> --voices <*.bin>`, with a stdin pipe that stays open. The
sidecar exits when that pipe closes, so it never outlives the app. The app waits for `GET /health`, reads
`GET /voices`, and sends `POST /synthesize` (`{"text","voice","speed"}` -> WAV) for each sentence.

Kokoro files: **Speech -> Text-to-speech model** shows them as installed once a `.onnx` of at least 20 MB and a
`.bin` of at least 1 MB are present (`kokoro-v1.0.onnx` and `voices-v1.0.bin` are preferred). In that state the
download buttons are hidden behind "Re-download…", and "Delete files" removes them. You can also choose "Use existing
folder…" (for example `tts-sidecar\models`). Files in a folder you chose are never deleted by the app.

## Vosk runtime (speech input)

The `vosk` crate links `libvosk.dll` (Vosk 0.3.45). `src-tauri/vosk/` must hold the four runtime DLLs and the MSVC
import library `libvosk.lib`; none of them are in git. Create them once with:

```powershell
src-tauri\vosk\setup.ps1                                  # default: ..\spikes\vosk-stt\.venv\Lib\site-packages\vosk
src-tauri\vosk\setup.ps1 -From <site-packages>\vosk       # any `pip install vosk==0.3.45`
```

It copies `libvosk.dll`, `libstdc++-6.dll`, `libgcc_s_seh-1.dll` and `libwinpthread-1.dll` and builds `libvosk.lib`
from the DLL's `vosk_*` exports with `dumpbin`/`lib` from the MSVC Build Tools. `build.rs` adds the folder to the
linker path, links `libvosk.dll` with `/DELAYLOAD` (so the app and `cargo test` start without the DLL; the app checks
for it next to the exe before listening and otherwise shows "Speech input runtime missing") and copies the DLLs into
`target/<profile>/` for `tauri dev`. Release builds bundle them next to `talkerbox.exe` through `bundle.resources`.

End-to-end check of the Vosk link with a real recording (16-bit PCM WAV, DLLs copied to `target\debug\deps`):

```powershell
$env:TALKERBOX_VOSK_MODEL = '<model dir>'; $env:TALKERBOX_VOSK_WAV = '<file.wav>'
cargo test vosk_wav -- --ignored --nocapture
```

Licences: `libvosk.dll` Apache-2.0; `libstdc++-6.dll` and `libgcc_s_seh-1.dll` GPL-3.0 with the GCC Runtime Library
Exception; `libwinpthread-1.dll` MIT-style. The Vosk small models are Apache-2.0. See the third-party notices in the
top-level README.

## Security notes

- All HTTP (Ollama, sidecar, downloads) runs in Rust. The webview's CSP allows only `'self'` and Tauri IPC.
- Capabilities: `core:default`, plus `dialog:allow-open` and `dialog:allow-ask`. No shell or filesystem plugin
  permissions are granted to the webview. Processes are spawned only by fixed Rust commands.
- Download URLs must be http(s). Local file names are sanitised to `[A-Za-z0-9._-]`.

## Layout

```
src/                 Svelte UI (App shell, Chat, Models/Speech, path dialog, theme, fit toolbars, speaker queue, typed API wrappers)
src-tauri/src/
  lib.rs             Tauri commands, app state, process handling
  ollama.rs          Ollama HTTP client (chat, tags, pull, delete, blobs/create) + `ollama serve`
  discovery.rs       ollama.exe lookup order (unit-tested)
  hf.rs              HuggingFace link -> hf.co/user/repo[:quant] (unit-tested)
  names.rs           short display names for models (unit-tested)
  packs.rs           language packs: pack.json, ids, listing (unit-tested)
  term.rs            ring buffer + events for the Ollama terminal view (unit-tested)
  download.rs        resumable streaming downloads
  tts.rs             sidecar lifecycle and HTTP calls
  stt.rs             speech input: mic capture, resampling, Vosk, idle timer, model zip install (unit-tested)
  config.rs          settings.json
```
