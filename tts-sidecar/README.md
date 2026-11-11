# tts-sidecar

Local text-to-speech server for Talkerbox, built on [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx).
It ships as one Windows exe and the Tauri app starts it as a sidecar.

## Contract

```
tts-sidecar.exe --port <int> --model <kokoro-v1.0.onnx> --voices <voices-v1.0.bin>
```

- Listens on `127.0.0.1:<port>` only. `--port 0` lets the OS choose a free port.
- Prints exactly one stdout line, `READY port=<port>`, once it is serving. Logs go to stderr.
- Exits with code 0 when its stdin closes. The parent must give it a stdin **pipe**: if stdin is
  null or `NUL`, it exits right away.
- Missing or broken model files: prints an `error: ...` message on stderr and exits non-zero.

| Endpoint | Response |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /voices` | `{"voices":["af_alloy", ...]}` (54 voices in v1.0) |
| `POST /synthesize` `{"text":str,"voice":str,"speed":float}` | `audio/wav`, 16-bit PCM, mono, 24 kHz |

Errors are JSON `{"error": "..."}`:
- 400: body missing or not valid JSON
- 413: body larger than 64 KB
- 422: validation failed (empty text, more than 2000 characters, unknown voice, speed outside 0.5-2.0)
- 500: synthesis failed
- 404: unknown path

The first letter of the voice name picks the espeak-ng language (`a` en-us, `b` en-gb, `e` es,
`f` fr-fr, `h` hi, `i` it, `j` ja, `p` pt-br, `z` cmn). Inference calls run one at a time, guarded by a lock.

## Development

You need Python 3.10 or newer.

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
# model files (about 350 MB, ignored by git)
mkdir models
$b = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
curl.exe -L -o models\kokoro-v1.0.onnx "$b/kokoro-v1.0.onnx"
curl.exe -L -o models\voices-v1.0.bin  "$b/voices-v1.0.bin"

.venv\Scripts\python -m pytest -s test_sidecar.py            # tests the Python source
$env:SIDECAR_EXE = "dist\tts-sidecar.exe"; .venv\Scripts\python -m pytest -s test_sidecar.py   # tests the exe
```

## Build

```powershell
.\build.ps1
```

This builds `dist\tts-sidecar.exe` (one file, about 48 MB) and a copy named
`dist\tts-sidecar-x86_64-pc-windows-msvc.exe`, the name Tauri's `externalBin` expects.
The model files are not bundled. The app passes their paths at startup.
espeak-ng comes bundled through `espeakng_loader`, so it does not need to be installed on the system.
