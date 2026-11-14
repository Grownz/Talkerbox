# Builds dist\tts-sidecar.exe (single file) plus the Tauri sidecar copy
# dist\tts-sidecar-x86_64-pc-windows-msvc.exe. Run from any directory.
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot

$py = ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    py -3 -m venv .venv
    if ($LASTEXITCODE) { throw "creating venv failed (Python 3.10+ required)" }
}
& $py -m pip install -q -r requirements-lock.txt
if ($LASTEXITCODE) { throw "pip install failed" }

# --collect-all bundles package data PyInstaller cannot see as imports:
# espeak-ng.dll + espeak-ng-data, kokoro's config.json, phonemizer/language_tags data, onnxruntime DLLs.
# All espeak-ng language data stays (language packs may use any language).
# Size: --collect-all onnxruntime also pulls its optional Python tooling (transformers/quantization/tools,
# which import sympy/mpmath) plus dev packages from the venv (pytest, pygments, setuptools). None of these
# are used at runtime, so they are excluded; ssl/_hashlib too (the sidecar never makes network calls and
# hashlib falls back to its built-in algorithms), which drops OpenSSL's DLLs. UPX is deliberately not used (AV false positives, slower start).
$exclude = @(
    "onnxruntime.tools", "onnxruntime.transformers", "onnxruntime.quantization",
    "sympy", "mpmath", "pygments", "pytest", "_pytest", "setuptools", "pkg_resources",
    "distutils", "pydoc_data", "tkinter", "pyreadline3", "ssl", "_ssl", "_hashlib"
) | ForEach-Object { "--exclude-module", $_ }
& $py -m PyInstaller --noconfirm --clean --onefile --console --noupx --name tts-sidecar `
    --collect-all kokoro_onnx `
    --collect-all espeakng_loader `
    --collect-all phonemizer `
    --collect-all language_tags `
    --collect-all onnxruntime `
    @exclude `
    tts_sidecar.py
if ($LASTEXITCODE) { throw "PyInstaller failed" }

Copy-Item dist\tts-sidecar.exe dist\tts-sidecar-x86_64-pc-windows-msvc.exe -Force
Get-Item dist\*.exe | ForEach-Object { "{0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB) }

Pop-Location
