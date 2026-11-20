$ErrorActionPreference = 'Stop'
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tauriRoot = Join-Path $root 'src-tauri'
$extensionRoot = Join-Path $tauriRoot 'flux-context-menu'
$manifest = Join-Path $extensionRoot 'sparse\appxmanifest.xml'
$package = Join-Path $extensionRoot 'sparse\FluxLocalConverterShell.msix'
$signingRoot = Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing'
$pfx = if ([string]::IsNullOrWhiteSpace($env:FLUX_SHELL_SIGNING_PFX_PATH)) {
  Join-Path $signingRoot 'FluxLocalConverterShell.pfx'
} else {
  [System.IO.Path]::GetFullPath($env:FLUX_SHELL_SIGNING_PFX_PATH)
}
$cer = Join-Path $signingRoot 'FluxLocalConverterShell.cer'
$stagedCer = Join-Path $extensionRoot 'sparse\FluxLocalConverterShell.cer'
$trustHelper = Join-Path $extensionRoot 'scripts\Trust-ShellExtensionCertificate.ps1'
$password = $env:FLUX_SHELL_SIGNING_PASSWORD
$storeThumbprint = $env:FLUX_SHELL_SIGNING_THUMBPRINT
$signWithStore = -not [string]::IsNullOrWhiteSpace($storeThumbprint)
$winapp = Join-Path $root 'node_modules\.bin\winapp.cmd'
$storeSigner = Join-Path $root 'scripts\sign-with-store.ps1'

if (-not $signWithStore -and [string]::IsNullOrWhiteSpace($password)) {
  throw 'Set FLUX_SHELL_SIGNING_PASSWORD for the local shell-extension PFX. The PFX must remain outside the project and installer.'
}
if (-not $signWithStore -and -not (Test-Path -LiteralPath $pfx -PathType Leaf)) {
  throw "The local signing key is missing: $pfx"
}
if (-not (Test-Path -LiteralPath $cer -PathType Leaf)) {
  throw "The public signing certificate is missing: $cer"
}
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
  throw "The sparse package manifest is missing: $manifest"
}
if (-not (Test-Path -LiteralPath $winapp -PathType Leaf)) {
  throw 'WinApp CLI is missing. Run npm install before building FLUX.'
}
if ($signWithStore -and -not (Test-Path -LiteralPath $storeSigner -PathType Leaf)) {
  throw "The certificate-store signing helper is missing: $storeSigner"
}

$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cer)
if ($certificate.Subject -ne 'CN=FLUX Local') {
  throw "The shell-extension certificate subject '$($certificate.Subject)' does not match the package publisher 'CN=FLUX Local'."
}
if ($signWithStore -and $certificate.Thumbprint -ne ($storeThumbprint -replace '\s', '').ToUpperInvariant()) {
  throw 'The selected certificate-store signer does not match the sparse package publisher certificate.'
}
$trustHelperText = Get-Content -LiteralPath $trustHelper -Raw
if ($trustHelperText -notmatch [regex]::Escape($certificate.Thumbprint)) {
  throw 'The package certificate does not match the thumbprint pinned by the elevated trust helper.'
}

$cargo = Get-Command cargo.exe -ErrorAction Stop
& $cargo.Source build --release --manifest-path (Join-Path $extensionRoot 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "The native Explorer extension failed to build (cargo exit $LASTEXITCODE)." }

$dll = Join-Path $extensionRoot 'target\release\flux_context_menu.dll'
if ($signWithStore) {
  & $storeSigner -FilePath $dll -Thumbprint $certificate.Thumbprint
} else {
  & $winapp sign $dll $pfx --password $password
  if ($LASTEXITCODE -ne 0) { throw "The native Explorer extension failed to sign (WinApp CLI exit $LASTEXITCODE)." }
}

Copy-Item -LiteralPath $cer -Destination $stagedCer -Force
if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package -Force }
if ($signWithStore) {
  & $winapp package $manifest --no-sign --output $package
} else {
  & $winapp package $manifest --cert $pfx --cert-password $password --output $package
}
if ($LASTEXITCODE -ne 0) { throw "The sparse identity package failed to build (WinApp CLI exit $LASTEXITCODE)." }
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw 'WinApp CLI did not produce the signed sparse package.' }
if ($signWithStore) { & $storeSigner -FilePath $package -Thumbprint $certificate.Thumbprint }

Write-Output "Built native shell extension and signed sparse package: $package"
