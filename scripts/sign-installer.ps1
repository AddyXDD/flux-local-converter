[CmdletBinding()]
param(
  [ValidateSet('online', 'offline')]
  [string] $Variant = 'online'
)

$ErrorActionPreference = 'Stop'
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config = Get-Content -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
$installer = Join-Path $root "src-tauri\target\release\bundle\nsis\FLUX_${version}_x64-setup.exe"
$shellExtension = Join-Path $root 'src-tauri\flux-context-menu\target\release\flux_context_menu.dll'
$sparsePackage = Join-Path $root 'src-tauri\flux-context-menu\sparse\FluxLocalConverterShell.msix'
$outputDirectory = Join-Path $root 'outputs'
$artifactStem = if ($Variant -eq 'offline') { "FLUX_${version}_x64-offline-setup" } else { "FLUX_${version}_x64-setup" }
$aliasName = if ($Variant -eq 'offline') { 'FLUX-Setup-Offline.exe' } else { 'FLUX-Setup.exe' }
$versionedName = "$artifactStem.exe"
$aliasInstaller = Join-Path $outputDirectory $aliasName
$versionedInstaller = Join-Path $outputDirectory $versionedName
$hashFile = Join-Path $outputDirectory "$versionedName.sha256"
$aliasHashFile = Join-Path $outputDirectory ($aliasName + '.sha256')
$pfx = if ([string]::IsNullOrWhiteSpace($env:FLUX_SHELL_SIGNING_PFX_PATH)) {
  Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing\FluxLocalConverterShell.pfx'
} else {
  [System.IO.Path]::GetFullPath($env:FLUX_SHELL_SIGNING_PFX_PATH)
}
$certificatePath = Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing\FluxLocalConverterShell.cer'
$password = $env:FLUX_SHELL_SIGNING_PASSWORD
$storeThumbprint = $env:FLUX_SHELL_SIGNING_THUMBPRINT
$signWithStore = -not [string]::IsNullOrWhiteSpace($storeThumbprint)
$winapp = Join-Path $root 'node_modules\.bin\winapp.cmd'
$storeSigner = Join-Path $root 'scripts\sign-with-store.ps1'

if (-not $signWithStore -and [string]::IsNullOrWhiteSpace($password)) { throw 'Set FLUX_SHELL_SIGNING_PASSWORD or FLUX_SHELL_SIGNING_THUMBPRINT to sign the Windows installer.' }
$requiredFiles = @($installer, $shellExtension, $sparsePackage, $certificatePath, $winapp)
if ($signWithStore) { $requiredFiles += $storeSigner } else { $requiredFiles += $pfx }
foreach ($path in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required installer-signing input is missing: $path" }
}

$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
if ($signWithStore -and $certificate.Thumbprint -ne ($storeThumbprint -replace '\s', '').ToUpperInvariant()) {
  throw 'The requested signer does not match the FLUX package certificate.'
}
function Assert-FluxSignature([string] $Path) {
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $verification = (& $winapp tool signtool verify /pa /v $Path 2>&1 | Out-String)
  }
  finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($verification -notmatch ("SHA1 hash:\s*" + [regex]::Escape($certificate.Thumbprint))) {
    throw "The shipped artifact is unsigned or has the wrong signer: $Path"
  }
}

# Tauri verifies the app executable at sign time in sign-binary.ps1. Its NSIS
# bundler restores the source copy after packaging, so the setup is the final
# artifact to verify here.
foreach ($path in @($shellExtension, $sparsePackage, $installer)) {
  Assert-FluxSignature $path
}

if ($signWithStore) {
  & $storeSigner -FilePath $installer -Thumbprint $certificate.Thumbprint
} else {
  & $winapp sign $installer $pfx --password $password
  if ($LASTEXITCODE -ne 0) { throw "Could not sign the FLUX installer (WinApp CLI exit $LASTEXITCODE)." }
}
Assert-FluxSignature $installer
Copy-Item -LiteralPath $installer -Destination $aliasInstaller -Force
Copy-Item -LiteralPath $installer -Destination $versionedInstaller -Force
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($versionedInstaller)
try {
  $hash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
}
finally {
  $stream.Dispose()
  $sha256.Dispose()
}
Set-Content -LiteralPath $hashFile -Value "$hash  $versionedName" -Encoding ASCII
Set-Content -LiteralPath $aliasHashFile -Value "$hash  $aliasName" -Encoding ASCII
Write-Output "Signed $Variant installer and wrote SHA-256 $hash to $versionedInstaller"
