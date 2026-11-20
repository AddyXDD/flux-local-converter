[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $InstallRoot
)

$ErrorActionPreference = 'Stop'
$logDirectory = Join-Path $env:LOCALAPPDATA 'FLUX'
$logPath = Join-Path $logDirectory 'shell-extension-install.log'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-Log([string] $Message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

try {
  $InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $packagePath = Join-Path $InstallRoot 'FluxLocalConverterShell.msix'
  $certificatePath = Join-Path $InstallRoot 'FluxLocalConverterShell.cer'
  $executablePath = Join-Path $InstallRoot 'flux.exe'
  $dllPath = Join-Path $InstallRoot 'flux-context-menu.dll'
  foreach ($path in @($packagePath, $certificatePath, $executablePath, $dllPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required compact-menu file is missing: $path" }
  }

  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificatePath)
  if ($certificate.Subject -ne 'CN=FLUX Local') { throw "Unexpected package certificate subject: $($certificate.Subject)" }
  $machineStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPeople,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  )
  try {
    $machineStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $machineTrusted = @($machineStore.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint }).Count -gt 0
  }
  finally {
    $machineStore.Close()
  }
  if (-not $machineTrusted) {
    $trustHelper = Join-Path $InstallRoot 'Trust-ShellExtensionCertificate.ps1'
    if (-not (Test-Path -LiteralPath $trustHelper -PathType Leaf)) { throw "Certificate trust helper is missing: $trustHelper" }
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $elevatedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$trustHelper`" -InstallRoot `"$InstallRoot`""
    $elevatedTrust = Start-Process -FilePath $powershell -ArgumentList $elevatedArguments -Verb RunAs -PassThru -Wait -WindowStyle Hidden
    if ($elevatedTrust.ExitCode -ne 0) { throw "The FLUX certificate trust step was not completed (elevated helper exit $($elevatedTrust.ExitCode))." }
  }

  $userStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPeople,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  try {
    $userStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $userTrusted = $userStore.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint } | Select-Object -First 1
    if (-not $userTrusted) { $userStore.Add($certificate) }
  }
  finally {
    $userStore.Close()
  }

  # Windows requires the prior sparse package registration to be removed before
  # reinstalling the same package version. This also makes repair installs safe.
  $existingPackages = @(Get-AppxPackage -Name 'FluxLocalConverterShell' -ErrorAction SilentlyContinue)
  foreach ($existingPackage in $existingPackages) {
    Remove-AppxPackage -Package $existingPackage.PackageFullName -ErrorAction Stop
  }

  Add-AppxPackage -Path $packagePath -ExternalLocation $InstallRoot -ErrorAction Stop
  $registered = Get-AppxPackage -Name 'FluxLocalConverterShell' | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $registered) { throw 'Windows did not register the FLUX sparse package.' }
  if ($registered.Version.ToString() -ne '0.1.5.0') { throw "Unexpected sparse package version: $($registered.Version)" }

  [xml] $manifest = Get-AppxPackageManifest -Package $registered.PackageFullName
  $namespaces = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
  $namespaces.AddNamespace('desktop4', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/4')
  $namespaces.AddNamespace('desktop5', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/5')
  $namespaces.AddNamespace('com', 'http://schemas.microsoft.com/appx/manifest/com/windows10')
  $verb = $manifest.SelectSingleNode("//desktop4:Extension[@Category='windows.fileExplorerContextMenus']/desktop4:FileExplorerContextMenus/desktop5:ItemType/desktop5:Verb[@Id='FLUXConvert' and @Clsid='6e94a2d5-68d6-4c0a-9e5d-07f5b9f0a241']", $namespaces)
  $class = $manifest.SelectSingleNode("//com:Class[@Id='6e94a2d5-68d6-4c0a-9e5d-07f5b9f0a241' and @Path='flux-context-menu.dll']", $namespaces)
  if (-not $verb -or -not $class) { throw 'The installed package is missing the FLUX Explorer command registration.' }

  Write-Log "Registered package $($registered.PackageFullName) at external location $InstallRoot. Certificate $($certificate.Thumbprint) is in LocalMachine TrustedPeople."
  exit 0
}
catch {
  Write-Log "Registration failed: $($_.Exception.Message)"
  exit 1
}
