"""End-to-end test: starts the sidecar and talks HTTP to it.

Runs the Python source by default; set SIDECAR_EXE=dist\\tts-sidecar.exe to test the built exe.
Needs models/kokoro-v1.0.onnx and models/voices-v1.0.bin (see README).
"""

import collections
import io
import json
import os
import pickle
import shutil
import subprocess
import sys
import time
import types
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pytest

import tts_sidecar

HERE = Path(__file__).parent
MODEL = HERE / "models" / "kokoro-v1.0.onnx"
VOICES = HERE / "models" / "voices-v1.0.bin"


def command(*args):
    exe = os.environ.get("SIDECAR_EXE")
    return ([exe] if exe else [sys.executable, str(HERE / "tts_sidecar.py")]) + list(args)


HF_PT = HERE / "models" / "hf_af_heart.pt"  # optional: a real hexgrad/Kokoro-82M voice, see README


def fake_torch_save(path, arr, prefix="archive"):
    """Write arr the way torch.save does (zip + pickle protocol 2), without torch installed."""
    torch, utils = types.ModuleType("torch"), types.ModuleType("torch._utils")

    class FloatStorage:
        pass

    def _rebuild_tensor_v2(*args):
        pass

    FloatStorage.__module__, FloatStorage.__qualname__ = "torch", "FloatStorage"
    _rebuild_tensor_v2.__module__, _rebuild_tensor_v2.__qualname__ = "torch._utils", "_rebuild_tensor_v2"
    torch.FloatStorage, torch._utils, utils._rebuild_tensor_v2 = FloatStorage, utils, _rebuild_tensor_v2

    class Tensor:
        def __reduce__(self):
            stride = tuple(int(np.prod(arr.shape[i + 1:])) for i in range(arr.ndim))
            return _rebuild_tensor_v2, (STORAGE, 0, arr.shape, stride, False, collections.OrderedDict())

    STORAGE = object()

    class Pickler(pickle.Pickler):
        def persistent_id(self, obj):
            return ("storage", FloatStorage, "0", "cpu", arr.size) if obj is STORAGE else None

    saved = {k: sys.modules.get(k) for k in ("torch", "torch._utils")}
    sys.modules.update({"torch": torch, "torch._utils": utils})
    try:
        buf = io.BytesIO()
        Pickler(buf, protocol=2).dump(Tensor())
    finally:
        for k, v in saved.items():
            sys.modules.pop(k) if v is None else sys.modules.__setitem__(k, v)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(f"{prefix}/data.pkl", buf.getvalue())
        z.writestr(f"{prefix}/byteorder", "little")
        z.writestr(f"{prefix}/data/0", arr.astype("<f4").tobytes())
        z.writestr(f"{prefix}/version", "3\n")


class Evil:
    def __init__(self, marker):
        self.marker = marker

    def __reduce__(self):
        return os.system, (f'echo pwned > "{self.marker}"',)


def write_evil_pt(path, marker):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("evil/data.pkl", pickle.dumps(Evil(marker), protocol=2))
        z.writestr("evil/byteorder", "little")


@pytest.fixture(scope="module")
def voices_dir(tmp_path_factory):
    if not VOICES.is_file():
        pytest.skip("model files missing in models/")
    d = tmp_path_factory.mktemp("voices")
    with np.load(VOICES) as z:
        heart, emma = z["af_heart"], z["bf_emma"]
    np.save(d / "af_custom.npy", heart * 0.9 + emma * 0.1)
    np.savez(d / "bundle.npz", bm_extra=emma, af_heart=np.zeros_like(heart))  # af_heart clash: built-in wins
    fake_torch_save(d / "xm_fake.pt", emma * 1.01, prefix="xm_fake")  # unknown letter x -> en-us
    write_evil_pt(d / "evil.pt", d / "PWNED.txt")
    np.save(d / "bad_shape.npy", np.zeros((3, 4), np.float32))
    (d / "garbage.bin").write_bytes(b"not a voice")
    if HF_PT.is_file():
        shutil.copy(HF_PT, d / "zf_real.pt")
    return d


@pytest.fixture(scope="module")
def base_url(voices_dir):
    if not (MODEL.is_file() and VOICES.is_file()):
        pytest.skip("model files missing in models/")
    # Port 0 lets the OS pick a free port; READY reports the real one.
    proc = subprocess.Popen(command("--port", "0", "--model", str(MODEL), "--voices", str(VOICES),
                                    "--voices-dir", str(voices_dir)),
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


def test_extra_voices_listed(base_url, voices_dir):
    voices = json.loads(request(base_url + "/voices")[2])["voices"]
    assert {"af_custom", "bm_extra", "xm_fake", "af_heart"} <= set(voices)
    assert voices.count("af_heart") == 1
    assert not {"evil", "bad_shape", "garbage"} & set(voices)
    assert ("zf_real" in voices) == HF_PT.is_file()
    assert not (voices_dir / "PWNED.txt").exists()


@pytest.mark.parametrize("voice", ["af_custom", "bm_extra", "xm_fake"] + (["zf_real"] if HF_PT.is_file() else []))
def test_synthesize_extra_voice(base_url, voice):
    status, ctype, body = request(base_url + "/synthesize", {"text": "Custom voice test.", "voice": voice, "speed": 1.0})
    assert status == 200 and body[:4] == b"RIFF" and len(body) > 10_000


def test_builtin_wins_on_clash(base_url):
    # The bundle's af_heart is all zeros; the real one must still produce audible speech.
    body = request(base_url + "/synthesize", {"text": "Hello there.", "voice": "af_heart", "speed": 1.0})[2]
    assert np.abs(np.frombuffer(body[44:], "<i2")).max() > 1000


def test_read_pt_roundtrip_and_rejects_malicious(tmp_path):
    arr = np.random.default_rng(0).standard_normal((510, 1, 256)).astype(np.float32)
    fake_torch_save(tmp_path / "v.pt", arr)
    assert np.array_equal(tts_sidecar.read_pt(tmp_path / "v.pt"), arr)
    write_evil_pt(tmp_path / "evil.pt", tmp_path / "PWNED.txt")
    with pytest.raises(pickle.UnpicklingError, match="forbidden global"):
        tts_sidecar.read_pt(tmp_path / "evil.pt")
    assert not (tmp_path / "PWNED.txt").exists()
    # Sanity check that the fixture is really malicious: plain pickle would run the (harmless) payload.
    pickle.loads(zipfile.ZipFile(tmp_path / "evil.pt").read("evil/data.pkl"))
    assert (tmp_path / "PWNED.txt").exists()
    if HF_PT.is_file():
        assert tts_sidecar.read_pt(HF_PT).shape == (510, 1, 256)


def test_missing_model_exits_nonzero():
    r = subprocess.run(command("--port", "0", "--model", "nope.onnx", "--voices", "nope.bin"),
                       capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "not found" in r.stderr
