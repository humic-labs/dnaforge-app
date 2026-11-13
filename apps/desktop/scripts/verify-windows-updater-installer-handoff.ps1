param(
  [Parameter(Mandatory = $true)][string]$PreviousInstallerPath,
  [Parameter(Mandatory = $true)][string]$CandidateInstallerPath,
  [Parameter(Mandatory = $true)][string]$PreviousVersion,
  [Parameter(Mandatory = $true)][string]$CandidateVersion,
  [string]$LogDir = '',
  [int]$PreviousAppStartupTimeoutSeconds = 90,
  [int]$HandoffTimeoutSeconds = 240,
  [int]$PostHogIsolationPort = 8796,
  [int]$DiagnosticsIsolationPort = 8797,
  [switch]$ForceSilent
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'windows-install-log.ps1')
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-DescendantPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  $resolved = Resolve-FullPath $Path
  $root = (Resolve-FullPath $Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (!$resolved.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing $Purpose outside ${root}: $resolved"
  }
}

function Normalize-ProductVersion {
  param([Parameter(Mandatory = $true)][string]$Value)
  $match = [regex]::Match($Value, '^(\d+\.\d+\.\d+)')
  if (!$match.Success) { return '' }
  return $match.Groups[1].Value
}

function Get-ExecutableVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (!(Test-Path -LiteralPath $Path)) { return '' }
  try {
    return (Normalize-ProductVersion ([System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion))
  } catch {
    return ''
  }
}

function Assert-HumicSignature {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
  Write-ProbeLog "$Label Authenticode status=$($signature.Status) signer=$subject"
  if ($signature.Status -ne 'Valid' -or $subject -notlike '*Humic Labs Inc.*') {
    throw "$Label is not signed by Humic Labs Inc. (status=$($signature.Status), signer=$subject)."
  }
}

function Get-DefaultInstallCandidates {
  return @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DNAForge'),
    (Join-Path $env:LOCALAPPDATA 'Programs\@waypointdesktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\@waypoint\desktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\waypoint-desktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\desktop')
  )
}

function Resolve-InstalledExecutable {
  foreach ($candidate in (Get-DefaultInstallCandidates)) {
    $exe = Join-Path $candidate 'DNAForge.exe'
    if (Test-Path -LiteralPath $exe) {
      return (Resolve-Path -LiteralPath $exe).Path
    }
  }
  return ''
}

function Write-ProcessSnapshot {
  param([Parameter(Mandatory = $true)][string]$Phase)

  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $candidateProcessIds = @{}
  if ($script:CandidateInstallerProcess) {
    $candidateProcessIds[[string]$script:CandidateInstallerProcess.Id] = $true
  }
  $previousAppProcessIds = @{}
  if ($script:PreviousAppProcess) {
    $previousAppProcessIds[[string]$script:PreviousAppProcess.Id] = $true
  }
  $foundDescendant = $true
  while ($foundDescendant) {
    $foundDescendant = $false
    foreach ($candidate in $allProcesses) {
      $candidateId = [string]$candidate.ProcessId
      $parentId = [string]$candidate.ParentProcessId
      if (!$candidateProcessIds.ContainsKey($candidateId) -and $candidateProcessIds.ContainsKey($parentId)) {
        $candidateProcessIds[$candidateId] = $true
        $foundDescendant = $true
      }
      if (!$previousAppProcessIds.ContainsKey($candidateId) -and $previousAppProcessIds.ContainsKey($parentId)) {
        $previousAppProcessIds[$candidateId] = $true
        $foundDescendant = $true
      }
    }
  }
  $installDirPrefix = if ($installDir) {
    $installDir.TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
  } else {
    ''
  }

  $rows = @(
    $allProcesses |
      Where-Object {
        $candidateProcessIds.ContainsKey([string]$_.ProcessId) -or
        $previousAppProcessIds.ContainsKey([string]$_.ProcessId) -or
        ($installDirPrefix -and $_.ExecutablePath -and
          $_.ExecutablePath.StartsWith($installDirPrefix, [System.StringComparison]::OrdinalIgnoreCase)) -or
        $_.Name -ieq 'old-uninstaller.exe' -or
        $_.Name -like 'DNAForge*' -or
        $_.Name -like 'DNAForge-Setup-*' -or
        ($_.ExecutablePath -and $_.ExecutablePath -like '*DNAForge*') -or
        ($_.CommandLine -and $_.CommandLine -like '*DNAForge*')
      } |
      ForEach-Object {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        $trackingReason = if ($_.Name -ieq 'old-uninstaller.exe') {
          'old-uninstaller'
        } elseif ($script:CandidateInstallerProcess -and $_.ProcessId -eq $script:CandidateInstallerProcess.Id) {
          'candidate-root'
        } elseif ($candidateProcessIds.ContainsKey([string]$_.ProcessId)) {
          'candidate-descendant'
        } elseif ($script:PreviousAppProcess -and $_.ProcessId -eq $script:PreviousAppProcess.Id) {
          'previous-app-root'
        } elseif ($previousAppProcessIds.ContainsKey([string]$_.ProcessId)) {
          'previous-app-descendant'
        } elseif ($installDirPrefix -and $_.ExecutablePath -and
          $_.ExecutablePath.StartsWith($installDirPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          'previous-install-path'
        } else {
          'dnaforge-identity'
        }
        $startTimeUtc = $null
        $cpuSeconds = $null
        $responding = $null
        if ($process) {
          try { $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o') } catch {}
          try { $cpuSeconds = $process.TotalProcessorTime.TotalSeconds } catch {}
          try { $responding = $process.Responding } catch {}
        }
        [ordered]@{
          phase = $Phase
          observedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
          processId = $_.ProcessId
          parentProcessId = $_.ParentProcessId
          trackingReason = $trackingReason
          name = $_.Name
          executablePath = $_.ExecutablePath
          commandLine = $_.CommandLine
          startTimeUtc = $startTimeUtc
          cpuSeconds = $cpuSeconds
          responding = $responding
          mainWindowTitle = if ($process) { $process.MainWindowTitle } else { $null }
        }
      }
  )
  if ($rows.Count -eq 0) {
    $rows = @([ordered]@{
        phase = $Phase
        observedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        processId = $null
        parentProcessId = $null
        trackingReason = $null
        name = '<none>'
        executablePath = $null
        commandLine = $null
        startTimeUtc = $null
        cpuSeconds = $null
        responding = $null
        mainWindowTitle = $null
      })
  }
  foreach ($row in $rows) {
    Add-Content -LiteralPath $script:ProcessSnapshots -Value ($row | ConvertTo-Json -Compress) -Encoding UTF8
  }
}

function Copy-InstallEvidence {
  foreach ($entry in @(
      @{ Path = Get-PrimaryInstallLogPath; Name = 'candidate-primary-install.log' },
      @{ Path = Get-DualWriteInstallLogPath -InstallerPath $script:CandidateInstaller; Name = 'candidate-dual-write-install.log' }
    )) {
    if (Test-Path -LiteralPath $entry.Path) {
      Copy-Item -LiteralPath $entry.Path -Destination (Join-Path $LogDir $entry.Name) -Force
    }
  }
}

function Stop-ExactProcessTree {
  param([System.Diagnostics.Process]$Process)
  if (!$Process) { return }
  $Process.Refresh()
  if ($Process.HasExited) { return }
  & taskkill.exe /T /F /PID $Process.Id 2>$null | Out-Null
}

if (!$LogDir) {
  $LogDir = Join-Path $env:RUNNER_TEMP 'dnaforge-windows-updater-handoff'
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:ProofLog = Join-Path $LogDir 'verify-windows-updater-installer-handoff.log'
$script:ProcessSnapshots = Join-Path $LogDir 'process-snapshots.jsonl'
$script:PreviousStdout = Join-Path $LogDir 'previous-app.stdout.log'
$script:PreviousStderr = Join-Path $LogDir 'previous-app.stderr.log'

function Write-ProbeLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message
  Write-Host $line
  Add-Content -LiteralPath $script:ProofLog -Value $line -Encoding UTF8
}

$script:PreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
$script:CandidateInstaller = (Resolve-Path -LiteralPath $CandidateInstallerPath).Path
$programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
$canonicalUserData = Join-Path $env:APPDATA 'DNAForge'
$canonicalBootLog = Join-Path $canonicalUserData 'logs\main-boot.log'
$script:PreviousAppProcess = $null
$script:CandidateInstallerProcess = $null
$script:PostHogProcess = $null
$script:DiagnosticsProcess = $null
$installedExe = ''
$installDir = ''
$userDataExisted = Test-Path -LiteralPath $canonicalUserData
$telemetryFenceLeaseId = ''
$postHogBase = "http://127.0.0.1:$PostHogIsolationPort"
$diagnosticsBase = "http://127.0.0.1:$DiagnosticsIsolationPort"
$postHogOutLog = Join-Path $LogDir 'posthog-isolation.stdout.log'
$postHogErrLog = Join-Path $LogDir 'posthog-isolation.stderr.log'
$diagnosticsOutLog = Join-Path $LogDir 'diagnostics-isolation.stdout.log'
$diagnosticsErrLog = Join-Path $LogDir 'diagnostics-isolation.stderr.log'
$diagnosticsJournal = Join-Path $LogDir 'diagnostics-isolation-journal.json'
$previousInstallerSidecar = Join-Path (Split-Path -Parent $script:PreviousInstaller) 'dnaforge-diagnostics-url.txt'
$candidateInstallerSidecar = Join-Path (Split-Path -Parent $script:CandidateInstaller) 'dnaforge-diagnostics-url.txt'
$previousInstallerSidecarExisted = Test-Path -LiteralPath $previousInstallerSidecar
$previousInstallerSidecarOriginal = if ($previousInstallerSidecarExisted) {
  [System.IO.File]::ReadAllBytes($previousInstallerSidecar)
} else {
  $null
}
$candidateInstallerSidecarExisted = Test-Path -LiteralPath $candidateInstallerSidecar
$candidateInstallerSidecarOriginal = if ($candidateInstallerSidecarExisted) {
  [System.IO.File]::ReadAllBytes($candidateInstallerSidecar)
} else {
  $null
}
$previousPostHogApiKey = [Environment]::GetEnvironmentVariable('POSTHOG_API_KEY', 'Process')
$previousPostHogHost = [Environment]::GetEnvironmentVariable('POSTHOG_HOST', 'Process')
$previousDiagnosticsUrl = [Environment]::GetEnvironmentVariable('DIAGNOSTICS_URL', 'Process')
$previousDiagnosticsOverride = [Environment]::GetEnvironmentVariable(
  'DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE',
  'Process'
)

try {
  Write-ProbeLog "Exact updater handoff replay: previous=$PreviousVersion candidate=$CandidateVersion"
  if ($PreviousVersion -eq $CandidateVersion) {
    throw 'PreviousVersion and CandidateVersion must differ.'
  }
  if ($userDataExisted) {
    throw "Refusing a pre-existing packaged profile: $canonicalUserData"
  }
  foreach ($candidate in (Get-DefaultInstallCandidates)) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'DNAForge.exe')) {
      throw "Refusing to overwrite a pre-existing DNAForge install: $candidate"
    }
  }

  Assert-HumicSignature -Path $script:PreviousInstaller -Label "Previous v$PreviousVersion installer"
  Assert-HumicSignature -Path $script:CandidateInstaller -Label "Candidate v$CandidateVersion installer"

  Set-Content -LiteralPath $previousInstallerSidecar -Value $diagnosticsBase -Encoding ascii -NoNewline
  Set-Content -LiteralPath $candidateInstallerSidecar -Value $diagnosticsBase -Encoding ascii -NoNewline
  $env:POSTHOG_API_KEY = 'dnaforge-packaged-update-handoff-test'
  $env:POSTHOG_HOST = $postHogBase
  $env:DIAGNOSTICS_URL = $diagnosticsBase
  $env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE = '1'

  $script:PostHogProcess = Start-Process `
    -FilePath 'node' `
    -ArgumentList @(
      (Join-Path $repoRoot 'tools\devops\analytics\posthog-test-collector.mjs'),
      "--port=$PostHogIsolationPort",
      '--api-key=dnaforge-packaged-update-handoff-test'
    ) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $postHogOutLog `
    -RedirectStandardError $postHogErrLog
  $script:DiagnosticsProcess = Start-Process `
    -FilePath 'node' `
    -ArgumentList @(
      (Join-Path $PSScriptRoot 'mock-diagnostics-server.mjs'),
      '--port', $DiagnosticsIsolationPort,
      '--journal', $diagnosticsJournal
    ) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $diagnosticsOutLog `
    -RedirectStandardError $diagnosticsErrLog

  $isolationDeadline = (Get-Date).AddSeconds(20)
  do {
    $postHogHealthy = $false
    $diagnosticsHealthy = $false
    try {
      $postHogHealth = Invoke-RestMethod `
        -Method Get `
        -Uri "$postHogBase/__dnaforge_posthog/health" `
        -TimeoutSec 2
      $postHogHealthy = [bool]$postHogHealth.ok
    } catch {}
    try {
      $diagnosticsHealth = Invoke-RestMethod -Method Get -Uri "$diagnosticsBase/health" -TimeoutSec 2
      $diagnosticsHealthy = [bool]$diagnosticsHealth.ok
    } catch {}
    foreach ($process in @($script:PostHogProcess, $script:DiagnosticsProcess)) {
      $process.Refresh()
      if ($process.HasExited) {
        throw "Packaged telemetry isolation process exited before ready (code=$($process.ExitCode))."
      }
    }
    if ($postHogHealthy -and $diagnosticsHealthy) { break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $isolationDeadline)
  if (!$postHogHealthy -or !$diagnosticsHealthy) {
    throw 'Packaged telemetry isolation endpoints did not become healthy.'
  }
  Write-ProbeLog "Packaged telemetry isolation ready: posthog=$postHogBase diagnostics=$diagnosticsBase"

  New-Item -ItemType Directory -Force -Path $canonicalUserData | Out-Null
  $fenceJson = node (Join-Path $repoRoot 'scripts\telemetry-suppression-fence.mjs') `
    create `
    --user-data-dir $canonicalUserData `
    --reason packaged_update_test `
    --lifetime-seconds 3600
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the packaged update telemetry fence.' }
  $fence = $fenceJson | ConvertFrom-Json
  $telemetryFenceLeaseId = [string]$fence.leaseId
  if ([string]::IsNullOrWhiteSpace($telemetryFenceLeaseId)) {
    throw 'Packaged update telemetry fence did not return a lease id.'
  }

  Clear-DNAForgeInstallLogs -InstallerPath $script:PreviousInstaller
  Write-ProbeLog 'Installing the previous signed release silently at its default per-user path.'
  $previousInstall = Start-Process -FilePath $script:PreviousInstaller -ArgumentList @('/S') -PassThru -Wait
  if ($previousInstall.ExitCode -ne 0) {
    throw "Previous installer exited with code $($previousInstall.ExitCode)."
  }
  $installedExe = Resolve-InstalledExecutable
  if (!$installedExe) {
    throw 'Previous installer completed, but DNAForge.exe was not found.'
  }
  $installDir = Split-Path -Parent $installedExe
  Assert-DescendantPath -Path $installDir -Parent $programsRoot -Purpose 'to use a disposable updater handoff install'
  if ((Get-ExecutableVersion $installedExe) -ne $PreviousVersion) {
    throw "Installed executable does not report expected previous v$PreviousVersion."
  }

  Write-ProbeLog "Launching installed v$PreviousVersion before starting the updater installer."
  $script:PreviousAppProcess = Start-Process `
    -FilePath $installedExe `
    -ArgumentList @('--enable-logging') `
    -PassThru `
    -WindowStyle Normal `
    -RedirectStandardOutput $script:PreviousStdout `
    -RedirectStandardError $script:PreviousStderr

  $startupDeadline = (Get-Date).AddSeconds($PreviousAppStartupTimeoutSeconds)
  do {
    $script:PreviousAppProcess.Refresh()
    if ($script:PreviousAppProcess.HasExited) {
      throw "Previous app exited during startup with code $($script:PreviousAppProcess.ExitCode)."
    }
    if ((Test-Path -LiteralPath $canonicalBootLog) -and
      (Get-Content -LiteralPath $canonicalBootLog -Raw) -like "*version=$PreviousVersion platform=win32*") {
      break
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $startupDeadline)
  if (!(Test-Path -LiteralPath $canonicalBootLog) -or
    (Get-Content -LiteralPath $canonicalBootLog -Raw) -notlike "*version=$PreviousVersion platform=win32*") {
    throw "Previous v$PreviousVersion did not reach its canonical boot marker."
  }
  $windowDeadline = (Get-Date).AddSeconds($PreviousAppStartupTimeoutSeconds)
  do {
    $script:PreviousAppProcess.Refresh()
    if ($script:PreviousAppProcess.HasExited) {
      throw "Previous app exited before its native window became ready."
    }
    if ($script:PreviousAppProcess.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $windowDeadline)
  if ($script:PreviousAppProcess.MainWindowHandle -eq 0) {
    throw "Previous v$PreviousVersion booted but did not expose a native window handle."
  }
  $bootOffset = (Get-Item -LiteralPath $canonicalBootLog).Length
  Write-ProcessSnapshot -Phase 'previous-app-ready'

  Clear-DNAForgeInstallLogs -InstallerPath $script:CandidateInstaller
  $candidateArgs = @('--updated')
  if ($ForceSilent) {
    $candidateArgs += '/S'
    Write-ProbeLog 'Forcing /S only for the diagnosed updater handoff mechanism proof.'
  }
  $candidateArgs += '--force-run'
  Write-ProbeLog "Starting candidate with arguments: $($candidateArgs -join ' ')."
  $script:CandidateInstallerProcess = Start-Process `
    -FilePath $script:CandidateInstaller `
    -ArgumentList $candidateArgs `
    -PassThru

  if (!$script:PreviousAppProcess.CloseMainWindow()) {
    throw 'CloseMainWindow returned false; normal previous-app shutdown was not exercised.'
  }
  Write-ProbeLog 'Requested normal previous-app close after candidate installer launch.'
  Write-ProcessSnapshot -Phase 'candidate-started-and-normal-close-requested'

  $deadline = (Get-Date).AddSeconds($HandoffTimeoutSeconds)
  $snapshotAt = Get-Date
  $candidateBoot = ''
  do {
    $installedVersion = Get-ExecutableVersion $installedExe
    if (Test-Path -LiteralPath $canonicalBootLog) {
      $bytes = [System.IO.File]::ReadAllBytes($canonicalBootLog)
      if ($bytes.Length -gt $bootOffset) {
        $candidateBoot = [System.Text.Encoding]::UTF8.GetString($bytes, [int]$bootOffset, $bytes.Length - [int]$bootOffset)
      }
    }
    if ($installedVersion -eq $CandidateVersion -and
      $candidateBoot -like "*version=$CandidateVersion platform=win32*") {
      break
    }
    if ((Get-Date) -ge $snapshotAt) {
      Write-ProcessSnapshot -Phase "handoff-wait-installed-$installedVersion"
      Copy-InstallEvidence
      $snapshotAt = (Get-Date).AddSeconds(2)
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  Copy-InstallEvidence
  Write-InstallLogDump -WriteLog { param($m) Write-ProbeLog $m } -InstallerPath $script:CandidateInstaller
  Write-ProcessSnapshot -Phase 'handoff-terminal'
  $installedVersion = Get-ExecutableVersion $installedExe
  if ($installedVersion -ne $CandidateVersion) {
    $shown = if ($installedVersion) { $installedVersion } else { '<none>' }
    throw "Candidate did not replace the installed executable (reported v$shown)."
  }
  if ($candidateBoot -notlike "*version=$CandidateVersion platform=win32*") {
    throw "Candidate v$CandidateVersion replaced the executable but did not relaunch."
  }
  Assert-HumicSignature -Path $installedExe -Label "Relaunched candidate v$CandidateVersion app"
  Write-ProbeLog "PASS: exact non-silent updater handoff replaced and relaunched v$CandidateVersion."
} finally {
  try { Copy-InstallEvidence } catch { Write-Warning $_ }
  try { Write-ProcessSnapshot -Phase 'cleanup-start' } catch { Write-Warning $_ }
  Stop-ExactProcessTree -Process $script:CandidateInstallerProcess
  Stop-ExactProcessTree -Process $script:PreviousAppProcess

  if ($installDir) {
    $installDirPrefix = $installDir.TrimEnd(
      [System.IO.Path]::DirectorySeparatorChar,
      [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDirPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
    $uninstaller = Join-Path $installDir 'Uninstall DNAForge.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru -Wait | Out-Null
    }
    if (Test-Path -LiteralPath $installDir) {
      Assert-DescendantPath -Path $installDir -Parent $programsRoot -Purpose 'to clean the disposable updater handoff install'
      Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if ($telemetryFenceLeaseId) {
    node (Join-Path $repoRoot 'scripts\telemetry-suppression-fence.mjs') `
      clear `
      --user-data-dir $canonicalUserData `
      --lease-id $telemetryFenceLeaseId | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $canonicalUserData)) {
      Write-ProbeLog 'WARNING: packaged update telemetry fence did not clear cleanly.'
    }
  }
  if (!$userDataExisted -and (Test-Path -LiteralPath $canonicalUserData)) {
    Assert-DescendantPath -Path $canonicalUserData -Parent $env:APPDATA -Purpose 'to clean the disposable updater handoff profile'
    Remove-Item -LiteralPath $canonicalUserData -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($process in @($script:PostHogProcess, $script:DiagnosticsProcess)) {
    if ($process -and !$process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($sidecar in @(
      @{ Path = $previousInstallerSidecar; Existed = $previousInstallerSidecarExisted; Original = $previousInstallerSidecarOriginal },
      @{ Path = $candidateInstallerSidecar; Existed = $candidateInstallerSidecarExisted; Original = $candidateInstallerSidecarOriginal }
    )) {
    if ($sidecar.Existed) {
      [System.IO.File]::WriteAllBytes($sidecar.Path, $sidecar.Original)
    } elseif (Test-Path -LiteralPath $sidecar.Path) {
      Remove-Item -LiteralPath $sidecar.Path -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -ne $previousPostHogApiKey) {
    $env:POSTHOG_API_KEY = $previousPostHogApiKey
  } else {
    Remove-Item Env:POSTHOG_API_KEY -ErrorAction SilentlyContinue
  }
  if ($null -ne $previousPostHogHost) {
    $env:POSTHOG_HOST = $previousPostHogHost
  } else {
    Remove-Item Env:POSTHOG_HOST -ErrorAction SilentlyContinue
  }
  if ($null -ne $previousDiagnosticsUrl) {
    $env:DIAGNOSTICS_URL = $previousDiagnosticsUrl
  } else {
    Remove-Item Env:DIAGNOSTICS_URL -ErrorAction SilentlyContinue
  }
  if ($null -ne $previousDiagnosticsOverride) {
    $env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE = $previousDiagnosticsOverride
  } else {
    Remove-Item Env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE -ErrorAction SilentlyContinue
  }
}

exit 0
