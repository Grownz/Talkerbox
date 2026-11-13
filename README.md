# Talkerbox

A Windows desktop chatbot that talks back. Talkerbox chats with a language model on your own
[Ollama](https://ollama.com) server, reads the replies aloud with the bundled [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
speech engine, listens to your voice, and can show a talking avatar made from your own picture. Everything runs on
your computer; after the one-time model downloads it works offline.

> Status: early pre-release (0.4.0). The installer is not code-signed, so Windows SmartScreen warns on first start.

[Changelog](CHANGELOG.md) · [Developer documentation](app/README.md) · [TTS sidecar](tts-sidecar/README.md) ·
[Security](SECURITY.md) · [MIT licence](LICENSE)

## At a glance

- **Chat with a local LLM**: streamed replies, model picker, stop button, live tokens per second.
- **Spoken replies**: every reply is read aloud sentence by sentence, with a play/stop button on each reply, voice
  picker, speed slider, extra voices and language packs (two German voices with one click).
- **Speech input**: dictate with the microphone, fully offline (German or English).
- **Talking avatar**: a separate window with a figure cut out of your own image that moves its lips, blinks, sways
  and gestures while it speaks; on a normal, green-screen or transparent background.
- **Editors for the avatar**: cut the figure out (with one-click "Smart select"), mark eyes, mouth, lips, arms and
  legs, and preview the animation.
- **Light and dark mode**, a sidebar that collapses to an icon rail, works down to 720 x 520.
- **Private by design**: no account, no cloud, no telemetry. Models are downloaded only when you ask for them and
  can be removed again.

## What you can do

### Chat
Pick any model your Ollama server has and chat; replies stream in as they are generated. You can stop a reply,
see the generation speed, and download new models on the **Models** page from a Hugging Face link,
`hf.co/user/repo[:quant]`, an Ollama library name or a direct `.gguf` URL (downloads resume after interruptions).
The status light in the sidebar starts and stops the Ollama server; Talkerbox starts it automatically when it opens
(switch this off on the **Server** page), and the **Log** button shows the server output. Talkerbox never installs
Ollama itself: if it is not found, it asks you where it is.

### Spoken replies
Tick "Speak replies" in the chat and every answer is read aloud, sentence by sentence, while it is still being
written. Each finished reply has a play button to hear it again; while a reply is read aloud its button turns into a
red stop button. On the **Speech** page you download the Kokoro
voice files (about 350 MB, once), choose and preview voices (grouped by language, with flags), add voices or
language packs from a link, and install the featured German voices Martin and Kerstin with one click.

### Speech input
Press the microphone button in the chat and talk: the live transcript appears in the message box and is sent after
a few seconds of silence (adjustable). Hold the button for 5 seconds to keep listening across messages; right-click
it to choose the microphone. While a reply is read aloud the microphone is muted, so Talkerbox does not hear itself.
Recognition runs offline with [Vosk](https://alphacephei.com/vosk/); the model for your language (about 45 MB) is
downloaded on demand on the **Speech** page. Audio is never stored or sent anywhere.

### Talking avatar
On the **Avatar** page (or the Avatar button in the chat) you open a second window with a figure that talks with the
spoken replies:

- **Your own character**: import a PNG, JPEG or WebP picture of a portrait or a full figure; keep several
  characters and choose which one is shown. Without one, a built-in demo figure is used.
- **Lip-sync**: the mouth opens with the loudness of the speech and takes the shape of the sounds (open for A, wide
  for E and I, round for O and U, nearly closed for F, V, S), computed from the audio itself, for every voice and
  language.
- **Lips and face**: outline the upper and lower lip (or let "Auto-split" suggest them from the mouth) and the lips
  part naturally while cheeks and chin follow; the strength of this face warp is adjustable.
- **Life**: random blinking, a gentle sway, and arm and leg gestures that follow the speech energy (no sway or
  gestures when Windows "reduce motion" is on).
- **Background**: the app theme, green screen (#00ff00) for streaming and video tools, or fully transparent so only
  the figure floats on your desktop; plus an opacity slider. The window remembers its position and size.
- **Test speech** plays a sample sentence so you can check the avatar without chatting.

### Avatar editors
- **Mask editor**: cut the figure out of the background with a polygon, brush or magic wand, smooth the outline and
  snap it to the image edges, and preview the cut-out on a checkerboard, green or dark background. Undo, redo and
  zoom work as you would expect.
- **Smart select**: click on the figure and an on-device AI model (MobileSAM) proposes its outline within a fraction
  of a second; right-click what does not belong to it, or drag a box around it, then add the proposal to the mask (or
  cut it out). It runs on the CPU, offline, after a one-time download of about 60 MB.
- **Part editor**: mark the parts that move: eyes, mouth, lips, arms, hands, legs, head, body or custom parts, each
  with a pivot to turn about. Draw each outline by hand or press **Pick**, choose the role and click the part:
  Smart select outlines it and the part gets a sensible pivot (shoulder, wrist, hip, or the centre). For photos and
  realistic paintings, **Face** finds both eyes and the mouth with its lips in one click (MediaPipe face landmarks,
  about 5 MB download); on cartoons the face is often not found or the eyes come out too flat, so use Pick there. A
  preview with sliders and a demo animation shows the result before you save.
- **Background under moved parts**: when an arm swings away, the picture still holds the arm where it was. Choose
  per character what shows there instead: the original picture, transparent (cut out), a smooth classic fill from the
  surroundings, or a fill painted by an AI model (LaMa) that continues patterns and backgrounds. Arms in front of the
  body then look right. The AI fill is generated once in the part editor (about 10 s) and saved with the character;
  its model is a one-time download of about 93 MB.

### Downloads and how to remove them
Nothing large is bundled: you download what you use, and everything stays in
`%LOCALAPPDATA%\com.talkerbox.app`.

| What | Size | Download on | Remove |
|---|---|---|---|
| Kokoro voices (spoken replies) | about 350 MB | Speech page | "Delete files" on the Speech page |
| Language packs and extra voices | 1-330 MB each | Speech page | "Delete pack" / delete button on the Speech page |
| Speech input model (German or English) | about 45 MB each | Speech page | trash button next to the model on the Speech page |
| Smart select (MobileSAM + ONNX Runtime) | about 60 MB | mask editor or part editor | "Remove model…" on the Avatar page or the trash button in the Smart select bar |
| AI fill under moved parts (LaMa) | about 93 MB (plus 15 MB runtime if Smart select is not installed) | part editor, "Fill (AI)" | trash button next to "Generate with AI" |
| Face detection (MediaPipe face detector + landmarks) | about 5 MB (plus 15 MB runtime if Smart select is not installed) | part editor, "Face" | trash button next to "Detect eyes and mouth" |
| Chat models | varies | Models page (through Ollama) | delete button on the Models page |

Settings are stored in `%APPDATA%\com.talkerbox.app\settings.json`.

### Privacy
All processing happens on your computer: the language model in your Ollama, speech in the bundled Kokoro engine,
speech recognition in Vosk, Smart select in ONNX Runtime. Talkerbox only goes online to download files you ask for
(each Smart select file is checked against a fixed checksum). Microphone audio is never written to disk.

## Install

1. Install [Ollama](https://ollama.com) and pull a model (for example `ollama pull llama3.2`), or pull one later on
   the **Models** page.
2. Run `Talkerbox_<version>_x64-setup.exe` from the [releases](https://github.com/Grownz/Talkerbox/releases). It
   installs for the current user, without admin rights. Windows SmartScreen will warn because the installer is not
   signed ("More info" > "Run anyway").
3. Start Talkerbox, open **Speech**, download the Kokoro voice files and tick "Speak replies" in the chat.

Requirements: Windows 10 or 11 (x64) with the WebView2 runtime (preinstalled on Windows 11). Smart select also needs
the Microsoft Visual C++ Redistributable (x64), which most PCs already have.

## Build from source

All commands are PowerShell, run from the repository root unless a step says otherwise. The build downloads packages
from PyPI, npm and crates.io; it needs no model or voice files.

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Windows 10/11 x64 | | the app is Windows-only |
| [Node.js](https://nodejs.org) + npm | 22.18 or newer (tested with 24.12) | frontend, Tauri CLI, tests (Node's built-in TypeScript type stripping) |
| [Rust](https://rustup.rs) | stable 1.92 or newer, toolchain `x86_64-pc-windows-msvc` (tested with 1.99) | backend |
| Visual Studio Build Tools | 2019 or 2022 with the "Desktop development with C++" workload | Rust linker; `lib.exe`, `dumpbin.exe` and `vswhere.exe` for the Vosk setup script |
| [Python](https://www.python.org) with the `py` launcher | 3.10 to 3.13 (kokoro-onnx 0.6.1 does not support 3.14) | building the TTS sidecar; fetching the Vosk runtime |
| WebView2 runtime | any current | running the app (preinstalled on Windows 11) |
| Ollama | any current | only at runtime |

### 1. Build the TTS sidecar (once, and whenever `tts-sidecar` changes)

```powershell
tts-sidecar\build.ps1
New-Item -ItemType Directory -Force app\src-tauri\binaries | Out-Null
Copy-Item tts-sidecar\dist\tts-sidecar-x86_64-pc-windows-msvc.exe app\src-tauri\binaries\ -Force
```

`build.ps1` creates `tts-sidecar\.venv` with the default `py -3` interpreter, installs `requirements-dev.txt`
(kokoro-onnx, PyInstaller, pytest) and writes a single-file exe of about 38 MB to `tts-sidecar\dist\`. Tauri bundles
`app\src-tauri\binaries\tts-sidecar-x86_64-pc-windows-msvc.exe`, so that file must exist. To build without spoken
replies, create an empty placeholder instead; the app then reports speech as unavailable:

```powershell
New-Item -ItemType Directory -Force app\src-tauri\binaries | Out-Null
New-Item -ItemType File -Force app\src-tauri\binaries\tts-sidecar-x86_64-pc-windows-msvc.exe | Out-Null
```

### 2. Set up the Vosk runtime (once, required for every build)

The app links `libvosk.dll` (speech input) from `app\src-tauri\vosk\`, and the installer bundles it, so both
`cargo` and `tauri build` fail without it. The script copies the four runtime DLLs out of the `vosk` 0.3.45 pip
package and builds the import library `libvosk.lib` with the MSVC tools:

```powershell
py -3 -m venv $env:TEMP\vosk-venv
& "$env:TEMP\vosk-venv\Scripts\python.exe" -m pip install vosk==0.3.45
app\src-tauri\vosk\setup.ps1 -From "$env:TEMP\vosk-venv\Lib\site-packages\vosk"
```

It ends with `Vosk runtime ready in ... (<n> exports)`. The venv is only needed for this step and can be deleted.

### 3. Install the frontend dependencies (once, and whenever `package-lock.json` changes)

```powershell
cd app
npm ci
```

All later steps need `app\node_modules`.

### 4. Run in development mode

```powershell
cd app
npm run tauri dev
```

This starts the Vite dev server on port 1420 (the port must be free) and the Rust app with hot reload for the
frontend.

### 5. Build the release installer

```powershell
cd app
npm run tauri build
```

The installer is written to `app\src-tauri\target\release\bundle\nsis\Talkerbox_<version>_x64-setup.exe` (NSIS, per-user
install, LZMA-compressed); the plain exe is `app\src-tauri\target\release\talkerbox.exe`.

### 6. Quality checks

```powershell
cd app
npm run check                                   # svelte-check + tsc
npm test                                        # frontend unit tests (node --test)
npm run build                                   # frontend production build
cd src-tauri
cargo clippy --all-targets                      # lints (must be warning-free)
cargo test                                      # Rust unit tests
```

`cargo test` prints one linker warning `LNK4199: /DELAYLOAD:libvosk.dll ignored` for the binary's test target; it is
harmless.

Optional end-to-end checks with real models (Vosk with a WAV file, Smart select, AI fill and face detection with the
downloaded models) are
described in [app/README.md](app/README.md). The sidecar has its own pytest suite, see
[tts-sidecar/README.md](tts-sidecar/README.md).

### Troubleshooting

- **`setup.ps1` cannot be loaded because running scripts is disabled**: run it as
  `powershell -ExecutionPolicy Bypass -File app\src-tauri\vosk\setup.ps1 -From "<path>\vosk"` (the same works for
  `tts-sidecar\build.ps1`).
- **Build error ``resource path `vosk/libvosk.dll` doesn't exist``**, or a linker error about `libvosk.lib`: step 2
  was skipped or failed.
- **Build error `"...binaries\\tts-sidecar-x86_64-pc-windows-msvc.exe" does not exist`**: step 1 (or the
  placeholder) is missing.
- **A build script panics with "Access is denied" (os error 5)**: a Talkerbox dev instance (or its
  `tts-sidecar.exe`) is still running from `target\debug` and the build cannot overwrite the sidecar copy; close it.
- **`setup.ps1` fails at `vswhere.exe` or `lib.exe`**: install the Visual Studio Build Tools with the C++ workload.
- **`build.ps1` fails while installing kokoro-onnx**: the default `py -3` is Python 3.14 or newer; install 3.12 or
  3.13 and make it the default (`py -0` lists the installed versions), then delete `tts-sidecar\.venv` and retry.
- **`npm test` fails with a syntax error on `.ts` files**: Node is older than 22.18.
- **Spoken replies are missing in the built app**: the sidecar in `binaries` is the empty placeholder; the Speech
  page shows which paths were checked.
- **"Speech input runtime missing"**: the Vosk DLLs are not next to `talkerbox.exe`; the build copies them into
  `target\<profile>\` and the installer next to the exe.
- **Smart select says it cannot load its runtime**: install the Microsoft Visual C++ Redistributable (x64), or remove
  the model on the Avatar page and download it again.

## Repository layout

| Path | Contents |
|---|---|
| [`app/`](app) | Tauri v2 app: Rust backend (`src-tauri/`), Svelte 5 + TypeScript frontend (`src/`), unit tests (`tests/`) |
| [`tts-sidecar/`](tts-sidecar) | Python Kokoro TTS server (local HTTP), built to a single exe with PyInstaller |

## Third-party notices

The full list with versions, copyright holders and licence texts is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the installer places a copy next to `talkerbox.exe`, and the
**About & licences** page (the "i" button at the bottom of the sidebar) lists the main components and opens it. In short:
the installer ships the Vosk runtime (`libvosk.dll`, Apache-2.0) with MinGW runtime DLLs: `libstdc++-6.dll` and
`libgcc_s_seh-1.dll` (GPL-3.0 with the GCC Runtime Library Exception) and `libwinpthread-1.dll` (MIT-style licence),
and the TTS sidecar, a separate program the app talks to over local HTTP. The sidecar is a PyInstaller one-file
executable (bootloader GPL-2.0-or-later with the PyInstaller exception) built from kokoro-onnx (MIT), ONNX Runtime
(MIT), NumPy (BSD-3-Clause) and the Python runtime (PSF-2.0) with espeak-ng (GPL-3.0-or-later) and phonemizer
(GPL-3.0-or-later), so the sidecar is distributed under the GPL-3.0; the app itself stays MIT.
Downloaded on demand, not bundled: the Kokoro model and voices (Apache-2.0), the Vosk small models (Apache-2.0), and for
Smart select ONNX Runtime 1.31.1 (`onnxruntime.dll`, MIT) and the MobileSAM ONNX export from `Acly/MobileSAM` on
Hugging Face (MobileSAM weights and the Segment Anything mask decoder Apache-2.0, export repository MIT), and for the
AI fill the LaMa inpainting model (Apache-2.0) as exported by the OpenCV Zoo (`opencv/inpainting_lama`, Apache-2.0),
and for face detection the MediaPipe BlazeFace and Face Mesh V2 models (Apache-2.0) as ONNX conversions from the
`fernandotonon/QtMeshEditor-blazeface-onnx` and `-facemesh-onnx` repositories on Hugging Face (Apache-2.0). Flags from
[flag-icons](https://github.com/lipis/flag-icons) (MIT).

## Security

Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
