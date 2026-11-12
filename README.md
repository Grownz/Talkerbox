# Talkerbox

Windows desktop chatbot with spoken replies. It talks to a locally installed [Ollama](https://ollama.com) server for the
LLM and uses a bundled local [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) TTS sidecar for speech. Everything
runs on your machine.

> Status: early development. The GUI is built and checked with unit tests and automated runs, but has not been
> through broad manual testing or a release build yet.

## Features

- Streaming chat with model picker, stop button and live tokens/s
- One-click start/stop of the Ollama server (status LED) and a read-only server log terminal
- Ollama discovery on startup; if none is found, you pick the install path (Talkerbox never installs Ollama)
- Model downloads from a HuggingFace link, `hf.co/user/repo[:quant]`, or any direct `.gguf` URL
- Spoken replies, sentence by sentence, with a replay button per reply
- Voice picker with language flags; add more Kokoro voices (`.pt`, `.npy`, `.npz`, `.bin`) from a link
- Offline speech input (German or English, [Vosk](https://alphacephei.com/vosk/)): dictate with the microphone
  button; the text is sent after a few seconds without new words. Models are downloaded on demand.

Details: [app/README.md](app/README.md).

## Repository layout

| Path | Contents |
|------|----------|
| [`app/`](app) | Tauri v2 app: Rust backend, Svelte 5 + TypeScript frontend |
| [`tts-sidecar/`](tts-sidecar) | Python Kokoro TTS server (local HTTP, built to a single `.exe` with PyInstaller) |

## Requirements

- Windows 10/11 with WebView2
- [Ollama](https://ollama.com) installed separately
- To build: Node.js 20+, Rust (stable, MSVC toolchain) with the MSVC C++ Build Tools, Python 3.10+

## Build and run

1. Build the TTS sidecar (the `.exe` is not stored in git):

   ```powershell
   cd tts-sidecar
   .\build.ps1
   ```

   Copy `dist\tts-sidecar-x86_64-pc-windows-msvc.exe` to `app\src-tauri\binaries\`.

   For speech input, put the Vosk runtime DLLs into `app\src-tauri\vosk\` (not stored in git either):
   `app\src-tauri\vosk\setup.ps1 -From <site-packages>\vosk` copies them from a `pip install vosk==0.3.45`.

2. Run the app:

   ```powershell
   cd app
   npm install
   npm run tauri dev
   ```

   Release installer: `npm run tauri build`.

3. In the app, open **Models** and download the Kokoro model files (about 350 MB) to enable speech.

## Third-party notices

The installer ships the Vosk runtime (`libvosk.dll`, Apache-2.0) with MinGW runtime DLLs: `libstdc++-6.dll` and
`libgcc_s_seh-1.dll` (GPL-3.0 with the GCC Runtime Library Exception) and `libwinpthread-1.dll` (MIT-style licence).
The downloadable Vosk small models are Apache-2.0.

## Security

Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
