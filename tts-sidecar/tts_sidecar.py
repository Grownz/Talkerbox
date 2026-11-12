"""Talkerbox local TTS sidecar: a tiny HTTP server around kokoro-onnx.

Usage: tts-sidecar --port <int> --model <kokoro-v1.0.onnx> --voices <voices-v1.0.bin> [--voices-dir <dir>] [--packs-dir <dir>]
Binds 127.0.0.1 only. Prints "READY port=<port>" once serving and exits when stdin closes.
"""

import argparse
import collections
import io
import json
import math
import os
import pickle
import re
import sys
import threading
import wave
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

MAX_TEXT_CHARS = 2000
MAX_BODY_BYTES = 64 * 1024
MIN_SPEED, MAX_SPEED = 0.5, 2.0

# Kokoro voice names start with a language letter, e.g. "af_heart" -> American English.
VOICE_LANG = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi",
              "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}


VOICE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
STYLE_DIM = 256
MAX_STYLE_ROWS = 1024  # real voices have 510
MAX_VOICE_BYTES = 8 * 1024 * 1024  # per voice array / zip member; a real voice is 522 KB
MAX_BUNDLE_BYTES = 64 * 1024 * 1024  # all members of one npz/bin bundle together


def check_style(arr):
    """Validate a Kokoro voice: float style vectors of shape (N, 1, 256)."""
    if (not isinstance(arr, np.ndarray) or arr.ndim != 3 or not 1 <= arr.shape[0] <= MAX_STYLE_ROWS
            or arr.shape[1:] != (1, STYLE_DIM)):
        raise ValueError(f"expected shape (N<={MAX_STYLE_ROWS}, 1, {STYLE_DIM}), "
                         f"got {getattr(arr, 'shape', type(arr).__name__)}")
    if arr.dtype.kind != "f" or not np.isfinite(arr).all():
        raise ValueError("expected finite float values")
    return arr.astype(np.float32)


class _Storage:
    def __init__(self, key, numel):
        self.key, self.numel = key, numel


class _Tensor:
    def __init__(self, storage, offset, size, stride, *_rest):
        self.storage, self.offset, self.size, self.stride = storage, offset, tuple(size), tuple(stride)


class _SafePtUnpickler(pickle.Unpickler):
    """Understands only the few globals torch.save emits for one float32 tensor; anything else is refused,
    so a malicious .pt can never run code."""

    def find_class(self, module, name):
        if (module, name) == ("torch._utils", "_rebuild_tensor_v2"):
            return _Tensor
        if (module, name) == ("torch", "FloatStorage"):
            return "float32"
        if (module, name) == ("collections", "OrderedDict"):
            return collections.OrderedDict
        raise pickle.UnpicklingError(f"forbidden global {module}.{name}")

    def persistent_load(self, pid):
        if not (isinstance(pid, tuple) and len(pid) == 5 and pid[0] == "storage" and pid[1] == "float32"
                and isinstance(pid[2], str) and pid[2].isdigit() and isinstance(pid[4], int)):
            raise pickle.UnpicklingError("unsupported storage (only float32 tensors)")
        return _Storage(pid[2], pid[4])


def read_pt(path):
    """Decode a single-tensor torch.save() zip (as in hexgrad/Kokoro-82M/voices/*.pt) without torch or pickle.load."""
    with zipfile.ZipFile(path) as z:
        pkl = [n for n in z.namelist() if n.endswith("/data.pkl") and n.count("/") == 1]
        if len(pkl) != 1:
            raise ValueError("not a torch zip archive")
        prefix = pkl[0][: -len("data.pkl")]
        if z.getinfo(pkl[0]).file_size > 64 * 1024:
            raise ValueError("data.pkl too large")
        names = set(z.namelist())
        if prefix + "byteorder" in names and z.read(prefix + "byteorder").strip() != b"little":
            raise ValueError("only little-endian tensors are supported")
        t = _SafePtUnpickler(io.BytesIO(z.read(pkl[0]))).load()
        if not isinstance(t, _Tensor) or not isinstance(t.storage, _Storage):
            raise ValueError("file does not contain a single tensor")
        if not 0 < t.storage.numel * 4 <= MAX_VOICE_BYTES:
            raise ValueError("tensor data too large")
        count = math.prod(t.size)
        contiguous = tuple(math.prod(t.size[i + 1:]) for i in range(len(t.size)))
        # shortcut: only contiguous tensors (what torch.save of a plain voice produces); add strides if a file needs it
        if t.stride != contiguous or not 0 <= t.offset <= t.offset + count <= t.storage.numel:
            raise ValueError("unsupported tensor layout")
        entry = prefix + "data/" + t.storage.key
        if entry not in names or z.getinfo(entry).file_size != t.storage.numel * 4:
            raise ValueError("tensor data missing or wrong size")
        data = np.frombuffer(z.read(entry), dtype="<f4")
    return data[t.offset: t.offset + count].reshape(t.size)


VOICE_EXTS = (".npy", ".npz", ".bin", ".pt")


def warn(msg):
    sys.stderr.write(f"warning: {msg}\n")


def read_npy(open_stream):
    """Read one .npy stream, checking its declared size before numpy allocates anything."""
    with open_stream() as f:
        version = np.lib.format.read_magic(f)
        if version not in ((1, 0), (2, 0)):
            raise ValueError(f"unsupported .npy version {version}")
        read_header = np.lib.format.read_array_header_1_0 if version == (1, 0) else np.lib.format.read_array_header_2_0
        shape, _, dtype = read_header(f)
    if dtype.hasobject or math.prod(shape) * dtype.itemsize > MAX_VOICE_BYTES:
        raise ValueError(f"voice array too large or not numeric: shape {shape}, dtype {dtype}")
    with open_stream() as f:
        return np.lib.format.read_array(f, allow_pickle=False)


def load_voice_file(path):
    """One voice file -> {voice id: style array}. Raises on anything invalid."""
    ext = path.suffix.lower()
    if ext == ".npy":
        found = {path.stem: read_npy(lambda: open(path, "rb"))}
    elif ext == ".pt":
        found = {path.stem: read_pt(path)}
    elif ext in (".npz", ".bin"):
        if not zipfile.is_zipfile(path):
            raise ValueError("not an npz bundle")
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
            # zipfile never yields more than file_size bytes, so these header checks also stop zip bombs
            if any(i.file_size > MAX_VOICE_BYTES for i in infos) or sum(i.file_size for i in infos) > MAX_BUNDLE_BYTES:
                raise ValueError("bundle member too large")
            found = {i.filename.removesuffix(".npy"): read_npy(lambda i=i: z.open(i)) for i in infos}
    else:
        raise ValueError(f"unsupported voice file type {ext!r}")
    checked = {}
    for vid, arr in found.items():
        if not VOICE_ID.fullmatch(vid):
            raise ValueError(f"invalid voice id {vid!r}")
        checked[vid] = check_style(arr)
    return checked


def load_extra_voices(directory):
    """Load *.npy / *.npz / *.bin / *.pt voices from a directory. Bad files are skipped with a warning."""
    voices = {}
    try:
        paths = sorted(Path(directory).iterdir())
    except OSError as e:
        warn(f"cannot read voices dir {directory}: {e}")
        return voices
    for path in paths:
        if path.is_file() and path.suffix.lower() in VOICE_EXTS:
            try:
                voices.update(load_voice_file(path))
            except Exception as e:
                warn(f"skipping voice file {path.name}: {e}")
    return voices


def load_pack(folder, languages):
    """Read a pack's pack.json and voices (not its model). Raises ValueError if anything is wrong."""
    meta = json.loads((folder / "pack.json").read_text(encoding="utf-8"))
    if not isinstance(meta, dict):
        raise ValueError("pack.json must be a JSON object")
    pid, name, lang, model, vocab, files = (meta.get(k) for k in ("id", "name", "language", "model", "vocab", "voices"))
    if not isinstance(pid, str) or not VOICE_ID.fullmatch(pid) or pid == "base":
        raise ValueError(f"invalid pack id {pid!r}")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("'name' must be a non-empty string")
    if lang not in languages:
        raise ValueError(f"unknown espeak-ng language {lang!r}")
    if not isinstance(files, list) or not files:
        raise ValueError("'voices' must be a non-empty list")

    root = folder.resolve()

    def pack_file(rel):
        if not isinstance(rel, str):
            raise ValueError(f"invalid file entry {rel!r}")
        p = (root / rel).resolve()
        if not p.is_relative_to(root) or not p.is_file():  # no escaping the pack folder
            raise ValueError(f"file not found in pack: {rel}")
        return p

    model = pack_file(model)
    if vocab is not None:
        vocab = pack_file(vocab)
        if not isinstance(json.loads(vocab.read_text(encoding="utf-8")).get("vocab"), dict):
            raise ValueError("vocab file must contain a 'vocab' object")
    voices = {}
    for rel in files:
        try:
            voices.update(load_voice_file(pack_file(rel)))
        except Exception as e:  # one bad voice file must not take the whole pack down
            warn(f"skipping voice file {rel} in pack {folder.name}: {e}")
    if not voices:
        raise ValueError("no valid voices")
    return {"id": pid, "name": name, "language": lang, "model": model, "vocab": vocab, "voices": voices}


def load_packs(directory, languages):
    """All valid packs in a directory, sorted by pack id. Broken packs are skipped with a warning."""
    packs = {}
    try:
        folders = sorted(p for p in Path(directory).iterdir() if p.is_dir())
    except OSError as e:
        warn(f"cannot read packs dir {directory}: {e}")
        return []
    for folder in folders:
        try:
            pack = load_pack(folder, languages)
        except Exception as e:
            warn(f"skipping pack {folder.name}: {e}")
            continue
        if pack["id"] in packs:
            warn(f"skipping pack {folder.name}: duplicate pack id {pack['id']!r}")
            continue
        packs[pack["id"]] = pack
    return [packs[k] for k in sorted(packs)]


class Voice:
    def __init__(self, style, pack, language, fallback, source):
        self.style, self.pack, self.language, self.fallback, self.source = style, pack, language, fallback, source


def to_wav(samples, sample_rate):
    """Float samples in [-1, 1] -> 16-bit PCM mono WAV bytes."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def validate(payload, voices):
    """Return (text, voice, speed) or raise ValueError with a client-facing message."""
    if not isinstance(payload, dict):
        raise ValueError("body must be a JSON object")
    text, voice, speed = payload.get("text"), payload.get("voice"), payload.get("speed", 1.0)
    if not isinstance(text, str) or not text.strip():
        raise ValueError("'text' must be a non-empty string")
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError(f"'text' exceeds {MAX_TEXT_CHARS} characters")
    if not isinstance(voice, str) or voice not in voices:
        raise ValueError("'voice' must be one of GET /voices")
    # bool is an int subclass; reject it explicitly
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not MIN_SPEED <= speed <= MAX_SPEED:
        raise ValueError(f"'speed' must be a number between {MIN_SPEED} and {MAX_SPEED}")
    return text, voice, float(speed)


def make_handler(kokoro, voices, packs, voices_path):
    """voices: {id: Voice}; packs: {pack id: pack dict}; pack models load on first use."""
    lock = threading.Lock()  # one inference (and pack model load) at a time; onnxruntime already uses all cores
    models = {}
    voice_list = sorted(voices)
    details = [{"id": vid, "pack": voices[vid].pack, "language": voices[vid].language,
                "fallback": voices[vid].fallback} for vid in voice_list]

    def model_for(pack_id):  # call with lock held
        if pack_id is None:
            return kokoro
        if pack_id not in models:
            from kokoro_onnx import Kokoro
            pack = packs[pack_id]
            sys.stderr.write(f"info: loading pack model {pack_id}\n")
            # Kokoro() insists on a voices file; the base one is fine because pack voices are passed as arrays.
            models[pack_id] = Kokoro(str(pack["model"]), voices_path,
                                     vocab_config=str(pack["vocab"]) if pack["vocab"] else None)
        return models[pack_id]

    class Handler(BaseHTTPRequestHandler):
        server_version = "tts-sidecar"

        def log_message(self, fmt, *args):  # keep stdout clean for the parent; log to stderr
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def send(self, code, body, ctype="application/json", headers=()):
            if isinstance(body, dict):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self.send(200, {"status": "ok"})
            elif self.path == "/voices":
                self.send(200, {"voices": voice_list, "details": details})
            else:
                self.send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/synthesize":
                return self.send(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", 0))
            except ValueError:
                length = -1
            if length <= 0:
                return self.send(400, {"error": "missing request body"})
            if length > MAX_BODY_BYTES:
                return self.send(413, {"error": "request body too large"})
            try:
                text, voice, speed = validate(json.loads(self.rfile.read(length)), voices)
            except json.JSONDecodeError:
                return self.send(400, {"error": "body is not valid JSON"})
            except ValueError as e:
                return self.send(422, {"error": str(e)})
            v = voices[voice]
            try:
                with lock:
                    samples, rate = model_for(v.pack).create(text, voice=v.style, speed=speed, lang=v.language)
            except Exception as e:  # e.g. text that yields no phonemes, or a pack model that fails to load
                sys.stderr.write(f"synthesis failed: {e!r}\n")
                return self.send(500, {"error": f"synthesis failed: {e}"})
            headers = [("X-TTS-Model", v.pack or "base")] + ([("X-TTS-Fallback", "1")] if v.fallback else [])
            self.send(200, to_wav(samples, rate), "audio/wav", headers)

    return Handler


def main():
    p = argparse.ArgumentParser(description="Talkerbox local TTS sidecar (kokoro-onnx)")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--model", required=True, help="path to kokoro-v1.0.onnx")
    p.add_argument("--voices", required=True, help="path to voices-v1.0.bin")
    p.add_argument("--voices-dir", help="optional directory with extra voices (*.npy, *.npz, *.bin, *.pt)")
    p.add_argument("--packs-dir", help="optional directory of language packs (subfolders with pack.json)")
    a = p.parse_args()

    for label, path in (("model", a.model), ("voices", a.voices)):
        if not os.path.isfile(path):
            sys.exit(f"error: {label} file not found: {path}")
    try:
        from kokoro_onnx import Kokoro
        from phonemizer.backend import EspeakBackend
        kokoro = Kokoro(a.model, a.voices)  # also points phonemizer at the bundled espeak-ng
        builtin = {k: kokoro.voices[k] for k in kokoro.voices.files}
        languages = set(EspeakBackend.supported_languages())
    except Exception as e:
        sys.exit(f"error: failed to load model/voices: {e}")

    # Precedence on id clashes: built-in > --voices-dir > packs (alphabetical by pack id).
    voices = {}

    def add(vid, voice):
        if vid in voices:
            warn(f"voice {vid!r} from {voice.source} ignored, already defined by {voices[vid].source}")
        else:
            voices[vid] = voice

    for vid, style in builtin.items():
        add(vid, Voice(style, None, VOICE_LANG.get(vid[0], "en-us"), False, "built-in voices"))
    if a.voices_dir:
        for vid, style in load_extra_voices(a.voices_dir).items():
            # No known language letter and no pack: base model with en-us phonemes, flagged as fallback.
            add(vid, Voice(style, None, VOICE_LANG.get(vid[0], "en-us"), vid[0] not in VOICE_LANG, "--voices-dir"))
    packs = load_packs(a.packs_dir, languages) if a.packs_dir else []
    for pack in packs:
        for vid, style in pack["voices"].items():
            add(vid, Voice(style, pack["id"], pack["language"], False, f"pack {pack['id']}"))

    try:
        handler = make_handler(kokoro, voices, {pk["id"]: pk for pk in packs}, a.voices)
        httpd = ThreadingHTTPServer(("127.0.0.1", a.port), handler)
    except OSError as e:
        sys.exit(f"error: cannot bind 127.0.0.1:{a.port}: {e}")
    httpd.daemon_threads = True

    def watch_stdin():
        # The parent closes our stdin (or dies) -> EOF -> shut down.
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:
            pass
        httpd.shutdown()

    threading.Thread(target=watch_stdin, daemon=True).start()
    print(f"READY port={httpd.server_address[1]}", flush=True)
    httpd.serve_forever()
    httpd.server_close()


if __name__ == "__main__":
    main()
