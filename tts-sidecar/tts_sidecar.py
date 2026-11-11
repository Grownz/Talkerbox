"""Talkerbox local TTS sidecar: a tiny HTTP server around kokoro-onnx.

Usage: tts-sidecar --port <int> --model <kokoro-v1.0.onnx> --voices <voices-v1.0.bin>
Binds 127.0.0.1 only. Prints "READY port=<port>" once serving and exits when stdin closes.
"""

import argparse
import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MAX_TEXT_CHARS = 2000
MAX_BODY_BYTES = 64 * 1024
MIN_SPEED, MAX_SPEED = 0.5, 2.0

# Kokoro voice names start with a language letter, e.g. "af_heart" -> American English.
VOICE_LANG = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi",
              "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}


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
    a = p.parse_args()

    for label, path in (("model", a.model), ("voices", a.voices)):
        if not os.path.isfile(path):
            sys.exit(f"error: {label} file not found: {path}")
    try:
        from kokoro_onnx import Kokoro
        kokoro = Kokoro(a.model, a.voices)
        voices = kokoro.get_voices()
    except Exception as e:
        sys.exit(f"error: failed to load model/voices: {e}")

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
