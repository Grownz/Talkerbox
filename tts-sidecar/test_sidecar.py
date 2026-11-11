"""End-to-end test: starts the sidecar and talks HTTP to it.

Runs the Python source by default; set SIDECAR_EXE=dist\\tts-sidecar.exe to test the built exe.
Needs models/kokoro-v1.0.onnx and models/voices-v1.0.bin (see README).
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

HERE = Path(__file__).parent
MODEL = HERE / "models" / "kokoro-v1.0.onnx"
VOICES = HERE / "models" / "voices-v1.0.bin"


def command(*args):
    exe = os.environ.get("SIDECAR_EXE")
    return ([exe] if exe else [sys.executable, str(HERE / "tts_sidecar.py")]) + list(args)


@pytest.fixture(scope="module")
def base_url():
    if not (MODEL.is_file() and VOICES.is_file()):
        pytest.skip("model files missing in models/")
    # Port 0 lets the OS pick a free port; READY reports the real one.
    proc = subprocess.Popen(command("--port", "0", "--model", str(MODEL), "--voices", str(VOICES)),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    line = proc.stdout.readline().strip()
    assert line.startswith("READY port="), f"unexpected startup line: {line!r}"
    yield f"http://127.0.0.1:{line.split('=')[1]}"
    proc.stdin.close()  # contract: closing stdin makes the sidecar exit
    assert proc.wait(timeout=15) == 0


def request(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.headers.get("Content-Type"), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()


def test_health(base_url):
    status, _, body = request(base_url + "/health")
    assert status == 200 and json.loads(body) == {"status": "ok"}


def test_voices(base_url):
    status, _, body = request(base_url + "/voices")
    assert status == 200 and "af_heart" in json.loads(body)["voices"]


def test_synthesize(base_url):
    t = time.perf_counter()
    status, ctype, body = request(base_url + "/synthesize",
                                  {"text": "Hello from Talkerbox.", "voice": "af_heart", "speed": 1.0})
    print(f"synth latency: {time.perf_counter() - t:.2f}s, {len(body)} bytes")
    assert status == 200 and ctype == "audio/wav"
    assert body[:4] == b"RIFF" and body[8:12] == b"WAVE"
    assert int.from_bytes(body[22:24], "little") == 1   # mono
    assert int.from_bytes(body[34:36], "little") == 16  # 16-bit
    assert len(body) > 10_000


@pytest.mark.parametrize("payload", [
    {"text": "", "voice": "af_heart", "speed": 1.0},
    {"text": "hi", "voice": "nope", "speed": 1.0},
    {"text": "hi", "voice": "af_heart", "speed": 5},
    {"text": "x" * 2001, "voice": "af_heart", "speed": 1.0},
    ["not", "an", "object"],
])
def test_rejects_bad_request(base_url, payload):
    status, ctype, body = request(base_url + "/synthesize", payload)
    assert status == 422 and ctype == "application/json" and "error" in json.loads(body)


def test_missing_model_exits_nonzero():
    r = subprocess.run(command("--port", "0", "--model", "nope.onnx", "--voices", "nope.bin"),
                       capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "not found" in r.stderr
