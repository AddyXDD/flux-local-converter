param(
  [Parameter(Mandatory = $true)]
  [string] $FilePath,
  [Parameter(Mandatory = $true)]
  [string] $Thumbprint
)

$ErrorActionPreference = 'Stop'
$file = [System.IO.Path]::GetFullPath($FilePath)
$expectedThumbprint = ($Thumbprint -replace '\s', '').ToUpperInvariant()
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
  [System.Security.Cryptography.X509Certificates.StoreName]::My,
  [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
)
try {
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
  $certificate = $store.Certificates.Find(
    [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
    $expectedThumbprint,
    $false
  ) | Select-Object -First 1
}
finally {
  $store.Close()
}
if (-not $certificate -or -not $certificate.HasPrivateKey) {
  throw "The FLUX signing certificate with thumbprint $expectedThumbprint is not available with its private key in CurrentUser\My."
}

$sdkRoot = Join-Path ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)) 'Windows Kits\10\bin'
$signtool = Get-ChildItem -LiteralPath $sdkRoot -Filter 'signtool.exe' -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Directory.Name -eq 'x64' } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $signtool) { throw "Windows SDK signtool.exe was not found under $sdkRoot." }

& $signtool.FullName sign /sha1 $expectedThumbprint /s My /fd SHA256 $file
if ($LASTEXITCODE -ne 0) { throw "signtool could not sign $file (exit $LASTEXITCODE)." }

$verification = (& $signtool.FullName verify /pa /v $file 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $verification -notmatch ("SHA1 hash:\s*" + [regex]::Escape($expectedThumbprint))) {
  throw "The FLUX signature did not verify after signing: $file. Details: $verification"
}
Write-Output "Signed and verified $file with $expectedThumbprint."
