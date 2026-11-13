param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [int]$StartupSeconds = 45,

  [string]$InstallDir = '',

  [string]$UserDataDir = '',

  [string]$LogDir = '',

  [string]$AnnotationDataDir = '',

  [switch]$KeepInstall,

  [string]$ApplicationFirewallGroup = '',

  [string[]]$BlockedRemoteAddresses = @(),

  [switch]$UseDefaultInstallDir,

  [switch]$SkipAcceptanceGate,


  [switch]$SkipFailurePath,

  [int]$FailurePathInitTimeoutSeconds = 60,

  [int]$TelemetryIsolationPort = 8793
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'windows-install-log.ps1')

function New-SmokePath {
  param([Parameter(Mandatory = $true)][string]$Prefix)
  return (Join-Path $env:TEMP ("$Prefix-" + [guid]::NewGuid().ToString('N')))
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-UnderTemp {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = Resolve-FullPath $Path
  $tempRoot = Resolve-FullPath $env:TEMP
  if (!$resolved.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside TEMP: $resolved"
  }
}

function Assert-UnderLocalAppDataPrograms {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = Resolve-FullPath $Path
  $programsRoot = Resolve-FullPath (Join-Path $env:LOCALAPPDATA 'Programs')
  if (!$resolved.StartsWith($programsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove default-install path outside LocalAppData Programs: $resolved"
  }
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

function Stop-InstallerProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )


  $targetPid = $Process.Id

  $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
  if ($taskkill) {
    & $taskkill.Source /T /F /PID $targetPid 2>$null | Out-Null
  } else {
    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
  }

  try {
    Wait-Process -Id $targetPid -Timeout 15 -ErrorAction SilentlyContinue
  } catch {

  }

  $Process.Refresh()
  if (!$Process.HasExited) {
    throw "T2: installer process tree (PID $targetPid) still alive after kill"
  }
}

function Get-OptionalProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($property) {
    return [string]$property.Value
  }
  return ''
}

function Get-DNAForgeRegistryInstallCandidates {
  $candidates = New-Object System.Collections.Generic.List[string]
  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  )

  foreach ($root in $uninstallRoots) {
    if (!(Test-Path -LiteralPath $root)) {
      continue
    }
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($entry) {
        $displayName = Get-OptionalProperty $entry 'DisplayName'
        $installLocation = Get-OptionalProperty $entry 'InstallLocation'
        $displayIcon = Get-OptionalProperty $entry 'DisplayIcon'
        $uninstallString = Get-OptionalProperty $entry 'UninstallString'
        $quietUninstallString = Get-OptionalProperty $entry 'QuietUninstallString'
        $joined = "$displayName $installLocation $displayIcon $uninstallString $quietUninstallString"

        if ($joined -match 'DNAForge|waypoint') {
          if ($installLocation) {
            $candidates.Add($installLocation)
          }
          foreach ($command in @($uninstallString, $quietUninstallString, $displayIcon)) {
            if ($command -match '"([^"]+\\(?:Uninstall )?DNAForge\.exe)"') {
              $candidates.Add((Split-Path -Parent $matches[1]))
            }
          }
        }
      }
    }
  }

  foreach ($root in @('HKCU:\Software', 'HKLM:\Software')) {
    if (!(Test-Path -LiteralPath $root)) {
      continue
    }
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($entry) {
        $installLocation = Get-OptionalProperty $entry 'InstallLocation'
        if ($installLocation -and (Test-Path -LiteralPath (Join-Path $installLocation 'DNAForge.exe'))) {
          $candidates.Add($installLocation)
        }
      }
    }
  }

  return @($candidates | Select-Object -Unique)
}

function Resolve-InstalledDNAForgeExe {
  $installCandidates = @(
    Get-DNAForgeRegistryInstallCandidates
    Get-DefaultInstallCandidates
  ) | Where-Object { $_ } | Select-Object -Unique

  foreach ($candidate in $installCandidates) {
    $exe = Join-Path $candidate 'DNAForge.exe'
    if (Test-Path -LiteralPath $exe) {
      return @{
        InstallDir = Resolve-FullPath $candidate
        Exe = (Resolve-Path -LiteralPath $exe).Path
      }
    }
  }

  $searchRoots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    (Join-Path $env:LOCALAPPDATA '@waypoint')
  ) | Where-Object { Test-Path -LiteralPath $_ }
  foreach ($root in $searchRoots) {
    $found = Get-ChildItem -LiteralPath $root -Filter 'DNAForge.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) {
      return @{
        InstallDir = $found.Directory.FullName
        Exe = $found.FullName
      }
    }
  }

  $programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
  if (Test-Path -LiteralPath $programsRoot) {
    $children = Get-ChildItem -LiteralPath $programsRoot -Directory -ErrorAction SilentlyContinue |
      Select-Object -First 20 -ExpandProperty FullName
    if ($children) {
      Write-SmokeLog "Default Programs children: $($children -join '; ')"
    }
  }
  Write-SmokeLog "Registry/default install candidates checked: $($installCandidates -join '; ')"
  return $null
}

if ($UseDefaultInstallDir -and $InstallDir) {
  throw 'Use either -UseDefaultInstallDir or -InstallDir, not both.'
}

if (!$InstallDir -and !$UseDefaultInstallDir) {
  $InstallDir = New-SmokePath 'dnaforge-install-smoke'
}
if (!$UserDataDir) {
  $UserDataDir = New-SmokePath 'dnaforge-user-data-smoke'
}
if (!$LogDir) {
  $LogDir = Join-Path $env:TEMP 'dnaforge-windows-install-smoke'
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'verify-windows-install-smoke.log'

function Write-SmokeLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $Message
  Write-Host $line
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$InstallDir = if ($UseDefaultInstallDir) { '' } else { Resolve-FullPath $InstallDir }
$UserDataDir = Resolve-FullPath $UserDataDir
if ($AnnotationDataDir) {
  $AnnotationDataDir = Resolve-FullPath $AnnotationDataDir
}

Write-SmokeLog "Installer: $installer"
if ($UseDefaultInstallDir) {
  Write-SmokeLog 'Install dir: default per-user NSIS path'
} else {
  Write-SmokeLog "Install dir: $InstallDir"
}
Write-SmokeLog "User data dir: $UserDataDir"
if ($AnnotationDataDir) {
  Write-SmokeLog "Annotation data dir: $AnnotationDataDir"
}

$hash = Get-FileHash -LiteralPath $installer -Algorithm SHA256
$signature = Get-AuthenticodeSignature -LiteralPath $installer
Write-SmokeLog "Installer SHA256: $($hash.Hash)"
Write-SmokeLog "Authenticode status: $($signature.Status)"
if ($signature.SignerCertificate) {
  Write-SmokeLog "Signer: $($signature.SignerCertificate.Subject)"
}

if ($UseDefaultInstallDir) {


  $preExistingDefaultInstalls = @(
    Get-DefaultInstallCandidates |
      Where-Object {
        $_ -and (Test-Path -LiteralPath (Join-Path $_ 'DNAForge.exe'))
      }
  )
  if ($preExistingDefaultInstalls.Count -gt 0) {
    throw "Refusing to overwrite an existing default DNAForge install: $($preExistingDefaultInstalls -join ', ')"
  }
} else {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

$appProcess = $null
$primaryInstallLog = Get-PrimaryInstallLogPath
$dualWriteInstallLog = Get-DualWriteInstallLogPath -InstallerPath $installer
$mockDiagnosticsProcess = $null
$mockDiagnosticsBase = "http://127.0.0.1:$TelemetryIsolationPort"
$mockDiagnosticsJournal = Join-Path $LogDir 'mock-diagnostics-journal.json'
$mockDiagnosticsStdout = Join-Path $LogDir 'mock-diagnostics.stdout.log'
$mockDiagnosticsStderr = Join-Path $LogDir 'mock-diagnostics.stderr.log'
$diagnosticsSidecar = Join-Path (Split-Path -Parent $installer) 'dnaforge-diagnostics-url.txt'
$diagnosticsSidecarExisted = Test-Path -LiteralPath $diagnosticsSidecar
$diagnosticsSidecarOriginal = if ($diagnosticsSidecarExisted) {
  [System.IO.File]::ReadAllBytes($diagnosticsSidecar)
} else {
  $null
}
$previousDiagnosticsUrl = [Environment]::GetEnvironmentVariable('DIAGNOSTICS_URL', 'Process')
$previousDiagnosticsOverride = [Environment]::GetEnvironmentVariable(
  'DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE',
  'Process'
)
$telemetryFenceLeaseId = ''

function Invoke-DNAForgeSilentInstall {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$InstallArgs,

    [Parameter(Mandatory = $true)]
    [int[]]$TransientExitCodes,

    [int]$MaxAttempts = 3
  )

  $installerProcess = $null
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    Clear-DNAForgeInstallLogs -InstallerPath $installer
    Write-SmokeLog "T1: pre-deleted install logs (primary=$primaryInstallLog dual=$dualWriteInstallLog)."
    Write-SmokeLog "Running NSIS silent install (attempt $attempt/$MaxAttempts)."
    $installerProcess = Start-Process `
      -FilePath $installer `
      -ArgumentList $InstallArgs `
      -PassThru `
      -Wait

    if ($installerProcess.ExitCode -eq 0) { return $installerProcess }

    $hexExitCode = [Convert]::ToString(([int64]$installerProcess.ExitCode) -band 0xffffffffL, 16).ToUpperInvariant().PadLeft(8, '0')
    Write-SmokeLog ("Installer exited with code {0} (0x{1})." -f $installerProcess.ExitCode, $hexExitCode)
    Write-InstallLogDump -WriteLog { param($m) Write-SmokeLog $m } -InstallerPath $installer

    if ($TransientExitCodes -notcontains $installerProcess.ExitCode) {

      throw "Installer exited with code $($installerProcess.ExitCode)"
    }
    if ($attempt -lt $MaxAttempts) {
      Write-SmokeLog "Transient installer crash (0x$hexExitCode) — retrying after backoff."
      Start-Sleep -Seconds (5 * $attempt)
    }
  }

  throw "Installer exited with code $($installerProcess.ExitCode) after $MaxAttempts attempts"
}

function Invoke-DNAForgeFailurePathSmoke {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$InstallArgs,

    [int]$InitTimeoutSeconds = 60,






    [int[]]$TransientExitCodes = @()
  )

  $script:T2TransientCrash = $false





  Clear-DNAForgeInstallLogs -InstallerPath $installer
  Write-SmokeLog "T2: pre-deleted install logs; starting installer without -Wait."

  $failureProcess = Start-Process `
    -FilePath $installer `
    -ArgumentList $InstallArgs `
    -PassThru
  $installerPid = $failureProcess.Id

  try {
    $deadline = (Get-Date).AddSeconds($InitTimeoutSeconds)
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
        $t2ExitCode = $failureProcess.ExitCode



        if ($TransientExitCodes -contains $t2ExitCode) {
          Write-SmokeLog ("T2: installer exited with known-transient code {0} before event=init; will retry." -f $t2ExitCode)
          $script:T2TransientCrash = $true
          return
        }
        Write-InstallLogDump -WriteLog { param($m) Write-SmokeLog $m } -InstallerPath $installer
        throw ("T2: installer exited (code {0}) before event=init appeared in {1}" -f `
          $t2ExitCode, $primaryInstallLog)
      }
    } while ((Get-Date) -lt $deadline)

    if (!$sawInit) {
      Write-InstallLogDump -WriteLog { param($m) Write-SmokeLog $m } -InstallerPath $installer
      throw "T2: timed out after ${InitTimeoutSeconds}s waiting for event=init in $primaryInstallLog"
    }

    Write-SmokeLog "T2: event=init observed; killing installer process tree PID $installerPid."
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
      & $taskkill.Source /T /F /PID $installerPid 2>$null | Out-Null
    } else {
      Stop-Process -Id $installerPid -Force -ErrorAction Stop
    }
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
    Write-SmokeLog 'T2: failure-path install log assertions passed (init present, install_complete absent).'
  } finally {
    if ($installerPid -gt 0) {
      $stillAlive = Get-Process -Id $installerPid -ErrorAction SilentlyContinue
      if ($stillAlive) {
        Write-SmokeLog "T2 finally: installer PID $installerPid still alive — force-killing tree."
        & taskkill.exe /T /F /PID $installerPid 2>$null | Out-Null
      }
    }




    if ($UseDefaultInstallDir) {
      foreach ($candidate in (Get-DefaultInstallCandidates)) {
        if (!$candidate) { continue }
        $exeProbe = Join-Path $candidate 'DNAForge.exe'
        if (!(Test-Path -LiteralPath $exeProbe)) { continue }
        $programsRoot = Resolve-FullPath (Join-Path $env:LOCALAPPDATA 'Programs')
        $resolved = Resolve-FullPath $candidate
        if ($resolved.StartsWith($programsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
          Write-SmokeLog "T2 cleanup: removing partial default install $resolved"
          Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    } elseif ($InstallDir -and (Test-Path -LiteralPath $InstallDir)) {
      Assert-UnderTemp $InstallDir
      Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

try {
  Set-Content -LiteralPath $diagnosticsSidecar -Value $mockDiagnosticsBase -Encoding ascii -NoNewline
  $env:DIAGNOSTICS_URL = $mockDiagnosticsBase
  $env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE = '1'
  $mockDiagnosticsProcess = Start-Process `
    -FilePath 'node' `
    -ArgumentList @(
      (Join-Path $PSScriptRoot 'mock-diagnostics-server.mjs'),
      '--port', $TelemetryIsolationPort,
      '--journal', $mockDiagnosticsJournal
    ) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $mockDiagnosticsStdout `
    -RedirectStandardError $mockDiagnosticsStderr
  $mockDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    try {
      $mockHealth = Invoke-RestMethod -Method Get -Uri "$mockDiagnosticsBase/health" -TimeoutSec 2
      if ($mockHealth.ok) { break }
    } catch {
      $mockDiagnosticsProcess.Refresh()
      if ($mockDiagnosticsProcess.HasExited) {
        throw "Mock diagnostics server exited before ready (code=$($mockDiagnosticsProcess.ExitCode))."
      }
      if ((Get-Date) -ge $mockDeadline) {
        throw "Mock diagnostics server did not become healthy: $($_.Exception.Message)"
      }
    }
  } while ((Get-Date) -lt $mockDeadline)
  Write-SmokeLog "Packaged telemetry isolation ready at $mockDiagnosticsBase."

  $fenceJson = node (Join-Path $repoRoot 'scripts\telemetry-suppression-fence.mjs') `
    create `
    --user-data-dir $UserDataDir `
    --reason packaged_validation_test `
    --lifetime-seconds 3600
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the packaged telemetry suppression fence.' }
  $fence = $fenceJson | ConvertFrom-Json
  $telemetryFenceLeaseId = [string]$fence.leaseId
  if ([string]::IsNullOrWhiteSpace($telemetryFenceLeaseId)) {
    throw 'Packaged telemetry suppression fence did not return a lease id.'
  }








  foreach ($exclusion in @((Split-Path -Parent $installer), $InstallDir, $UserDataDir, (Split-Path -Parent $primaryInstallLog))) {
    if ([string]::IsNullOrWhiteSpace($exclusion)) { continue }
    try {
      Add-MpPreference -ExclusionPath $exclusion -ErrorAction Stop
      Write-SmokeLog "Defender exclusion added: $exclusion"
    } catch {
      Write-SmokeLog "Defender exclusion skipped for ${exclusion}: $($_.Exception.Message)"
    }
  }




  $transientExitCodes = @(-1073741819, -1073741502)
  $installArgs = if ($UseDefaultInstallDir) { @('/S') } else { @('/S', "/D=$InstallDir") }

  if (!$SkipFailurePath) {




    $t2MaxAttempts = 3
    $t2Ok = $false
    for ($t2Attempt = 1; $t2Attempt -le $t2MaxAttempts; $t2Attempt++) {
      Write-SmokeLog "T2: failure-path attempt $t2Attempt/$t2MaxAttempts."
      $script:T2TransientCrash = $false
      Invoke-DNAForgeFailurePathSmoke `
        -InstallArgs $installArgs `
        -InitTimeoutSeconds $FailurePathInitTimeoutSeconds `
        -TransientExitCodes $transientExitCodes | Out-Null
      if (!$script:T2TransientCrash) {
        $t2Ok = $true
        break
      }
      if ($t2Attempt -lt $t2MaxAttempts) {
        Start-Sleep -Seconds 5
      }
    }
    if (!$t2Ok) {
      throw "T2: installer kept exiting with a transient crash code after $t2MaxAttempts attempts."
    }
  } else {
    Write-SmokeLog 'T2: skipped (-SkipFailurePath).'
  }

  $installerProcess = Invoke-DNAForgeSilentInstall `
    -InstallArgs $installArgs `
    -TransientExitCodes $transientExitCodes `
    -MaxAttempts 3

  Assert-HappyPathInstallLog `
    -LogPath $primaryInstallLog `
    -DualWriteLogPath $dualWriteInstallLog
  Write-SmokeLog 'T1: happy-path install log assertions passed (schema=1, event=init, event=install_complete; dual-write when writable).'

  if ($UseDefaultInstallDir) {
    $resolvedInstall = Resolve-InstalledDNAForgeExe
    if ($resolvedInstall) {
      $InstallDir = $resolvedInstall.InstallDir
      $exe = $resolvedInstall.Exe
      Write-SmokeLog "Resolved default install dir: $InstallDir"
    } else {
      throw 'NSIS default install completed, but DNAForge.exe was not found in a known default install location.'
    }
  } else {
    $exe = Join-Path $InstallDir 'DNAForge.exe'
  }

  if (!(Test-Path -LiteralPath $exe)) {
    $found = Get-ChildItem -LiteralPath $InstallDir -Filter 'DNAForge.exe' -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) {
      $exe = $found.FullName
    }
  }
  if (!(Test-Path -LiteralPath $exe)) {
    throw "Installed DNAForge.exe was not found under $InstallDir"
  }

  Write-SmokeLog "Installed executable: $exe"

  if ($ApplicationFirewallGroup -or $BlockedRemoteAddresses.Count) {
    if (!$ApplicationFirewallGroup -or !$BlockedRemoteAddresses.Count -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $ApplicationFirewallGroup -ne "DNAForge-F26-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT") {
      throw 'Application egress isolation requires the exact disposable workflow-owned rule group and addresses.'
    }
    if ((Get-Service MpsSvc).Status -ne 'Running' -or @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -ne 'True' -or [string]$_.AllowLocalFirewallRules -eq 'False' }).Count) {
      throw 'Active Windows firewall profiles must permit the task-owned application rules before launching the package.'
    }
    if (!@(Get-NetFirewallRule -Group $ApplicationFirewallGroup -ErrorAction SilentlyContinue).Count) { throw 'The workflow-owned egress rule group is missing.' }
    $isolatedPrograms = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Filter '*.exe')
    if (!$isolatedPrograms.Count) { throw 'No installed executables were found for egress isolation.' }
    foreach ($isolatedProgram in $isolatedPrograms) {
      $applicationRule = New-NetFirewallRule -Name "$ApplicationFirewallGroup-$([guid]::NewGuid().ToString('N'))" -DisplayName $ApplicationFirewallGroup -Group $ApplicationFirewallGroup -Direction Outbound -Action Block -Enabled True -Profile Any -Program $isolatedProgram.FullName -RemoteAddress $BlockedRemoteAddresses
      $activeApplicationRule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $applicationRule.Name
      $applicationFilter = $activeApplicationRule | Get-NetFirewallApplicationFilter
      if ([string]$activeApplicationRule.Enabled -ne 'True' -or [string]$activeApplicationRule.Action -ne 'Block' -or [string]$activeApplicationRule.Direction -ne 'Outbound' -or $applicationFilter.Program -ne $isolatedProgram.FullName) {
        throw 'An installed executable is outside the active first-launch egress boundary.'
      }
    }
    Get-NetFirewallRule -Group $ApplicationFirewallGroup | Select-Object Name,Enabled,Direction,Action | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $LogDir 'release-notes-first-launch-firewall.json') -Encoding utf8
    Write-SmokeLog 'All installed executables have active egress rules before the first application launch.'
  }

  $workspaceDir = Join-Path $UserDataDir 'acceptance-workspace'
  New-Item -ItemType Directory -Force -Path $workspaceDir | Out-Null
  $fixture = Join-Path $repoRoot 'test-fixtures\sequences\circular\pUC19.gb'
  if (Test-Path -LiteralPath $fixture) {
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $workspaceDir 'pUC19.gb') -Force
    Write-SmokeLog "Seeded workspace: $workspaceDir"
  } else {
    Write-SmokeLog "WARNING: fixture missing at $fixture — acceptance gate may fail compute checks."
  }

  $expectedVersion = (Get-Content -Raw (Join-Path $repoRoot 'apps\desktop\package.json') | ConvertFrom-Json).version
  $appLogPath = Join-Path $LogDir 'dnaforge-app.log'
  $appErrLogPath = Join-Path $LogDir 'dnaforge-app.err.log'
  foreach ($path in @($appLogPath, $appErrLogPath)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }

  $previousGpu = $env:ELECTRON_DISABLE_GPU
  $previousNodeEnv = $env:NODE_ENV
  $previousWaypointDataDir = $env:WAYPOINT_DATA_DIR
  $previousSidecarSession = $env:DNAFORGE_MCP_SESSION_TOKEN
  $sessionTokenBytes = New-Object byte[] 32
  $sessionTokenRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $sessionTokenRng.GetBytes($sessionTokenBytes)
  } finally {
    $sessionTokenRng.Dispose()
  }
  $sessionToken = [Convert]::ToBase64String($sessionTokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $env:ELECTRON_DISABLE_GPU = '1'
  $env:NODE_ENV = 'test'
  $env:DNAFORGE_MCP_SESSION_TOKEN = $sessionToken
  if ($AnnotationDataDir) {
    $env:WAYPOINT_DATA_DIR = $AnnotationDataDir
  }

  try {
    Write-SmokeLog 'Launching installed app (log + acceptance gates).'
    $launchArgs = @(
      "--workspace=$workspaceDir",
      "--user-data-dir=$UserDataDir",
      '--enable-logging'
    )
    $appProcess = Start-Process `
      -FilePath $exe `
      -ArgumentList $launchArgs `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $appLogPath `
      -RedirectStandardError $appErrLogPath

    if ($SkipAcceptanceGate) {
      $deadline = (Get-Date).AddSeconds($StartupSeconds)
      do {
        Start-Sleep -Seconds 1
        $appProcess.Refresh()
        if ($appProcess.HasExited) {
          throw "DNAForge exited early with code $($appProcess.ExitCode)"
        }
      } while ((Get-Date) -lt $deadline)
      Write-SmokeLog "Installed app survived ${StartupSeconds}s startup (acceptance gate skipped)."
    } else {
      $acceptanceScript = Join-Path $repoRoot 'scripts\verify-packaged-app-windows.ps1'
      if (!(Test-Path -LiteralPath $acceptanceScript)) {
        throw "Missing acceptance gate script: $acceptanceScript"
      }
      & $acceptanceScript `
        -AppLogPath $appLogPath `
        -AppErrLogPath $appErrLogPath `
        -ExpectedVersion $expectedVersion `
        -AppProcess $appProcess `
        -StartupBudget $StartupSeconds `
        -TimeoutSeconds 300 `
        -SessionToken $sessionToken
      Write-SmokeLog 'Packaged-app acceptance gates passed (sidecar + compute + bio binaries).'
    }
  } finally {
    $env:ELECTRON_DISABLE_GPU = $previousGpu
    $env:NODE_ENV = $previousNodeEnv
    $env:WAYPOINT_DATA_DIR = $previousWaypointDataDir
    $env:DNAFORGE_MCP_SESSION_TOKEN = $previousSidecarSession
  }

  Write-SmokeLog 'Windows install smoke passed.'
} finally {
  if ($appProcess -and !$appProcess.HasExited) {
    Write-SmokeLog "Stopping DNAForge process $($appProcess.Id)."
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
  }

  if ($telemetryFenceLeaseId) {
    node (Join-Path $repoRoot 'scripts\telemetry-suppression-fence.mjs') `
      clear `
      --user-data-dir $UserDataDir `
      --lease-id $telemetryFenceLeaseId | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $UserDataDir)) {
      Write-SmokeLog 'WARNING: packaged telemetry suppression fence did not clear cleanly.'
    }
  }

  if (!$KeepInstall) {
    $uninstaller = if ($InstallDir) { Join-Path $InstallDir 'Uninstall DNAForge.exe' } else { '' }
    if ($uninstaller -and (Test-Path -LiteralPath $uninstaller)) {
      Write-SmokeLog 'Running NSIS silent uninstall.'
      Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru -Wait | Out-Null
    }

    foreach ($path in @($InstallDir, $UserDataDir)) {
      if ($path -and (Test-Path -LiteralPath $path)) {
        if ($UseDefaultInstallDir -and $path -eq $InstallDir) {
          Assert-UnderLocalAppDataPrograms $path
        } else {
          Assert-UnderTemp $path
        }
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  } else {
    Write-SmokeLog "Keeping install dir: $InstallDir"
    Write-SmokeLog "Keeping user data dir: $UserDataDir"
  }



  try {
    Clear-DNAForgeInstallLogs -InstallerPath $installer
  } catch {
    Write-SmokeLog "Install log cleanup skipped: $($_.Exception.Message)"
  }

  if ($mockDiagnosticsProcess -and !$mockDiagnosticsProcess.HasExited) {
    Stop-Process -Id $mockDiagnosticsProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($diagnosticsSidecarExisted) {
    [System.IO.File]::WriteAllBytes($diagnosticsSidecar, $diagnosticsSidecarOriginal)
  } elseif (Test-Path -LiteralPath $diagnosticsSidecar) {
    Remove-Item -LiteralPath $diagnosticsSidecar -Force -ErrorAction SilentlyContinue
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
