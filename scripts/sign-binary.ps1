param(
  [Parameter(Mandatory = $true)]
  [string] $BinaryPath
)

$ErrorActionPreference = 'Stop'
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binary = [System.IO.Path]::GetFullPath($BinaryPath)
$pfx = if ([string]::IsNullOrWhiteSpace($env:FLUX_SHELL_SIGNING_PFX_PATH)) {
  Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing\FluxLocalConverterShell.pfx'
} else {
  [System.IO.Path]::GetFullPath($env:FLUX_SHELL_SIGNING_PFX_PATH)
}
$password = $env:FLUX_SHELL_SIGNING_PASSWORD
$storeThumbprint = $env:FLUX_SHELL_SIGNING_THUMBPRINT
$signWithStore = -not [string]::IsNullOrWhiteSpace($storeThumbprint)
$winapp = Join-Path $root 'node_modules\.bin\winapp.cmd'
$storeSigner = Join-Path $root 'scripts\sign-with-store.ps1'
$certificatePath = Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing\FluxLocalConverterShell.cer'

if (-not $signWithStore -and [string]::IsNullOrWhiteSpace($password)) { throw 'Set FLUX_SHELL_SIGNING_PASSWORD or FLUX_SHELL_SIGNING_THUMBPRINT to sign the Windows application binary.' }
$requiredFiles = @($binary, $certificatePath)
if ($signWithStore) { $requiredFiles += $storeSigner } else { $requiredFiles += @($pfx, $winapp) }
foreach ($path in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required binary-signing input is missing: $path" }
}

$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
if ($signWithStore) {
  if ($certificate.Thumbprint -ne ($storeThumbprint -replace '\s', '').ToUpperInvariant()) { throw 'The requested signer does not match the FLUX package certificate.' }
  & $storeSigner -FilePath $binary -Thumbprint $certificate.Thumbprint
} else {
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
}
