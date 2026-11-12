# Talkerbox

Windows desktop chatbot with spoken replies. It talks to a locally installed [Ollama](https://ollama.com) server for the
LLM and uses a bundled local [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) TTS sidecar for speech. Everything
runs on your machine.

> Status: early development. The GUI is built and checked with unit tests and automated runs, but has not been
> through broad manual testing or a release build yet.

## Features

- Streaming chat with model picker, stop button and live tokens/s
- One-click start/stop of the Ollama server (status LED) and a read-only server log terminal; the server starts
  automatically when the app opens (can be turned off on the Server page)
- Ollama discovery on startup; if none is found, you pick the install path (Talkerbox never installs Ollama)
- Model downloads from a HuggingFace link, `hf.co/user/repo[:quant]`, or any direct `.gguf` URL
- Spoken replies, sentence by sentence, with a replay button per reply
- Voice picker with language flags; add more Kokoro voices (`.pt`, `.npy`, `.npz`, `.bin`) from a link
- Offline speech input (German or English, [Vosk](https://alphacephei.com/vosk/)): dictate with the microphone
  button; the text is sent after a few seconds without new words. Models are downloaded on demand. Right-click the
  microphone button to choose the input device.
- Hold to keep listening: hold the microphone button for 5 seconds to stay in continuous listening. Every speech
  pause (or a sentence end after about 100 words) sends the text, and listening goes on until you press the button
  again. Replies being read aloud are not picked up by the microphone.

Details: [app/README.md](app/README.md).

## Repository layout

| Path | Contents |
|------|----------|
| [`app/`](app) | Tauri v2 app: Rust backend, Svelte 5 + TypeScript frontend |
| [`tts-sidecar/`](tts-sidecar) | Python Kokoro TTS server (local HTTP, built to a single `.exe` with PyInstaller) |

## Requirements

- Windows 10/11 with WebView2
- [Ollama](https://ollama.com) installed separately
- To build:
  - Node.js 22.18+ and npm (`npm test` runs the `.ts` tests with Node's built-in type stripping)
  - Rust stable with the `x86_64-pc-windows-msvc` toolchain
  - Visual Studio Build Tools with the MSVC C++ workload (the Rust linker, and `lib.exe`/`dumpbin.exe` for the
    Vosk setup script)
  - Python 3.10+ with the `py` launcher (TTS sidecar and Vosk runtime)

## Build and run

All commands are PowerShell, run from the repository root unless a `cd` says otherwise. Steps 1 and 2 are needed
once (and again when the sidecar or the Vosk version changes); the files they create are not stored in git.

1. Build the TTS sidecar. `build.ps1` creates `tts-sidecar\.venv`, installs `requirements-dev.txt` and runs
   PyInstaller:

   ```powershell
   tts-sidecar\build.ps1
   Copy-Item tts-sidecar\dist\tts-sidecar-x86_64-pc-windows-msvc.exe app\src-tauri\binaries\ -Force
   ```

   Tauri bundles `app\src-tauri\binaries\tts-sidecar-x86_64-pc-windows-msvc.exe` as an `externalBin`, so a file with
   that name must exist. An empty placeholder lets the app build and run without spoken replies.

2. Set up the Vosk runtime for speech input. The app links `libvosk.dll` from `app\src-tauri\vosk\`, so the build
   needs it. `setup.ps1` copies the four runtime DLLs out of a pip-installed `vosk` 0.3.45 package and builds the
   import library `libvosk.lib` with the MSVC tools:

   ```powershell
   py -3 -m venv .venv-vosk
   .venv-vosk\Scripts\python.exe -m pip install vosk==0.3.45
   app\src-tauri\vosk\setup.ps1 -From .venv-vosk\Lib\site-packages\vosk
   ```

   Without `-From`, the script looks in `spikes\vosk-stt\.venv\Lib\site-packages\vosk`. The venv is only needed
   for this step and can be deleted afterwards.

3. Install the frontend dependencies and run the app in development mode (Vite dev server on port 1420 plus the
   Rust app):

   ```powershell
   cd app
   npm install
   npm run tauri dev
   ```

4. Build the release installer:

   ```powershell
   cd app
   npm run tauri build
   ```

   The NSIS installer is written to `app\src-tauri\target\release\bundle\nsis\Talkerbox_<version>_x64-setup.exe`.

5. In the app, open **Speech** and download the Kokoro model files (about 350 MB) to enable spoken replies, and the
   speech input model for your language.

Checks (from `app\`):

```powershell
npm run check                           # svelte-check + tsc
npm test                                # frontend unit tests
npm run build                           # frontend production build
cd src-tauri; cargo test; cargo clippy --all-targets
```


## Third-party notices

The installer ships the Vosk runtime (`libvosk.dll`, Apache-2.0) with MinGW runtime DLLs: `libstdc++-6.dll` and
`libgcc_s_seh-1.dll` (GPL-3.0 with the GCC Runtime Library Exception) and `libwinpthread-1.dll` (MIT-style licence).
The downloadable Vosk small models are Apache-2.0.

## Security

Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
