param(
  [Parameter(Mandatory = $true)]
  [string] $BinaryPath
)

$ErrorActionPreference = 'Stop'
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binary = [System.IO.Path]::GetFullPath($BinaryPath)
$pfx = Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing\FluxLocalConverterShell.pfx'
$password = $env:FLUX_SHELL_SIGNING_PASSWORD
$winapp = Join-Path $root 'node_modules\.bin\winapp.cmd'
$certificatePath = Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing\FluxLocalConverterShell.cer'

if ([string]::IsNullOrWhiteSpace($password)) { throw 'Set FLUX_SHELL_SIGNING_PASSWORD to sign the Windows application binary.' }
foreach ($path in @($binary, $pfx, $certificatePath, $winapp)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required binary-signing input is missing: $path" }
}

$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
& $winapp sign $binary $pfx --password $password
if ($LASTEXITCODE -ne 0) { throw "Could not sign $binary (WinApp CLI exit $LASTEXITCODE)." }
$previousErrorAction = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $verification = (& $winapp tool signtool verify /pa /v $binary 2>&1 | Out-String)
}
finally {
  $ErrorActionPreference = $previousErrorAction
}
if ($verification -notmatch ("SHA1 hash:\s*" + [regex]::Escape($certificate.Thumbprint))) {
  throw "Windows could not confirm the FLUX signing certificate on $binary. Details: $verification"
}
