# Builds dist\tts-sidecar.exe (single file) plus the Tauri sidecar copy
# dist\tts-sidecar-x86_64-pc-windows-msvc.exe. Run from any directory.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$py = ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    py -3 -m venv .venv
    if ($LASTEXITCODE) { throw "creating venv failed (Python 3.10+ required)" }
}
& $py -m pip install -q -r requirements-dev.txt
if ($LASTEXITCODE) { throw "pip install failed" }

# --collect-all bundles package data PyInstaller cannot see as imports:
# espeak-ng.dll + espeak-ng-data, kokoro's config.json, phonemizer/language_tags data, onnxruntime DLLs.
& $py -m PyInstaller --noconfirm --clean --onefile --console --name tts-sidecar `
    --collect-all kokoro_onnx `
    --collect-all espeakng_loader `
    --collect-all phonemizer `
    --collect-all language_tags `
    --collect-all onnxruntime `
    tts_sidecar.py
if ($LASTEXITCODE) { throw "PyInstaller failed" }

Copy-Item dist\tts-sidecar.exe dist\tts-sidecar-x86_64-pc-windows-msvc.exe -Force
Get-Item dist\*.exe | ForEach-Object { "{0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB) }
