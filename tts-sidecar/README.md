# tts-sidecar

Local text-to-speech server for Talkerbox, built on [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx).
It ships as one Windows exe and the Tauri app starts it as a sidecar.

## Contract

```
tts-sidecar.exe --port <int> --model <kokoro-v1.0.onnx> --voices <voices-v1.0.bin> [--voices-dir <dir>] [--packs-dir <dir>]
```

`--voices-dir` is optional. It loads extra voices from the given directory, in addition to the built-in voices:
- `*.npy`: one voice, a float array of shape (N, 1, 256). The voice id is the file stem.
- `*.npz` / `*.bin`: a bundle in the same format as `voices-v1.0.bin`. The voice ids are its keys.
- `*.pt`: one voice in the format of `hexgrad/Kokoro-82M/voices/*.pt`, the zip that `torch.save` writes. The voice id is the file stem.
  It is decoded by a whitelisting unpickler that accepts only a contiguous float32 tensor. torch is not
  used, and a malicious file cannot run code.

Voice ids must match `[A-Za-z0-9_-]{1,64}`. These size limits apply:
- A voice may have at most 1024 rows. Real voices have 510.
- Each voice array or zip member may be at most 8 MB.
- A whole bundle may be at most 64 MB.

The sizes are checked from the headers before anything is read, which also blocks zip bombs.
An invalid file, or a directory that does not exist, causes a
one-line `warning:` on stderr and is skipped. Startup never fails because of it.

`--packs-dir` is optional. It loads language packs, which are Kokoro fine-tunes with their own ONNX model.
Each subfolder of the directory holds one pack and must contain a `pack.json`:

```json
{"id": "de-martin", "name": "German (Martin)", "language": "de",
 "model": "model.onnx", "vocab": "vocab.json", "voices": ["martin.npy"]}
```

- Paths are relative to the pack folder and must stay inside it.
- `vocab` is optional. It points to a JSON file with a `{"vocab": {...}}` object, which is passed to
  kokoro-onnx as `vocab_config`.
- `voices` lists files in any of the formats above, loaded with the same safe loaders.
- `language` must be an espeak-ng code from phonemizer's `EspeakBackend.supported_languages()`. The bundled
  espeak-ng supports 140 codes, for example `de`, `fr-fr`, `pt-br` or `cmn`. kokoro-onnx passes the code
  unchanged to `phonemizer.phonemize`, and an unknown code would fail there with
  `RuntimeError: language "xx" is not supported by the espeak backend`. That is why packs are
  checked at startup instead.
- The pack id must match `[A-Za-z0-9_-]{1,64}` and must not be `base`.
- When does the model load? The metadata and voices are read at startup, so `/voices` lists them right away.
  The pack's ONNX model is loaded on the first synthesis that uses it, then kept in memory. That first
  load logs `info: loading pack model <id>` on stderr.
- A bad voice file in a pack is skipped with a one-line warning, and the pack keeps its other voices.
- A broken pack is skipped with a one-line warning, and none of its voices are listed. A pack is broken if
  its JSON is bad, its language is unknown, its model or vocab file is missing, invalid or outside the
  folder, or none of its voices loads.

If several sources define the same voice id, the first one in this order wins, with a stderr warning:
built-in voices, then `--voices-dir`, then packs in alphabetical order of pack id.

The **language** of a voice:
- Built-in voices and `--voices-dir` voices: the first letter of the id picks the espeak-ng language
  (`a` en-us, `b` en-gb, `e` es, `f` fr-fr, `h` hi, `i` it, `j` ja, `p` pt-br, `z` cmn).
- Pack voices: the pack's `language`.
- A `--voices-dir` voice whose first letter is none of these, such as `xx_test`, is a **fallback** voice.
  It is synthesized with the base model and en-us phonemes, and is flagged so the app can warn the user.

- Listens on `127.0.0.1:<port>` only. `--port 0` lets the OS choose a free port.
- Prints exactly one stdout line, `READY port=<port>`, once it is serving. Logs go to stderr.
- Exits with code 0 when its stdin closes. The parent must give it a stdin **pipe**: if stdin is
  null or `NUL`, it exits right away.
- Missing or broken model files: prints an `error: ...` message on stderr and exits non-zero.

| Endpoint | Response |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /voices` | `{"voices":["af_alloy", ...], "details":[{"id":str,"pack":null\|"<pack id>","language":"<espeak code>","fallback":bool}, ...]}` |
| `POST /synthesize` `{"text":str,"voice":str,"speed":float}` | `audio/wav`, 16-bit PCM, mono, 24 kHz, with headers `X-TTS-Model: base\|<pack id>` and `X-TTS-Fallback: 1` (fallback voices only) |

Errors are JSON `{"error": "..."}`:
- 400: body missing or not valid JSON
- 413: body larger than 64 KB
- 422: validation failed (empty text, more than 2000 characters, unknown voice, speed outside 0.5-2.0)
- 500: synthesis failed
- 404: unknown path

Inference calls, and loading a pack model, run one at a time behind a single global lock.

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
# optional: a real HF .pt voice, which the tests also load when it is present
curl.exe -L -o models\hf_af_heart.pt https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices/af_heart.pt
# optional: a real German fine-tune (Apache-2.0, about 325 MB). test_real_german_pack uses it when it is present.
mkdir models\packs\de-martin
$h = "https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin/resolve/main"
curl.exe -L -o models\packs\de-martin\kokoro-martin.onnx "$h/kokoro-martin.onnx"
curl.exe -L -o models\packs\de-martin\voices-martin.npz "$h/voices-martin.npz"
'{"id":"de-martin","name":"German (Martin)","language":"de","model":"kokoro-martin.onnx","voices":["voices-martin.npz"]}' | Set-Content models\packs\de-martin\pack.json

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
