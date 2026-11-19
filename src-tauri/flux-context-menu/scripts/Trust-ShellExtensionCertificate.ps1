[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $InstallRoot,
  [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$logDirectory = Join-Path $env:LOCALAPPDATA 'FLUX'
$logPath = Join-Path $logDirectory 'shell-extension-install.log'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-Log([string] $Message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

try {
  $InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
  $certificatePath = Join-Path $InstallRoot 'FluxLocalConverterShell.cer'
  if (-not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) { throw "The FLUX public certificate is missing: $certificatePath" }
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
  if ($certificate.Subject -ne 'CN=FLUX Local') { throw "Unexpected certificate subject: $($certificate.Subject)" }
  if ($certificate.Thumbprint -ne '5D7B7632542A0F8ACB03EDC5982F44564735DF06') { throw "Unexpected FLUX certificate thumbprint: $($certificate.Thumbprint)" }
  $basicConstraints = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' } | Select-Object -First 1
  if ($basicConstraints -and ([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]$basicConstraints).CertificateAuthority) {
    throw 'The FLUX package signer must not be a certificate authority.'
  }

  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPeople,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $existing = @($store.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint })
    if ($Remove) {
      foreach ($existingCertificate in $existing) { $store.Remove($existingCertificate) }
      Write-Log "Removed package signer $($certificate.Thumbprint) from LocalMachine TrustedPeople."
    }
    elseif ($existing.Count -eq 0) {
      $store.Add($certificate)
      Write-Log "Trusted package signer $($certificate.Thumbprint) in LocalMachine TrustedPeople."
    }
    else {
      Write-Log "Package signer $($certificate.Thumbprint) was already trusted in LocalMachine TrustedPeople."
    }
  }
  finally {
    $store.Close()
  }
  exit 0
}
catch {
  Write-Log "Elevated certificate operation failed: $($_.Exception.Message)"
  exit 1
}
