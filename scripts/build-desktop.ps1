[CmdletBinding()]
param(
  [ValidateSet('online', 'offline')]
  [string] $Variant = 'online'
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tauri = Join-Path $root 'node_modules\.bin\tauri.cmd'
$signer = Join-Path $root 'scripts\sign-installer.ps1'
$configArgs = @()
$temporaryConfig = $null

if ([string]::IsNullOrWhiteSpace($env:FLUX_SHELL_SIGNING_THUMBPRINT)) {
  $certificatePath = Join-Path $env:LOCALAPPDATA 'FLUX-Shell-Extension-Signing\FluxLocalConverterShell.cer'
  if (Test-Path -LiteralPath $certificatePath -PathType Leaf) {
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
      [System.Security.Cryptography.X509Certificates.StoreName]::My,
      [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    try {
      $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
      $privateKey = $store.Certificates.Find(
        [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
        $certificate.Thumbprint,
        $false
      ) | Select-Object -First 1
    }
    finally { $store.Close() }
    if ($certificate.Subject -eq 'CN=FLUX Local' -and $privateKey -and $privateKey.HasPrivateKey) {
      $env:FLUX_SHELL_SIGNING_THUMBPRINT = $certificate.Thumbprint
    }
  }
}

if ($Variant -eq 'online') {
  $temporaryConfig = Join-Path ([System.IO.Path]::GetTempPath()) "flux-webview-bootstrapper-$PID.json"
  $json = '{"bundle":{"windows":{"webviewInstallMode":{"type":"downloadBootstrapper","silent":true}}}}'
  [System.IO.File]::WriteAllText($temporaryConfig, $json, [System.Text.UTF8Encoding]::new($false))
  $configArgs = @('--config', $temporaryConfig)
}

try {
  if (-not (Test-Path -LiteralPath $tauri -PathType Leaf)) { throw "Tauri CLI was not found: $tauri" }
  & $tauri build @configArgs --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "Tauri app build failed with exit code $LASTEXITCODE" }

  & $tauri bundle @configArgs --bundles nsis --ci --no-binary-patching
  if ($LASTEXITCODE -ne 0) { throw "Tauri installer bundling failed with exit code $LASTEXITCODE" }

  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $signer -Variant $Variant
  if ($LASTEXITCODE -ne 0) { throw "Installer signing failed with exit code $LASTEXITCODE" }
}
finally {
  if ($temporaryConfig -and (Test-Path -LiteralPath $temporaryConfig)) {
    Remove-Item -LiteralPath $temporaryConfig -Force
  }
}
