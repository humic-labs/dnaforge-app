param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$LogDir = '',

  [string]$MockPort = '8791',

  [Parameter(Mandatory = $true)]
  [hashtable]$ExpectedTelemetryDimensions,

  [int]$FailurePathInitTimeoutSeconds = 60,

  [int]$BeaconWaitSeconds = 45,

  [int]$BootWaitSeconds = 90,

  [switch]$SkipFailurePath,

  [switch]$SkipHappyLaunch,

  [switch]$SkipForcedBootFailure,

  [switch]$SkipUnmarkedReinstall,

  [switch]$UseTelemetryActorLauncher
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'windows-install-log.ps1')

function Write-DiagLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'o'), $Message
  Write-Host $line
  if ($script:DiagLogFile) {
    Add-Content -LiteralPath $script:DiagLogFile -Value $line
  }
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Resolve-ExpectedTelemetryDimensions {
  param([Parameter(Mandatory = $true)][hashtable]$Dimensions)

  foreach ($required in @('Actor', 'BuildTag', 'Channel')) {
    if (!$Dimensions.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$Dimensions[$required])) {
      throw "ExpectedTelemetryDimensions.$required is required"
    }
  }

  $actor = ([string]$Dimensions.Actor).Trim().ToLowerInvariant()
  if (@('user', 'ci', 'maintainer') -notcontains $actor) {
    throw "ExpectedTelemetryDimensions.Actor must be user, ci, or maintainer; got '$actor'"
  }

  $ciRunId = if ($Dimensions.ContainsKey('CiRunId')) { ([string]$Dimensions.CiRunId).Trim() } else { '' }
  if ($actor -eq 'ci' -and $ciRunId -notmatch '^[1-9][0-9]{0,19}$') {
    throw 'ExpectedTelemetryDimensions.CiRunId must be a positive numeric GitHub run id for actor=ci'
  }
  if ($actor -ne 'ci' -and $ciRunId) {
    throw 'ExpectedTelemetryDimensions.CiRunId must be absent unless actor=ci'
  }

  $buildTag = ([string]$Dimensions.BuildTag).Trim()
  if ($buildTag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') {
    throw "ExpectedTelemetryDimensions.BuildTag is not an immutable release-tag-shaped value: '$buildTag'"
  }

  $channel = ([string]$Dimensions.Channel).Trim().ToLowerInvariant()
  if (@('closed_beta', 'dev', 'preview', 'prod', 'unknown') -notcontains $channel) {
    throw "ExpectedTelemetryDimensions.Channel is invalid: '$channel'"
  }

  return [pscustomobject]@{
    Actor = $actor
    CiRunId = $ciRunId
    BuildTag = $buildTag
    Channel = $channel
  }
}

function Get-BodyProperty {
  param(
    [Parameter(Mandatory = $true)]$Body,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $property = $Body.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Assert-TelemetryDimensions {
  param(
    [Parameter(Mandatory = $true)]$Body,
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $actualActor = [string](Get-BodyProperty -Body $Body -Name 'telemetry_actor')
  $actualCiRunId = [string](Get-BodyProperty -Body $Body -Name 'ci_run_id')
  $actualBuildTag = [string](Get-BodyProperty -Body $Body -Name 'desktop_build_tag')
  $actualChannel = [string](Get-BodyProperty -Body $Body -Name 'desktop_release_channel')
  $actualActorAssertion = [string](Get-BodyProperty -Body $Body -Name 'telemetry_actor_assertion')

  if ($actualActor -cne $Expected.Actor) {
    throw "$Description telemetry_actor mismatch: expected=$($Expected.Actor) actual=$actualActor"
  }
  if ($actualCiRunId -cne $Expected.CiRunId) {
    throw "$Description ci_run_id mismatch: expected='$($Expected.CiRunId)' actual='$actualCiRunId'"
  }
  if ($actualBuildTag -cne $Expected.BuildTag) {
    throw "$Description desktop_build_tag mismatch: expected=$($Expected.BuildTag) actual=$actualBuildTag"
  }
  if ($actualChannel -cne $Expected.Channel) {
    throw "$Description desktop_release_channel mismatch: expected=$($Expected.Channel) actual=$actualChannel"
  }
  if (@('maintainer', 'ci') -contains $Expected.Actor -and $actualActorAssertion -notmatch '^dfactor2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {
    throw "$Description is missing the signed internal telemetry assertion"
  }
}

function Assert-RequestIdentity {
  param(
    [Parameter(Mandatory = $true)]$Body,
    [Parameter(Mandatory = $true)][string]$ExpectedAttemptId,
    [string]$ExpectedDownloadId = '',
    [Parameter(Mandatory = $true)][string]$Description
  )

  $actualAttemptId = [string](Get-BodyProperty -Body $Body -Name 'attempt_id')
  $actualDownloadId = [string](Get-BodyProperty -Body $Body -Name 'download_id')
  if ($actualAttemptId -cne $ExpectedAttemptId) {
    throw "$Description attempt_id mismatch: expected=$ExpectedAttemptId actual=$actualAttemptId"
  }
  if ($actualDownloadId -cne $ExpectedDownloadId) {
    throw "$Description download_id mismatch: expected='$ExpectedDownloadId' actual='$actualDownloadId'"
  }
}

function Wait-IdentityPathsAbsent {
  param(
    [Parameter(Mandatory = $true)][string[]]$Paths,
    [Parameter(Mandatory = $true)][string]$Description,
    [int]$TimeoutSeconds = 15
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $remaining = @($Paths | Where-Object { Test-Path -LiteralPath $_ })
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "$Description identity consumption timed out; remaining=[$($remaining -join ', ')]"
}

function New-SmokePath {
  param([Parameter(Mandatory = $true)][string]$Prefix)
  return (Join-Path $env:TEMP ("$Prefix-" + [guid]::NewGuid().ToString('N')))
}

function Get-DefaultInstallCandidates {
  return @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DNAForge'),
    (Join-Path $env:LOCALAPPDATA 'Programs\@waypointdesktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\@waypoint\desktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\waypoint-desktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\desktop'),
    (Join-Path $env:LOCALAPPDATA '@waypoint\desktop')
  )
}

function Resolve-InstalledDNAForgeExe {
  foreach ($candidate in (Get-DefaultInstallCandidates)) {
    $exe = Join-Path $candidate 'DNAForge.exe'
    if (Test-Path -LiteralPath $exe) {
      return [pscustomobject]@{ InstallDir = $candidate; Exe = $exe }
    }
  }
  $programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
  if (Test-Path -LiteralPath $programsRoot) {
    $found = Get-ChildItem -LiteralPath $programsRoot -Filter 'DNAForge.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) {
      return [pscustomobject]@{ InstallDir = $found.Directory.FullName; Exe = $found.FullName }
    }
    $children = Get-ChildItem -LiteralPath $programsRoot -Directory -ErrorAction SilentlyContinue |
      Select-Object -First 20 -ExpandProperty FullName
    if ($children) {
      Write-DiagLog "Default Programs children: $($children -join '; ')"
    }
  }
  Write-DiagLog "Install candidates checked: $((Get-DefaultInstallCandidates) -join '; ')"
  return $null
}

function Get-Journal {
  param([Parameter(Mandatory = $true)][string]$BaseUrl)
  $res = Invoke-RestMethod -Method Get -Uri "$BaseUrl/journal" -TimeoutSec 10
  return $res
}

function Reset-Journal {
  param([Parameter(Mandatory = $true)][string]$BaseUrl)
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/reset" -TimeoutSec 10 | Out-Null
}

function Wait-JournalCondition {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][scriptblock]$Predicate,
    [Parameter(Mandatory = $true)][string]$Description,
    [int]$TimeoutSeconds = 45
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $journal = Get-Journal -BaseUrl $BaseUrl
    if (& $Predicate $journal) {
      return $journal
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  $final = Get-Journal -BaseUrl $BaseUrl
  $json = $final | ConvertTo-Json -Depth 8
  throw "Timed out waiting for $Description. Journal=`n$json"
}

function Assert-BeaconEvents {
  param(
    [Parameter(Mandatory = $true)]$Journal,
    [string[]]$MustInclude = @(),
    [string[]]$MustExclude = @()
  )
  $events = @()
  foreach ($req in @($Journal.requests)) {
    if ($req.path -eq '/api/diagnostics/install-beacon' -and $req.body.event) {
      $events += [string]$req.body.event
    }
  }
  foreach ($need in $MustInclude) {
    if ($events -notcontains $need) {
      throw "Expected beacon event='$need' in journal; got [$($events -join ', ')]"
    }
  }
  foreach ($bad in $MustExclude) {
    if ($events -contains $bad) {
      throw "Did not expect beacon event='$bad'; got [$($events -join ', ')]"
    }
  }
}

function Assert-UploadKind {
  param(
    [Parameter(Mandatory = $true)]$Journal,
    [Parameter(Mandatory = $true)][string]$Kind,
    [string]$ErrorClass = ''
  )
  $matches = @()
  foreach ($req in @($Journal.requests)) {
    if ($req.path -ne '/api/diagnostics/upload') { continue }
    if ([string]$req.body.kind -ne $Kind) { continue }
    if ($ErrorClass -and [string]$req.body.error_class -ne $ErrorClass) { continue }
    $matches += $req
  }
  if ($matches.Count -lt 1) {
    throw "Expected upload kind='$Kind' error_class='$ErrorClass' in journal"
  }
  $body = $matches[0].body
  Assert-DiagnosticsEventId -Body $body -Description "Upload kind=$Kind"
  $fileNames = @()
  if ($body.files) {
    foreach ($f in @($body.files)) { $fileNames += [string]$f.name }
  }
  $hasBoot = $fileNames -contains 'main-boot.log'
  $hasInstall = $fileNames -contains 'install.log'
  if (-not ($hasBoot -or $hasInstall)) {
    throw "Upload kind=$Kind missing expected log tails (main-boot.log or install.log); files=[$($fileNames -join ', ')]"
  }
}

function Assert-DiagnosticsEventId {
  param(
    [Parameter(Mandatory = $true)]$Body,
    [Parameter(Mandatory = $true)][string]$Description
  )
  $eventId = [string](Get-BodyProperty -Body $Body -Name 'event_id')
  if ($eventId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
    throw "$Description missing stable diagnostics event_id; got '$eventId'"
  }
}

function Start-TelemetryActorPackagedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$Artifact,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $buildTag = [string]$expectedTelemetry.BuildTag
  $appVersion = (($buildTag -replace '^v', '') -replace '-.*$', '')
  $launcherArguments = @(
    '--app', $Artifact,
    '--app-version', $appVersion,
    '--build-tag', $buildTag,
    '--release-channel', ([string]$expectedTelemetry.Channel),
    '--actor', ([string]$expectedTelemetry.Actor)
  )
  if ($expectedTelemetry.Actor -ceq 'ci') {
    $launcherArguments += @('--ci-run-id', ([string]$expectedTelemetry.CiRunId))
  }
  $launcherArguments += @('--json', '--')
  $launcherArguments += $Arguments
  $launcherOutput = @(& node $Launcher @launcherArguments 2>&1)
  $launcherExitCode = $LASTEXITCODE
  $receiptJson = ($launcherOutput | Out-String).Trim()
  if ($launcherExitCode -ne 0) {
    throw "$Description telemetry actor launcher failed with exit code $launcherExitCode`: $receiptJson"
  }
  $receipt = $receiptJson | ConvertFrom-Json
  if ([string]$receipt.telemetryActor -cne [string]$expectedTelemetry.Actor -or [int]$receipt.pid -le 0) {
    throw "$Description telemetry actor launcher returned an invalid startup receipt: $receiptJson"
  }
  return (Get-Process -Id ([int]$receipt.pid) -ErrorAction Stop)
}

function Stop-ExactProcessTree {
  param(
    [System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$ExecutablePath
  )

  if ($Process) {
    $targetPid = $Process.Id
    & taskkill.exe /T /F /PID $targetPid 2>$null | Out-Null
  }

  $deadline = (Get-Date).AddSeconds(30)
  do {
    $survivors = @(Get-InstalledApplicationProcesses -ExecutablePath $ExecutablePath)
    if ($survivors.Count -eq 0) { return }
    foreach ($candidate in $survivors) {
      $survivorPid = [int]$candidate.ProcessId
      Write-DiagLog "Stopping install-root process tree PID $survivorPid ($($candidate.Name))."
      & taskkill.exe /T /F /PID $survivorPid 2>$null | Out-Null
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  $survivorPids = @($survivors | ForEach-Object { $_.ProcessId }) -join ', '
  throw "Packaged install-root processes remained alive for '$ExecutablePath': $survivorPids"
}

function Get-InstalledApplicationProcesses {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  $installRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $ExecutablePath))
  $installRootPrefix = $installRoot + [System.IO.Path]::DirectorySeparatorChar
  return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
    $candidate = $_
    try {
      $candidatePath = [string]$candidate.ExecutablePath
      return ![string]::IsNullOrWhiteSpace($candidatePath) -and
        [System.IO.Path]::GetFullPath($candidatePath).StartsWith(
          $installRootPrefix,
          [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
      return $false
    }
  })
}

function Stop-InstallerProcessTree {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  if (!$Process.HasExited) {
    & taskkill.exe /T /F /PID $Process.Id 2>$null | Out-Null
  }
}

function Invoke-BoundedSilentUninstall {
  param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [int]$UninstallTimeoutSeconds = 180
  )

  $uninstaller = Join-Path $InstallDirectory 'Uninstall DNAForge.exe'
  $installedExe = Join-Path $InstallDirectory 'DNAForge.exe'
  if (!(Test-Path -LiteralPath $uninstaller)) {
    throw "Unmarked fresh-install proof requires the packaged uninstaller at '$uninstaller'"
  }

  Write-DiagLog 'Removing the marked install before the fresh unmarked install.'
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru
  if (!$process.WaitForExit($UninstallTimeoutSeconds * 1000)) {
    Stop-InstallerProcessTree -Process $process
    throw "Silent uninstall exceeded $UninstallTimeoutSeconds second timeout"
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) {
    throw "Silent uninstall exited with code $($process.ExitCode)"
  }

  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path -LiteralPath $installedExe) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $installedExe) {
    throw "The installed executable remained after silent uninstall: $installedExe"
  }
  Write-DiagLog 'Marked install removed; starting fresh unmarked install proof.'
}

function Invoke-TransientTolerantSilentInstall {
  param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$MaxAttempts = 3,
    [int]$InstallTimeoutSeconds = 420
  )

  $transientExitCodes = @(-1073741819, -1073741502)
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    Write-DiagLog "T1: silent /S install (attempt $attempt/$MaxAttempts)."
    $process = Start-Process -FilePath $Installer -ArgumentList $Arguments -PassThru
    if (!$process.WaitForExit($InstallTimeoutSeconds * 1000)) {
      Stop-InstallerProcessTree -Process $process
      throw "T1: installer exceeded $InstallTimeoutSeconds second timeout"
    }
    $process.Refresh()
    if ($process.ExitCode -eq 0) {
      return
    }
    if (($transientExitCodes -notcontains $process.ExitCode) -or ($attempt -eq $MaxAttempts)) {
      throw "T1: installer exited with code $($process.ExitCode)"
    }
    Write-DiagLog "T1: transient installer exit code $($process.ExitCode); retrying after backoff."
    Start-Sleep -Seconds (5 * $attempt)
  }
}

$sourceInstaller = Resolve-FullPath $InstallerPath
if (!(Test-Path -LiteralPath $sourceInstaller)) {
  throw "Installer not found: $sourceInstaller"
}

$expectedTelemetry = Resolve-ExpectedTelemetryDimensions -Dimensions $ExpectedTelemetryDimensions
$expectedInstallerTelemetry = [pscustomobject]@{
  Actor = 'user'
  CiRunId = ''
  BuildTag = $expectedTelemetry.BuildTag
  Channel = $expectedTelemetry.Channel
}
if ($expectedTelemetry.Actor -in @('ci', 'maintainer') -and !$UseTelemetryActorLauncher) {
  throw 'Internal telemetry classification requires UseTelemetryActorLauncher'
}
if ($expectedTelemetry.Actor -eq 'user' -and $UseTelemetryActorLauncher) {
  throw 'Actor=user must not use the internal telemetry actor launcher'
}
if ($SkipHappyLaunch -and !$SkipUnmarkedReinstall) {
  throw 'SkipHappyLaunch requires SkipUnmarkedReinstall because stale clearing depends on first-boot consumption'
}

& (Join-Path $PSScriptRoot 'test-windows-download-identity.ps1')
$expectedDownloadId = [guid]::NewGuid().ToString()
$sourceInstallerStem = [System.IO.Path]::GetFileNameWithoutExtension($sourceInstaller)
$installer = Join-Path (Split-Path -Parent $sourceInstaller) "$sourceInstallerStem--dfdl1-$expectedDownloadId (1).exe"
if (Test-Path -LiteralPath $installer) {
  Remove-Item -LiteralPath $installer -Force
}
New-Item -ItemType HardLink -Path $installer -Target $sourceInstaller | Out-Null

if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $LogDir = New-SmokePath 'dnaforge-diagnostics-smoke'
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:DiagLogFile = Join-Path $LogDir 'verify-windows-diagnostics-smoke.log'
$journalPath = Join-Path $LogDir 'journal.json'
$pidFile = Join-Path $LogDir 'mock-diagnostics.pid'
$mockBase = "http://127.0.0.1:$MockPort"
$installerDir = Split-Path -Parent $installer
$sidecarUrlFile = Join-Path $installerDir 'dnaforge-diagnostics-url.txt'
$primaryInstallLog = Get-PrimaryInstallLogPath
$primaryIdentityPath = $primaryInstallLog -replace 'install\.log$', 'install-attempt.id'
$dualWriteInstallLog = Get-DualWriteInstallLogPath -InstallerPath $installer
$userDataDir = New-SmokePath 'dnaforge-diag-userdata'
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
$telemetryActorLauncher = if ($UseTelemetryActorLauncher) {
  Resolve-FullPath (Join-Path $PSScriptRoot '..\..\..\scripts\launch-packaged-maintainer-test.mjs')
} else {
  ''
}
$previousDiagnosticsUrlOverride = [Environment]::GetEnvironmentVariable('DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE', 'Process')
$env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE = '1'
if ($UseTelemetryActorLauncher -and [string]::IsNullOrWhiteSpace([string]$env:TELEMETRY_ACTOR_ASSERTION_PRIVATE_KEY)) {
  throw 'TELEMETRY_ACTOR_ASSERTION_PRIVATE_KEY is required for packaged internal telemetry smoke'
}

$mockProc = $null
$wroteSidecar = $false
$createdHandoffInstaller = $true
$failurePathAttemptId = $null

try {
  Write-DiagLog " diagnostics smoke starting. installer=$installer mock=$mockBase actor=$($expectedTelemetry.Actor) build=$($expectedTelemetry.BuildTag) channel=$($expectedTelemetry.Channel)"

  Set-Content -LiteralPath $sidecarUrlFile -Value $mockBase -Encoding ascii -NoNewline
  $wroteSidecar = $true
  Write-DiagLog "Wrote NSIS sidecar URL file: $sidecarUrlFile -> $mockBase"

  $mockScript = Join-Path $PSScriptRoot 'mock-diagnostics-server.mjs'
  if (!(Test-Path -LiteralPath $mockScript)) {
    throw "Missing mock server: $mockScript"
  }
  $mockProc = Start-Process `
    -FilePath 'node' `
    -ArgumentList @(
      $mockScript,
      '--port', $MockPort,
      '--journal', $journalPath,
      '--pid-file', $pidFile
    ) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'mock-stdout.log') `
    -RedirectStandardError (Join-Path $LogDir 'mock-stderr.log')

  $healthDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    try {
      $h = Invoke-RestMethod -Method Get -Uri "$mockBase/health" -TimeoutSec 2
      if ($h.ok) { break }
    } catch {
      if ((Get-Date) -ge $healthDeadline) { throw "Mock server did not become healthy: $($_.Exception.Message)" }
    }
  } while ((Get-Date) -lt $healthDeadline)
  Write-DiagLog 'Mock diagnostics server healthy.'

  $installArgs = @('/S')
  $transientInstallerExitCodes = @(-1073741819, -1073741502)

  if (!$SkipFailurePath) {
    Reset-Journal -BaseUrl $mockBase
    Clear-DNAForgeInstallLogs -InstallerPath $installer
    Write-DiagLog 'T2: starting installer without -Wait for kill-after-init.'
    $failureProcess = Start-Process -FilePath $installer -ArgumentList $installArgs -PassThru
    $installerPid = $failureProcess.Id
    $failureAttempt = 1
    $failureMaxAttempts = 3
    try {
      $deadline = (Get-Date).AddSeconds($FailurePathInitTimeoutSeconds)
      $sawInit = $false
      do {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $primaryInstallLog) {
          $partial = Read-InstallLogText -LogPath $primaryInstallLog
          if ($partial -and ($partial -like '*event=init*')) {
            $sawInit = $true
            break
          }
        }
        $failureProcess.Refresh()
        if ($failureProcess.HasExited) {
          if (($transientInstallerExitCodes -contains $failureProcess.ExitCode) -and ($failureAttempt -lt $failureMaxAttempts)) {
            Write-DiagLog "T2: transient installer exit code $($failureProcess.ExitCode) before event=init; retrying ($failureAttempt/$failureMaxAttempts)."
            $failureAttempt++
            Start-Sleep -Seconds (5 * ($failureAttempt - 1))
            Clear-DNAForgeInstallLogs -InstallerPath $installer
            $failureProcess = Start-Process `
              -FilePath $installer `
              -ArgumentList $installArgs `
              -PassThru
            $installerPid = $failureProcess.Id
            $deadline = (Get-Date).AddSeconds($FailurePathInitTimeoutSeconds)
            continue
          }
          throw "T2: installer exited before event=init (code $($failureProcess.ExitCode))"
        }
      } while ((Get-Date) -lt $deadline)
      if (!$sawInit) { throw "T2: timed out waiting for event=init" }

      Write-DiagLog "T2: event=init observed; killing installer PID $installerPid"
      & taskkill.exe /T /F /PID $installerPid 2>$null | Out-Null
      $killDeadline = (Get-Date).AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 200
        $stillAlive = Get-Process -Id $installerPid -ErrorAction SilentlyContinue
      } while ($stillAlive -and (Get-Date) -lt $killDeadline)
      if (Get-Process -Id $installerPid -ErrorAction SilentlyContinue) {
        throw "T2: installer PID $installerPid still alive after kill — cannot trust install_complete absence"
      }
      Start-Sleep -Milliseconds 500

      Assert-FailurePathInstallLog `
        -PrimaryLogPath $primaryInstallLog `
        -DualWriteLogPath $dualWriteInstallLog

      $j2 = Wait-JournalCondition `
        -BaseUrl $mockBase `
        -TimeoutSeconds $BeaconWaitSeconds `
        -Description 'T2 beacon init' `
        -Predicate {
          param($j)
          $events = @($j.requests | Where-Object { $_.path -eq '/api/diagnostics/install-beacon' } | ForEach-Object { $_.body.event })
          return ($events -contains 'init')
        }
      Assert-BeaconEvents -Journal $j2 -MustInclude @('init') -MustExclude @('install_complete')
      $failureInit = @($j2.requests | Where-Object {
        $_.path -eq '/api/diagnostics/install-beacon' -and $_.body.event -eq 'init'
      }) | Select-Object -First 1
      if ($failureInit.body.download_id -cne $expectedDownloadId) {
        throw "T2: download identity mismatch: expected=$expectedDownloadId actual=$($failureInit.body.download_id)"
      }
      $failurePathAttemptId = [string]$failureInit.body.attempt_id
      if ([string]::IsNullOrWhiteSpace($failurePathAttemptId)) {
        throw 'T2: init beacon omitted attempt_id'
      }
      Assert-TelemetryDimensions `
        -Body $failureInit.body `
        -Expected $expectedInstallerTelemetry `
        -Description 'T2 init'
      Write-DiagLog 'T2: local log + mock journal OK (init only).'
    } finally {
      if (Get-Process -Id $installerPid -ErrorAction SilentlyContinue) {
        & taskkill.exe /T /F /PID $installerPid 2>$null | Out-Null
      }
      foreach ($candidate in (Get-DefaultInstallCandidates)) {
        $exeProbe = Join-Path $candidate 'DNAForge.exe'
        if (Test-Path -LiteralPath $exeProbe) {
          Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    }
  } else {
    Write-DiagLog 'T2 skipped.'
  }

  Reset-Journal -BaseUrl $mockBase
  Clear-DNAForgeInstallLogs -InstallerPath $installer
  Invoke-TransientTolerantSilentInstall `
    -Installer $installer `
    -Arguments $installArgs
  Assert-HappyPathInstallLog `
    -LogPath $primaryInstallLog `
    -DualWriteLogPath $dualWriteInstallLog

  $j1 = Wait-JournalCondition `
    -BaseUrl $mockBase `
    -TimeoutSeconds $BeaconWaitSeconds `
    -Description 'T1 beacons init+install_complete' `
    -Predicate {
      param($j)
      $events = @($j.requests | Where-Object { $_.path -eq '/api/diagnostics/install-beacon' } | ForEach-Object { $_.body.event })
      return (($events -contains 'init') -and ($events -contains 'install_complete'))
    }
  Assert-BeaconEvents -Journal $j1 -MustInclude @('init', 'install_complete')
  $installBeacons = @($j1.requests | Where-Object { $_.path -eq '/api/diagnostics/install-beacon' })
  $installAttemptIds = @($installBeacons | ForEach-Object { [string]$_.body.attempt_id } | Select-Object -Unique)
  $installDownloadIds = @($installBeacons | ForEach-Object { [string]$_.body.download_id } | Select-Object -Unique)
  if ($installAttemptIds.Count -ne 1 -or [string]::IsNullOrWhiteSpace($installAttemptIds[0])) {
    throw "T1: init/install_complete did not share one installer-run identity"
  }
  if ($failurePathAttemptId -and $installAttemptIds[0] -ceq $failurePathAttemptId) {
    throw "T1/T2: running the same downloaded file twice reused an installer-run identity"
  }
  if ($installDownloadIds.Count -ne 1 -or $installDownloadIds[0] -cne $expectedDownloadId) {
    throw "T1: init/install_complete download identity mismatch"
  }
  $completedAttemptId = $installAttemptIds[0]
  foreach ($installBeacon in $installBeacons) {
    Assert-RequestIdentity `
      -Body $installBeacon.body `
      -ExpectedAttemptId $completedAttemptId `
      -ExpectedDownloadId $expectedDownloadId `
      -Description "T1 $($installBeacon.body.event)"
    Assert-TelemetryDimensions `
      -Body $installBeacon.body `
      -Expected $expectedInstallerTelemetry `
      -Description "T1 $($installBeacon.body.event)"
  }
  Write-DiagLog 'T1: local log + mock journal OK (init + install_complete).'

  $resolved = Resolve-InstalledDNAForgeExe
  if (-not $resolved) {
    throw 'T1 completed but DNAForge.exe was not found under known install locations.'
  }
  $exe = $resolved.Exe
  Write-DiagLog "Installed exe: $exe"

  if (!$SkipHappyLaunch) {
    $bootUserData = Join-Path $userDataDir 'boot-ok'
    New-Item -ItemType Directory -Force -Path $bootUserData | Out-Null
    $prevDiag = $env:DIAGNOSTICS_URL
    $prevForce = $env:DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE
    $env:DIAGNOSTICS_URL = $mockBase
    Remove-Item Env:DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE -ErrorAction SilentlyContinue
    $appProc = $null
    try {
      Write-DiagLog 'Launching app for boot_ok phone-home.'
      $appArguments = @("--user-data-dir=$bootUserData", '--enable-logging')
      if ($telemetryActorLauncher) {
        $appProc = Start-TelemetryActorPackagedProcess `
          -Launcher $telemetryActorLauncher `
          -Artifact $exe `
          -Arguments $appArguments `
          -Description 'Marked boot app'
      } else {
        $appProc = Start-Process `
          -FilePath $exe `
          -ArgumentList $appArguments `
          -PassThru `
          -WindowStyle Hidden
      }

      $jBoot = Wait-JournalCondition `
        -BaseUrl $mockBase `
        -TimeoutSeconds $BootWaitSeconds `
        -Description 'app_boot and boot_ok upload' `
        -Predicate {
          param($j)
          $beacons = @($j.requests | Where-Object { $_.path -eq '/api/diagnostics/install-beacon' } | ForEach-Object { $_.body.event })
          $uploads = @($j.requests | Where-Object { $_.path -eq '/api/diagnostics/upload' } | ForEach-Object { $_.body.kind })
          return (($beacons -contains 'app_boot') -and ($uploads -contains 'boot_ok'))
        }

      $appBoot = @($jBoot.requests | Where-Object {
        $_.path -eq '/api/diagnostics/install-beacon' -and $_.body.event -eq 'app_boot'
      }) | Select-Object -First 1
      $bootOk = @($jBoot.requests | Where-Object {
        $_.path -eq '/api/diagnostics/upload' -and $_.body.kind -eq 'boot_ok'
      }) | Select-Object -First 1
      Assert-DiagnosticsEventId -Body $bootOk.body -Description 'Marked boot_ok upload'
      foreach ($requestEntry in @($appBoot, $bootOk)) {
        Assert-RequestIdentity `
          -Body $requestEntry.body `
          -ExpectedAttemptId $completedAttemptId `
          -ExpectedDownloadId $expectedDownloadId `
          -Description 'Marked boot path'
        Assert-TelemetryDimensions `
          -Body $requestEntry.body `
          -Expected $expectedTelemetry `
          -Description 'Marked boot path'
      }
      $appBootInstallId = [string](Get-BodyProperty -Body $appBoot.body -Name 'install_id')
      $bootOkInstallId = [string](Get-BodyProperty -Body $bootOk.body -Name 'install_id')
      if ([string]::IsNullOrWhiteSpace($appBootInstallId) -or $appBootInstallId -cne $bootOkInstallId) {
        throw "app_boot and boot_ok did not share one stable install identity"
      }

      Wait-IdentityPathsAbsent `
        -Paths @($primaryIdentityPath, (Join-Path $bootUserData 'logs\install-attempt.id')) `
        -Description 'Marked first boot'

      $bootLog = Join-Path $bootUserData 'logs\main-boot.log'
      if (!(Test-Path -LiteralPath $bootLog)) {
        throw "Expected main-boot.log at $bootLog after happy launch"
      }
      Write-DiagLog "Happy launch phone-home OK. Journal summary: $(($jBoot | ConvertTo-Json -Compress -Depth 4))"

    } finally {
      if ($appProc) {
        Stop-ExactProcessTree -Process $appProc -ExecutablePath $exe
        Start-Sleep -Seconds 1
      }
      if ($null -ne $prevDiag) { $env:DIAGNOSTICS_URL = $prevDiag } else { Remove-Item Env:DIAGNOSTICS_URL -ErrorAction SilentlyContinue }
      if ($null -ne $prevForce) { $env:DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE = $prevForce }
    }
  } else {
    Write-DiagLog 'Happy launch skipped.'
  }

  if (!$SkipUnmarkedReinstall) {
    Invoke-BoundedSilentUninstall -InstallDirectory $resolved.InstallDir
    Reset-Journal -BaseUrl $mockBase
    Clear-DNAForgeInstallLogs -InstallerPath $sourceInstaller
    Invoke-TransientTolerantSilentInstall `
      -Installer $sourceInstaller `
      -Arguments $installArgs
    Assert-HappyPathInstallLog `
      -LogPath $primaryInstallLog `
      -DualWriteLogPath $dualWriteInstallLog

    $jUnmarkedInstall = Wait-JournalCondition `
      -BaseUrl $mockBase `
      -TimeoutSeconds $BeaconWaitSeconds `
      -Description 'unmarked reinstall init+install_complete' `
      -Predicate {
        param($j)
        $events = @($j.requests | Where-Object {
          $_.path -eq '/api/diagnostics/install-beacon'
        } | ForEach-Object { $_.body.event })
        return (($events -contains 'init') -and ($events -contains 'install_complete'))
      }
    $unmarkedInstallBeacons = @($jUnmarkedInstall.requests | Where-Object {
      $_.path -eq '/api/diagnostics/install-beacon'
    })
    $unmarkedAttemptIds = @($unmarkedInstallBeacons | ForEach-Object {
      [string](Get-BodyProperty -Body $_.body -Name 'attempt_id')
    } | Select-Object -Unique)
    if ($unmarkedAttemptIds.Count -ne 1 -or [string]::IsNullOrWhiteSpace($unmarkedAttemptIds[0])) {
      throw 'Unmarked reinstall init/install_complete did not share one installer-run identity'
    }
    $unmarkedAttemptId = $unmarkedAttemptIds[0]
    if ($unmarkedAttemptId -ceq $completedAttemptId) {
      throw 'Unmarked reinstall reused the marked installer-run identity'
    }
    foreach ($installBeacon in $unmarkedInstallBeacons) {
      Assert-RequestIdentity `
        -Body $installBeacon.body `
        -ExpectedAttemptId $unmarkedAttemptId `
        -Description "Unmarked reinstall $($installBeacon.body.event)"
      Assert-TelemetryDimensions `
        -Body $installBeacon.body `
        -Expected $expectedInstallerTelemetry `
        -Description "Unmarked reinstall $($installBeacon.body.event)"
    }

    if (!(Test-Path -LiteralPath $primaryIdentityPath)) {
      throw 'Unmarked reinstall did not persist its installer-run identity'
    }
    $unmarkedIdentityLines = @(Get-Content -LiteralPath $primaryIdentityPath)
    if ([string]$unmarkedIdentityLines[0] -cne $unmarkedAttemptId) {
      throw 'Unmarked reinstall persisted a different installer-run identity'
    }
    if ($unmarkedIdentityLines.Count -gt 1 -and ![string]::IsNullOrWhiteSpace([string]$unmarkedIdentityLines[1])) {
      throw "Unmarked reinstall retained stale download attribution: $($unmarkedIdentityLines[1])"
    }
    Write-DiagLog 'Unmarked reinstall minted a fresh attempt and cleared download attribution.'
    Stop-ExactProcessTree -Process $null -ExecutablePath $exe
    Start-Sleep -Seconds 1
  } else {
    Write-DiagLog 'Unmarked reinstall skipped.'
  }

  if (!$SkipForcedBootFailure) {
    Reset-Journal -BaseUrl $mockBase
    $failUserData = Join-Path $userDataDir 'boot-fail'
    New-Item -ItemType Directory -Force -Path $failUserData | Out-Null
    $prevDiag = $env:DIAGNOSTICS_URL
    $env:DIAGNOSTICS_URL = $mockBase
    $env:DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE = '1'
    try {
      Write-DiagLog 'Launching app with DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE=1.'
      $failArguments = @("--user-data-dir=$failUserData", '--enable-logging')
      $failProc = if ($telemetryActorLauncher) {
        Start-TelemetryActorPackagedProcess `
          -Launcher $telemetryActorLauncher `
          -Artifact $exe `
          -Arguments $failArguments `
          -Description 'Forced boot failure app'
      } else {
        Start-Process `
          -FilePath $exe `
          -ArgumentList $failArguments `
          -PassThru `
          -WindowStyle Hidden
      }

      $jFail = Wait-JournalCondition `
        -BaseUrl $mockBase `
        -TimeoutSeconds $BootWaitSeconds `
        -Description 'forced boot_failure upload' `
        -Predicate {
          param($j)
          $uploads = @($j.requests | Where-Object {
            $_.path -eq '/api/diagnostics/upload' -and $_.body.kind -eq 'boot_failure'
          })
          return ($uploads.Count -ge 1)
        }
      Assert-UploadKind -Journal $jFail -Kind 'boot_failure' -ErrorClass 'forced_boot_failure'
      Write-DiagLog 'Forced boot failure phone-home OK.'

      $deadline = (Get-Date).AddSeconds(30)
      do {
        Start-Sleep -Milliseconds 300
        $failProc.Refresh()
      } while ((-not $failProc.HasExited) -and (Get-Date) -lt $deadline)
      if (-not $failProc.HasExited) {
        Stop-ExactProcessTree -Process $failProc -ExecutablePath $exe
      }
    } finally {
      if ($null -ne $prevDiag) { $env:DIAGNOSTICS_URL = $prevDiag } else { Remove-Item Env:DIAGNOSTICS_URL -ErrorAction SilentlyContinue }
      Remove-Item Env:DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE -ErrorAction SilentlyContinue
    }
  } else {
    Write-DiagLog 'Forced boot failure skipped.'
  }

  try {
    $final = Get-Journal -BaseUrl $mockBase
    $final | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $journalPath -Encoding utf8
  } catch {
    Write-DiagLog "WARNING: could not refresh journal.json: $($_.Exception.Message)"
  }

  Write-DiagLog 'Windows diagnostics phone-home smoke PASSED.'
}
finally {
  if ($mockProc -and -not $mockProc.HasExited) {
    Stop-Process -Id $mockProc.Id -Force -ErrorAction SilentlyContinue
  }
  if ($wroteSidecar -and (Test-Path -LiteralPath $sidecarUrlFile)) {
    Remove-Item -LiteralPath $sidecarUrlFile -Force -ErrorAction SilentlyContinue
  }
  if ($createdHandoffInstaller -and (Test-Path -LiteralPath $installer)) {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $previousDiagnosticsUrlOverride) {
    $env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE = $previousDiagnosticsUrlOverride
  } else {
    Remove-Item Env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE -ErrorAction SilentlyContinue
  }
  $still = Resolve-InstalledDNAForgeExe
  if ($still) {
    $uninstaller = Join-Path $still.InstallDir 'Uninstall DNAForge.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -ErrorAction SilentlyContinue | Out-Null
    }
    if (Test-Path -LiteralPath $still.InstallDir) {
      Remove-Item -LiteralPath $still.InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $userDataDir) {
    Remove-Item -LiteralPath $userDataDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$global:LASTEXITCODE = 0
