$ErrorActionPreference = 'Stop'
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe = Join-Path $root 'src-tauri\target\release\flux.exe'
$manifest = Join-Path $root 'src-tauri\flux-context-menu\sparse\appxmanifest.xml'
$winapp = Join-Path $root 'node_modules\.bin\winapp.cmd'
foreach ($path in @($exe, $manifest, $winapp)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required shell identity build input is missing: $path" }
}

& $winapp embed-identity $exe --manifest $manifest
if ($LASTEXITCODE -ne 0) { throw "Could not embed the sparse package identity into flux.exe (WinApp CLI exit $LASTEXITCODE)." }
Write-Output "Embedded the FLUX sparse package identity into $exe"
