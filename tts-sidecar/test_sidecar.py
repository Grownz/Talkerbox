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


def write_oversized_voices(d):
    """Files that must be rejected without allocating their (claimed) size. Returns their stems."""
    liar = io.BytesIO()  # header claims an 8 GB array, body is 1 KB
    np.lib.format.write_array_header_1_0(liar, {"descr": "<f4", "fortran_order": False, "shape": (8_000_000, 1, 256)})
    liar.write(bytes(1024))
    (d / "liar_npy.npy").write_bytes(liar.getvalue())
    big = io.BytesIO()  # 20 MB of zeros, about 20 KB once deflated
    np.save(big, np.zeros((20_000, 1, 256), np.float32))
    with zipfile.ZipFile(d / "bomb.npz", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("bomb_a.npy", big.getvalue())
    with zipfile.ZipFile(d / "liar.bin", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("liar_b.npy", liar.getvalue())
    np.save(d / "too_many_rows.npy", np.zeros((2000, 1, 256), np.float32))  # 2 MB, but > 1024 rows
    return ["liar_npy", "bomb", "bomb_a", "liar_b", "too_many_rows"]


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
    np.save(d / "xx_test.npy", heart * 0.95)  # unknown first letter, no pack -> fallback
    np.save(d / "shared.npy", heart)  # clashes with pack voices: --voices-dir wins
    write_oversized_voices(d)
    return d


def write_pack(folder, meta, voices):
    folder.mkdir()
    (folder / "pack.json").write_text(json.dumps(meta), encoding="utf-8")
    for name, arr in voices.items():
        np.save(folder / name, arr)


@pytest.fixture(scope="module")
def packs_dir(tmp_path_factory):
    if not (MODEL.is_file() and VOICES.is_file()):
        pytest.skip("model files missing in models/")
    d = tmp_path_factory.mktemp("packs")
    with np.load(VOICES) as z:
        heart, emma = z["af_heart"], z["bf_emma"]
    # A fake German pack: the base model under another id, which tests the mechanics, not German quality.
    write_pack(d / "de-test", {"id": "de-test", "name": "German (test)", "language": "de",
                               "model": "model.onnx",
                               "voices": ["thorsten.npy", "both.npy", "shared.npy", "martin-v1.1.npy", "page.pt"]},
               {"thorsten.npy": heart * 0.9 + emma * 0.1, "both.npy": emma, "shared.npy": emma,
                "martin-v1.1.npy": emma})  # invalid id (dot): skipped, the rest of the pack stays
    (d / "de-test" / "page.pt").write_text("<!DOCTYPE html><html>Not found</html>")
    shutil.copy(MODEL, d / "de-test" / "model.onnx")
    write_pack(d / "aa-first", {"id": "aa-first", "name": "First", "language": "en-us", "model": "m.onnx",
                                "vocab": "vocab.json", "voices": ["both.npy", "af_heart.npy"]},
               {"both.npy": heart, "af_heart.npy": emma})
    try:
        os.link(d / "de-test" / "model.onnx", d / "aa-first" / "m.onnx")
    except OSError:
        shutil.copy(MODEL, d / "aa-first" / "m.onnx")
    import kokoro_onnx.config
    (d / "aa-first" / "vocab.json").write_text(json.dumps({"vocab": kokoro_onnx.config.DEFAULT_VOCAB}), encoding="utf-8")
    # Broken packs: all must be skipped and their voices not listed.
    write_pack(d / "bad-lang", {"id": "bad-lang", "name": "x", "language": "xx", "model": "m.onnx",
                                "voices": ["broken_a.npy"]}, {"broken_a.npy": heart})
    (d / "bad-lang" / "m.onnx").write_bytes(b"x")
    write_pack(d / "bad-model", {"id": "bad-model", "name": "x", "language": "de", "model": "missing.onnx",
                                 "voices": ["broken_b.npy"]}, {"broken_b.npy": heart})
    write_pack(d / "bad-escape", {"id": "bad-escape", "name": "x", "language": "de", "model": "../de-test/model.onnx",
                                  "voices": ["broken_c.npy"]}, {"broken_c.npy": heart})
    write_pack(d / "bad-voices", {"id": "bad-voices", "name": "x", "language": "de", "model": "m.onnx",
                                  "voices": ["missing.npy", "bad.id.npy"]}, {"bad.id.npy": heart})
    (d / "bad-voices" / "m.onnx").write_bytes(b"x")
    write_pack(d / "bad-json", {}, {"broken_d.npy": heart})
    (d / "bad-json" / "pack.json").write_text("{not json", encoding="utf-8")
    (d / "no-pack-json").mkdir()
    return d


def start_server(*extra, stderr=None):
    # Port 0 lets the OS pick a free port; READY reports the real one.
    proc = subprocess.Popen(command("--port", "0", "--model", str(MODEL), "--voices", str(VOICES), *extra),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
    line = proc.stdout.readline().strip()
    assert line.startswith("READY port="), f"unexpected startup line: {line!r}"
    return proc, f"http://127.0.0.1:{line.split('=')[1]}"


def stop_server(proc):
    proc.stdin.close()  # contract: closing stdin makes the sidecar exit
    assert proc.wait(timeout=15) == 0


@pytest.fixture(scope="module")
def server(voices_dir, packs_dir, tmp_path_factory):
    log = tmp_path_factory.mktemp("log") / "stderr.txt"
    with open(log, "w") as f:
        proc, url = start_server("--voices-dir", str(voices_dir), "--packs-dir", str(packs_dir), stderr=f)
        yield url, log
        stop_server(proc)


@pytest.fixture(scope="module")
def base_url(server):
    return server[0]


def request(url, body=None, want_headers=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status, headers, body = r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        status, headers, body = e.code, e.headers, e.read()
    return (status, headers, body) if want_headers else (status, headers.get("Content-Type"), body)


def synth(base_url, voice, text="Hello there."):
    return request(base_url + "/synthesize", {"text": text, "voice": voice, "speed": 1.0}, want_headers=True)


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
    assert not {"evil", "bad_shape", "garbage", "liar_npy", "bomb_a", "liar_b", "too_many_rows"} & set(voices)
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


def test_oversized_voice_files_rejected_fast(tmp_path):
    for stem in write_oversized_voices(tmp_path)[:1] + ["bomb", "liar", "too_many_rows"]:
        path = next(tmp_path.glob(stem + ".*"))
        t = time.perf_counter()
        with pytest.raises(ValueError, match="too large|expected shape"):
            tts_sidecar.load_voice_file(path)
        assert time.perf_counter() - t < 1.0, path.name
    huge_pt = np.zeros((3000, 1, 256), np.float32)  # 3 MB tensor with > 1024 rows
    fake_torch_save(tmp_path / "huge.pt", huge_pt)
    with pytest.raises(ValueError, match="expected shape"):
        tts_sidecar.load_voice_file(tmp_path / "huge.pt")
    np.save(tmp_path / "ok.npy", np.ones((510, 1, 256), np.float32))
    np.savez_compressed(tmp_path / "ok.npz", ok_a=np.ones((510, 1, 256), np.float32))
    assert tts_sidecar.load_voice_file(tmp_path / "ok.npy")["ok"].shape == (510, 1, 256)
    assert list(tts_sidecar.load_voice_file(tmp_path / "ok.npz")) == ["ok_a"]


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


def test_pack_model_loads_lazily_once(server):
    url, log = server
    assert "loading pack model" not in log.read_text()  # listed at startup, but no pack model loaded yet
    for _ in range(2):
        status, headers, body = synth(url, "thorsten", "Guten Tag, wie geht es dir?")
        assert status == 200 and body[:4] == b"RIFF" and headers["X-TTS-Model"] == "de-test"
        assert headers.get("X-TTS-Fallback") is None
    assert log.read_text().count("loading pack model de-test") == 1


def test_voice_details_and_precedence(server):
    url, log = server
    data = json.loads(request(url + "/voices")[2])
    details = {d["id"]: d for d in data["details"]}
    assert data["voices"] == sorted(details)
    assert details["af_heart"] == {"id": "af_heart", "pack": None, "language": "en-us", "fallback": False}
    assert details["bf_emma"]["language"] == "en-gb"
    assert details["thorsten"] == {"id": "thorsten", "pack": "de-test", "language": "de", "fallback": False}
    assert details["shared"]["pack"] is None  # --voices-dir beats packs
    assert details["both"]["pack"] == "aa-first"  # packs: alphabetical by pack id
    assert details["xx_test"] == {"id": "xx_test", "pack": None, "language": "en-us", "fallback": True}
    assert details["af_custom"]["fallback"] is False
    assert not {"broken_a", "broken_b", "broken_c", "broken_d"} & set(details)
    text = log.read_text()
    for pack in ("bad-lang", "bad-model", "bad-escape", "bad-json", "no-pack-json", "bad-voices"):
        assert f"warning: skipping pack {pack}:" in text
    assert "warning: skipping voice file martin-v1.1.npy in pack de-test:" in text
    assert "warning: skipping voice file page.pt in pack de-test:" in text
    assert "martin-v1.1" not in details and "page" not in details
    assert "voice 'both' from pack de-test ignored" in text


def test_synth_headers_for_precedence_and_fallback(server):
    url, _ = server
    _, h, _ = synth(url, "both")  # also exercises a pack with its own vocab.json
    assert h["X-TTS-Model"] == "aa-first"
    _, h, _ = synth(url, "shared")
    assert h["X-TTS-Model"] == "base" and h["X-TTS-Fallback"] == "1"  # 's' is no base language letter
    _, h, _ = synth(url, "af_custom")
    assert h["X-TTS-Model"] == "base" and h.get("X-TTS-Fallback") is None
    status, h, body = synth(url, "xx_test")
    assert status == 200 and body[:4] == b"RIFF"
    assert h["X-TTS-Model"] == "base" and h["X-TTS-Fallback"] == "1"


REAL_PACKS = HERE / "models" / "packs"  # optional real fine-tunes, see README


@pytest.mark.skipif(not (REAL_PACKS / "de-martin" / "pack.json").is_file(), reason="no real German pack")
def test_real_german_pack():
    proc, url = start_server("--packs-dir", str(REAL_PACKS))
    try:
        t = time.perf_counter()
        status, h, body = synth(url, "martin", "Guten Tag! Das ist ein Test der deutschen Stimme.")
        print(f"de-martin first synth incl. model load: {time.perf_counter() - t:.2f}s")
        assert status == 200 and body[:4] == b"RIFF" and h["X-TTS-Model"] == "de-martin"
        assert len(body) > 24000 * 2 and np.abs(np.frombuffer(body[44:], "<i2")).max() > 1000  # >1 s, audible
        (HERE / "models" / "de-martin-sample.wav").write_bytes(body)
    finally:
        stop_server(proc)


def test_missing_model_exits_nonzero():
    r = subprocess.run(command("--port", "0", "--model", "nope.onnx", "--voices", "nope.bin"),
                       capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "not found" in r.stderr
