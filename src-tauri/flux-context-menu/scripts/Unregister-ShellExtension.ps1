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

function Stop-InstalledFlux {
  $expectedPath = [System.IO.Path]::GetFullPath((Join-Path $InstallRoot 'flux.exe'))
  foreach ($process in @(Get-Process -Name 'flux' -ErrorAction SilentlyContinue)) {
    try {
      if (-not $process.Path -or [System.IO.Path]::GetFullPath($process.Path) -ine $expectedPath) { continue }
      $processId = $process.Id
      if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
        [void] $process.CloseMainWindow()
        if ($process.WaitForExit(2500)) {
          Write-Log "Closed FLUX desktop process $processId before uninstall."
          continue
        }
      }
      if (-not $process.HasExited) {
        $process.Kill()
        if (-not $process.WaitForExit(5000)) { throw "FLUX process $processId did not exit." }
      }
      Write-Log "Stopped FLUX desktop process $processId before uninstall."
    }
    catch {
      Write-Log "Could not stop FLUX desktop process $($process.Id) cleanly: $($_.Exception.Message)"
    }
  }
}

try {
  $InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  Stop-InstalledFlux
  $packages = @(Get-AppxPackage -Name 'FluxLocalConverterShell' -ErrorAction SilentlyContinue)
  foreach ($package in $packages) {
    Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
  }
  $certificateFile = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) 'FluxLocalConverterShell.cer'
  if (Test-Path -LiteralPath $certificateFile -PathType Leaf) {
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificateFile)
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
    if ($machineTrusted) {
      $trustHelper = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) 'Trust-ShellExtensionCertificate.ps1'
      $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $elevatedArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$trustHelper`" -InstallRoot `"$InstallRoot`" -Remove"
      try {
        $elevatedTrust = Start-Process -FilePath $powershell -ArgumentList $elevatedArguments -Verb RunAs -PassThru -Wait -WindowStyle Hidden
        if ($elevatedTrust.ExitCode -ne 0) { Write-Log "The machine certificate remains installed because the elevated cleanup exited $($elevatedTrust.ExitCode)." }
      }
      catch {
        Write-Log "The machine certificate remains installed because elevated cleanup was not approved: $($_.Exception.Message)"
      }
    }

    $userStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
      [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPeople,
      [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    try {
      $userStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
      $userCertificates = @($userStore.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint })
      foreach ($userCertificate in $userCertificates) { $userStore.Remove($userCertificate) }
    }
    finally {
      $userStore.Close()
    }
  }
  Write-Log 'Removed the FLUX sparse package and the current-user certificate registration.'
  exit 0
}
catch {
  Write-Log "Unregistration failed: $($_.Exception.Message)"
  exit 1
}
