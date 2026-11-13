
Set-StrictMode -Version 2.0

function Get-PrimaryInstallLogPath {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is not set; cannot resolve primary install log path.'
  }
  return (Join-Path $env:LOCALAPPDATA 'DNAForge\logs\install.log')
}

function Get-DualWriteInstallLogPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
  )

  $dir = Split-Path -Parent $InstallerPath
  if ([string]::IsNullOrWhiteSpace($dir)) {
    throw "Cannot resolve installer directory for dual-write log: $InstallerPath"
  }
  return (Join-Path $dir 'dnaforge-install.log')
}

function Clear-DNAForgeInstallLogFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath
  )

  if (Test-Path -LiteralPath $LogPath) {
    Remove-Item -LiteralPath $LogPath -Force -ErrorAction Stop
  }
}

function Clear-DNAForgeInstallLogs {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
  )

  Clear-DNAForgeInstallLogFile -LogPath (Get-PrimaryInstallLogPath)
  Clear-DNAForgeInstallLogFile -LogPath (Get-DualWriteInstallLogPath -InstallerPath $InstallerPath)
}

function Read-InstallLogText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath
  )

  if (!(Test-Path -LiteralPath $LogPath)) {
    return $null
  }
  return [System.IO.File]::ReadAllText($LogPath)
}

function Test-InstallLogMarkers {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Content,

    [string[]]$MustContain = @(),

    [string[]]$MustNotContain = @()
  )

  $missing = @()
  foreach ($marker in $MustContain) {
    if ($Content -notlike "*$marker*") {
      $missing += $marker
    }
  }

  $unexpected = @()
  foreach ($marker in $MustNotContain) {
    if ($Content -like "*$marker*") {
      $unexpected += $marker
    }
  }

  return @{
    Ok = ($missing.Count -eq 0 -and $unexpected.Count -eq 0)
    Missing = $missing
    Unexpected = $unexpected
  }
}

function Test-InstallLogDirWritable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath
  )

  $dir = Split-Path -Parent $LogPath
  if ([string]::IsNullOrWhiteSpace($dir)) {
    return $false
  }

  try {
    if (!(Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null
    }
    $probe = Join-Path $dir ('.dnaforge-write-probe-' + [guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($probe, 'ok')
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Assert-HappyPathInstallLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [string]$DualWriteLogPath = ''
  )

  if (!(Test-Path -LiteralPath $LogPath)) {
    throw "T1: primary install log missing at $LogPath"
  }

  $info = Get-Item -LiteralPath $LogPath
  if ($info.Length -le 0) {
    throw "T1: primary install log is empty at $LogPath"
  }

  $content = Read-InstallLogText -LogPath $LogPath
  $check = Test-InstallLogMarkers -Content $content -MustContain @(
    'schema=1',
    'event=init',
    'event=install_complete'
  )
  if (!$check.Ok) {
    throw ("T1: primary install log missing markers [{0}]. Content:`n{1}" -f `
      ($check.Missing -join ', '), $content)
  }

  if ($DualWriteLogPath) {
    if (Test-InstallLogDirWritable -LogPath $DualWriteLogPath) {
      if (!(Test-Path -LiteralPath $DualWriteLogPath)) {
        throw "T1: dual-write install log missing at $DualWriteLogPath (installer dir is writable)"
      }
      $dual = Read-InstallLogText -LogPath $DualWriteLogPath
      $dualCheck = Test-InstallLogMarkers -Content $dual -MustContain @(
        'schema=1',
        'event=init'
      )
      if (!$dualCheck.Ok) {
        throw ("T1: dual-write install log missing markers [{0}]. Content:`n{1}" -f `
          ($dualCheck.Missing -join ', '), $dual)
      }
    }
  }
}

function Assert-FailurePathInstallLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PrimaryLogPath,

    [string]$DualWriteLogPath = ''
  )

  if (!(Test-Path -LiteralPath $PrimaryLogPath)) {
    throw "T2: primary install log missing at $PrimaryLogPath"
  }

  $content = Read-InstallLogText -LogPath $PrimaryLogPath
  if ([string]::IsNullOrWhiteSpace($content)) {
    throw "T2: primary install log is empty at $PrimaryLogPath"
  }

  $check = Test-InstallLogMarkers `
    -Content $content `
    -MustContain @('event=init') `
    -MustNotContain @('event=install_complete')
  if (!$check.Ok) {
    $parts = @()
    if ($check.Missing.Count -gt 0) {
      $parts += "missing [$($check.Missing -join ', ')]"
    }
    if ($check.Unexpected.Count -gt 0) {
      $parts += "unexpectedly contains [$($check.Unexpected -join ', ')]"
    }
    throw ("T2: primary install log $($parts -join '; '). Content:`n{0}" -f $content)
  }

  if ($DualWriteLogPath) {
    if (Test-InstallLogDirWritable -LogPath $DualWriteLogPath) {
      if (!(Test-Path -LiteralPath $DualWriteLogPath)) {
        throw "T2: dual-write install log missing at $DualWriteLogPath (installer dir is writable)"
      }
      $dual = Read-InstallLogText -LogPath $DualWriteLogPath
      if ([string]::IsNullOrWhiteSpace($dual)) {
        throw "T2: dual-write install log is empty at $DualWriteLogPath"
      }
      $dualCheck = Test-InstallLogMarkers `
        -Content $dual `
        -MustContain @('event=init') `
        -MustNotContain @('event=install_complete')
      if (!$dualCheck.Ok) {
        $parts = @()
        if ($dualCheck.Missing.Count -gt 0) {
          $parts += "missing [$($dualCheck.Missing -join ', ')]"
        }
        if ($dualCheck.Unexpected.Count -gt 0) {
          $parts += "unexpectedly contains [$($dualCheck.Unexpected -join ', ')]"
        }
        throw ("T2: dual-write install log $($parts -join '; '). Content:`n{0}" -f $dual)
      }
    }
  }
}

function Write-InstallLogDump {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$WriteLog,

    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
  )

  foreach ($path in @(
      (Get-PrimaryInstallLogPath),
      (Get-DualWriteInstallLogPath -InstallerPath $InstallerPath)
    )) {
    if (Test-Path -LiteralPath $path) {
      try {
        $text = Read-InstallLogText -LogPath $path
        & $WriteLog ("Install log dump ($path):`n$text")
      } catch {
        & $WriteLog "Install log dump failed for ${path}: $($_.Exception.Message)"
      }
    } else {
      & $WriteLog "Install log not present: $path"
    }
  }
}
