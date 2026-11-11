"""Talkerbox local TTS sidecar: a tiny HTTP server around kokoro-onnx.

Usage: tts-sidecar --port <int> --model <kokoro-v1.0.onnx> --voices <voices-v1.0.bin> [--voices-dir <dir>]
Binds 127.0.0.1 only. Prints "READY port=<port>" once serving and exits when stdin closes.
"""

import argparse
import collections
import io
import json
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


def check_style(arr):
    """Validate a Kokoro voice: float style vectors of shape (N, 1, 256)."""
    if not isinstance(arr, np.ndarray) or arr.ndim != 3 or arr.shape[0] < 1 or arr.shape[1:] != (1, STYLE_DIM):
        raise ValueError(f"expected shape (N, 1, {STYLE_DIM}), got {getattr(arr, 'shape', type(arr).__name__)}")
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
        count = int(np.prod(t.size))
        contiguous = tuple(int(np.prod(t.size[i + 1:])) for i in range(len(t.size)))
        # shortcut: only contiguous tensors (what torch.save of a plain voice produces); add strides if a file needs it
        if t.stride != contiguous or not 0 <= t.offset <= t.offset + count <= t.storage.numel:
            raise ValueError("unsupported tensor layout")
        entry = prefix + "data/" + t.storage.key
        if entry not in names or z.getinfo(entry).file_size != t.storage.numel * 4:
            raise ValueError("tensor data missing or wrong size")
        data = np.frombuffer(z.read(entry), dtype="<f4")
    return data[t.offset: t.offset + count].reshape(t.size)


def load_extra_voices(directory):
    """Load *.npy / *.npz / *.bin / *.pt voices from a directory. Bad files are skipped with a warning."""
    voices = {}
    try:
        paths = sorted(Path(directory).iterdir())
    except OSError as e:
        sys.stderr.write(f"warning: cannot read voices dir {directory}: {e}\n")
        return voices
    for path in paths:
        ext = path.suffix.lower()
        if not path.is_file() or ext not in (".npy", ".npz", ".bin", ".pt"):
            continue
        try:
            if ext == ".npy":
                found = {path.stem: np.load(path, allow_pickle=False)}
            elif ext == ".pt":
                found = {path.stem: read_pt(path)}
            else:
                if not zipfile.is_zipfile(path):
                    raise ValueError("not an npz bundle")
                with np.load(path, allow_pickle=False) as bundle:
                    found = {k: bundle[k] for k in bundle.files}
            checked = {}
            for vid, arr in found.items():
                if not VOICE_ID.fullmatch(vid):
                    raise ValueError(f"invalid voice id {vid!r}")
                checked[vid] = check_style(arr)
            voices.update(checked)
        except Exception as e:
            sys.stderr.write(f"warning: skipping voice file {path.name}: {e}\n")
    return voices


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


def make_handler(kokoro, voices):
    lock = threading.Lock()  # one inference at a time; onnxruntime already uses all cores

    class Handler(BaseHTTPRequestHandler):
        server_version = "tts-sidecar"

        def log_message(self, fmt, *args):  # keep stdout clean for the parent; log to stderr
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def send(self, code, body, ctype="application/json"):
            if isinstance(body, dict):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self.send(200, {"status": "ok"})
            elif self.path == "/voices":
                self.send(200, {"voices": voices})
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
            try:
                with lock:
                    samples, rate = kokoro.create(text, voice=voice, speed=speed,
                                                  lang=VOICE_LANG.get(voice[0], "en-us"))
            except Exception as e:  # e.g. text that yields no phonemes
                sys.stderr.write(f"synthesis failed: {e!r}\n")
                return self.send(500, {"error": f"synthesis failed: {e}"})
            self.send(200, to_wav(samples, rate), "audio/wav")

    return Handler


def main():
    p = argparse.ArgumentParser(description="Talkerbox local TTS sidecar (kokoro-onnx)")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--model", required=True, help="path to kokoro-v1.0.onnx")
    p.add_argument("--voices", required=True, help="path to voices-v1.0.bin")
    p.add_argument("--voices-dir", help="optional directory with extra voices (*.npy, *.npz, *.bin, *.pt)")
    a = p.parse_args()

    for label, path in (("model", a.model), ("voices", a.voices)):
        if not os.path.isfile(path):
            sys.exit(f"error: {label} file not found: {path}")
    try:
        from kokoro_onnx import Kokoro
        kokoro = Kokoro(a.model, a.voices)
        builtin = {k: kokoro.voices[k] for k in kokoro.voices.files}
    except Exception as e:
        sys.exit(f"error: failed to load model/voices: {e}")
    if a.voices_dir:
        extra = load_extra_voices(a.voices_dir)
        for vid in sorted(extra.keys() & builtin.keys()):
            sys.stderr.write(f"warning: extra voice {vid!r} ignored, a built-in voice has that id\n")
        kokoro.voices = {**extra, **builtin}  # built-in voices win on id clashes
    voices = kokoro.get_voices()

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(kokoro, voices))
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
