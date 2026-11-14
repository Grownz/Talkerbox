# Copies the Vosk runtime DLLs next to this script and builds the MSVC import library libvosk.lib.
# Source: the `vosk` folder of a pip-installed vosk 0.3.45 wheel; pass it with -From (see README, "Set up the Vosk runtime").
# Run from a normal PowerShell; Visual Studio Build Tools must be installed (lib.exe, dumpbin.exe).
param([Parameter(Mandatory)][string]$From)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $From 'libvosk.dll'))) { throw "libvosk.dll not found in '$From': pass the vosk folder of a pip-installed vosk 0.3.45 (see README, step 2)" }
$dlls = 'libvosk.dll', 'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll'
foreach ($d in $dlls) { Copy-Item (Join-Path $From $d) $PSScriptRoot -Force }

$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath
$bin = (Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Hostx64\x64\lib.exe" | Select-Object -Last 1).DirectoryName
$exports = & "$bin\dumpbin.exe" /exports "$PSScriptRoot\libvosk.dll" |
    Where-Object { $_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]{8}\s+(vosk_\S+)' } | ForEach-Object { $Matches[1] }
@('LIBRARY libvosk', 'EXPORTS') + $exports | Set-Content "$PSScriptRoot\libvosk.def" -Encoding ascii
& "$bin\lib.exe" /nologo /def:"$PSScriptRoot\libvosk.def" /machine:x64 /out:"$PSScriptRoot\libvosk.lib"
Remove-Item "$PSScriptRoot\libvosk.exp", "$PSScriptRoot\libvosk.def" -ErrorAction SilentlyContinue
Write-Host "Vosk runtime ready in $PSScriptRoot ($($exports.Count) exports)"
