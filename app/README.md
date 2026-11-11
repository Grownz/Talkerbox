# Talkerbox (desktop app)

Windows desktop chatbot with spoken replies. Tauri v2 (Rust backend), Svelte 5 + TypeScript frontend, Vite.
The LLM comes from a locally installed [Ollama](https://ollama.com), which Talkerbox never installs. Speech comes from the
separate TTS sidecar in `../tts-sidecar` (Kokoro ONNX).

## Features

- **Ollama discovery**: checks `http://127.0.0.1:11434/api/version` first, then looks for `ollama.exe` at the saved
  path, on `PATH`, in `%LOCALAPPDATA%\Programs\Ollama`, and in `C:\Program Files\Ollama`. If none is found, a dialog asks
  for the folder or exe. The path is checked and then saved.
- **Start/stop `ollama serve`** from the top bar. On exit, Talkerbox kills only a server that it started itself (the
  whole process tree, so the runner processes go too).
- **Chat**: streamed replies (`/api/chat`), model picker (`/api/tags`), history kept in memory, stop button.
- **Models**: pull from a HuggingFace link, `hf.co/user/repo[:quant]` or a library name (`/api/pull`, with progress).
  You can also import a `.gguf` from any direct URL: it downloads with resume, is uploaded through `/api/blobs`, and is
  imported through `/api/create` with `files`. The view lists and deletes models and downloads the TTS model files.
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

The repository ships an **empty placeholder** with that name so that builds work before the sidecar exists. Talkerbox
treats an empty file as "not installed": speech is disabled with a hint, and everything else works. To enable speech,
build `../tts-sidecar` and copy the resulting `tts-sidecar.exe` over the placeholder under the name above, then rebuild.
At build time Tauri copies it next to `talkerbox.exe` as `tts-sidecar.exe`, and that is where the app looks for it.

The sidecar is started as
`tts-sidecar.exe --port <free port> --model <tts\*.onnx> --voices <tts\*.bin>`. The app waits for `GET /health`, reads
`GET /voices`, and sends `POST /synthesize` (`{"text","voice","speed"}` -> WAV) for each sentence. Download
`kokoro-v1.0.onnx` and `voices-v1.0.bin` in **Models -> Text-to-speech model**. The default names are preferred;
otherwise the app uses the first `.onnx` and the first `.bin` in the `tts` folder.

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
  download.rs        resumable streaming downloads
  tts.rs             sidecar lifecycle and HTTP calls
  config.rs          settings.json
```
