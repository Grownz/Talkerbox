# Talkerbox (desktop app)

Windows desktop chatbot with spoken replies. Tauri v2 (Rust backend), Svelte 5 + TypeScript frontend, Vite.
The LLM comes from a locally installed [Ollama](https://ollama.com), which Talkerbox never installs. Speech comes from the
separate TTS sidecar in `../tts-sidecar` (Kokoro ONNX).

## Features

- **Ollama discovery**: checks `http://127.0.0.1:11434/api/version` first, then looks for `ollama.exe` at the saved
  path, on `PATH`, in `%LOCALAPPDATA%\Programs\Ollama`, and in `C:\Program Files\Ollama`. If none is found, a dialog asks
  for the folder or exe. The path is checked and then saved.
- **Start/stop `ollama serve`**: click the status LED in the top bar (its tooltip says what a click does). Only a server
  that Talkerbox started can be stopped. When the window closes, that server is killed together with its runner
  processes. Spawned processes are also placed in a Windows job object with kill-on-close, so they die even if
  Talkerbox crashes or is killed.
- **Chat**: streamed replies (`/api/chat`), model picker (`/api/tags`), history kept in memory, stop button.
- **Models**: pull from a HuggingFace link, `hf.co/user/repo[:quant]` or a library name (`/api/pull`, with progress).
  You can also import a `.gguf` from any direct URL: it downloads with resume, is uploaded through `/api/blobs`, and is
  imported through `/api/create` with `files`. The view lists and deletes models and downloads the TTS model files.
- **Short display names**: `hf.co/owner/Repo-GGUF:Q4_K_M` is shown as `Repo Q4_K_M`. GGUF imports from HuggingFace use
  the repo id from the HF API plus the quant parsed from the file name. Other hosts use the file name without its
  extension, cut to 50 characters. Names are stored in settings, keyed by the Ollama id; the id itself never changes.
  For non-HF hosts the page title is not fetched: a direct `.gguf` link has no HTML page, and requesting it would
  download the model.
- **TTS**: starts and stops the sidecar, speaks replies sentence by sentence (queued, played with WebAudio), and has a
  stop button, voice picker, speed slider and on/off toggle.
- **Settings** (`settings.json` in the app config dir, `%APPDATA%\com.talkerbox.app`): Ollama path, last model, voice,
  TTS on/off and speed.

Downloads, logs and TTS models are stored in the local app data dir (`%LOCALAPPDATA%\com.talkerbox.app`): `gguf\` (temporary),
`tts\`, and `logs\ollama-serve.log` and `logs\sidecar.log`.

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
npm run build                          # frontend production build
cd src-tauri; cargo test; cargo clippy # Rust unit tests (HF link normalisation, Ollama path order, file names)
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
file as unavailable and shows the paths it checked in the Models view; everything else keeps working. To enable speech,
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

Kokoro files: **Models -> Text-to-speech model** shows them as installed once a `.onnx` of at least 20 MB and a
`.bin` of at least 1 MB are present (`kokoro-v1.0.onnx` and `voices-v1.0.bin` are preferred). In that state the
download buttons are hidden behind "Re-download…", and "Delete files" removes them. You can also choose "Use existing
folder…" (for example `tts-sidecar\models`). Files in a folder you chose are never deleted by the app.

## Security notes

- All HTTP (Ollama, sidecar, downloads) runs in Rust. The webview's CSP allows only `'self'` and Tauri IPC.
- Capabilities: `core:default`, plus `dialog:allow-open` and `dialog:allow-ask`. No shell or filesystem plugin
  permissions are granted to the webview. Processes are spawned only by fixed Rust commands.
- Download URLs must be http(s). Local file names are sanitised to `[A-Za-z0-9._-]`.

## Layout

```
src/                 Svelte UI (App, Chat, Models, path dialog, speaker queue, typed API wrappers)
src-tauri/src/
  lib.rs             Tauri commands, app state, process handling
  ollama.rs          Ollama HTTP client (chat, tags, pull, delete, blobs/create) + `ollama serve`
  discovery.rs       ollama.exe lookup order (unit-tested)
  hf.rs              HuggingFace link -> hf.co/user/repo[:quant] (unit-tested)
  names.rs           short display names for models (unit-tested)
  download.rs        resumable streaming downloads
  tts.rs             sidecar lifecycle and HTTP calls
  config.rs          settings.json
```
