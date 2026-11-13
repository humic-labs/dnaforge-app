param(
  [Parameter(Mandatory = $true)]
  [string]$PreviousInstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateDirectory,

  [Parameter(Mandatory = $true)]
  [string]$PreviousVersion,

  [Parameter(Mandatory = $true)]
  [string]$CandidateVersion,

  [string]$PreviousFeedBase = '',

  [string]$LogDir = '',

  [int]$FeedReadyTimeoutSeconds = 30,

  [int]$UpdateDownloadTimeoutSeconds = 1200,

  [int]$InstallRelaunchTimeoutSeconds = 420,

  [int]$PostHogIsolationPort = 8794,

  [int]$DiagnosticsIsolationPort = 8795,

  [switch]$AllowUnsignedLoopbackCandidate,

  [switch]$RestartThroughRenderer,

  [int]$RendererDebugPort = 9337,

  [switch]$PoisonLegacyUninstaller
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'windows-install-log.ps1')

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
  Write-ProofLog "$Label Authenticode status=$($signature.Status) signer=$subject"
  if ($signature.Status -ne 'Valid') {
    throw "$Label Authenticode signature is not valid: $($signature.Status)"
  }
  if ($subject -notlike '*Humic Labs Inc.*') {
    throw "$Label signer does not identify Humic Labs Inc.: $subject"
  }
}

function Assert-CandidateInstallerSignature {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (!$AllowUnsignedLoopbackCandidate) {
    Assert-HumicSignature -Path $Path -Label $Label
    return 'Valid'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  Write-ProofLog "$Label candidate installer Authenticode status=$($signature.Status)"
  if ($signature.Status -ne 'NotSigned') {
    throw "$Label candidate installer must be NotSigned in unsigned loopback test mode; got $($signature.Status)."
  }
  return [string]$signature.Status
}

function Get-InstallProcesses {
  param([Parameter(Mandatory = $true)][string]$InstallDirectory)
  $prefix = (Resolve-FullPath $InstallDirectory).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  ) + [System.IO.Path]::DirectorySeparatorChar
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
      }
  )
}

function Wait-ForProcessIdsToExit {
  param(
    [Parameter(Mandatory = $true)][int[]]$ProcessIds,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $live = @(
      $ProcessIds | Where-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
      }
    )
    if ($live.Count -eq 0) {
      Write-ProofLog "$Label exited: $($ProcessIds -join ',')"
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "$Label remained alive after ${TimeoutSeconds}s: $($live -join ',')"
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
  param([string[]]$ExistingExecutablePaths = @())
  $existing = @($ExistingExecutablePaths | ForEach-Object { Resolve-FullPath $_ })
  foreach ($candidate in (Get-DefaultInstallCandidates)) {
    $exe = Join-Path $candidate 'DNAForge.exe'
    if (Test-Path -LiteralPath $exe) {
      $resolvedExe = (Resolve-Path -LiteralPath $exe).Path
      if ($existing -notcontains (Resolve-FullPath $resolvedExe)) { return $resolvedExe }
    }
  }
  $programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
  $found = Get-ChildItem -LiteralPath $programsRoot -Filter 'DNAForge.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $existing -notcontains (Resolve-FullPath $_.FullName) } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($found) { return $found.FullName }
  return ''
}

function Test-LogMarker {
  param([Parameter(Mandatory = $true)][string]$Marker)
  foreach ($path in @($script:AppOutLog, $script:AppErrLog)) {
    if ((Test-Path -LiteralPath $path) -and (Select-String -LiteralPath $path -SimpleMatch $Marker -Quiet)) {
      return $true
    }
  }
  return $false
}

function Wait-ForLogMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Marker,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-LogMarker $Marker) {
      Write-ProofLog "Observed app marker: $Marker"
      return
    }
    if ($script:PreviousAppProcess) {
      $script:PreviousAppProcess.Refresh()
      if ($script:PreviousAppProcess.HasExited) {
        throw "Previous app exited before marker: $Marker (exit=$($script:PreviousAppProcess.ExitCode))"
      }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Timed out after ${TimeoutSeconds}s waiting for app marker: $Marker"
}

function Wait-ForServerMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Marker,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if ((Test-Path -LiteralPath $script:ServerOutLog) -and (Select-String -LiteralPath $script:ServerOutLog -SimpleMatch $Marker -Quiet)) {
      Write-ProofLog "Observed local-feed request: $Marker"
      return
    }
    if ($script:ServerProcess) {
      $script:ServerProcess.Refresh()
      if ($script:ServerProcess.HasExited) {
        throw "Runner-local update server exited before marker: $Marker (exit=$($script:ServerProcess.ExitCode))"
      }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Timed out after ${TimeoutSeconds}s waiting for local-feed marker: $Marker"
}

function Read-NewBootLogBytes {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][long]$StartOffset
  )
  if (!(Test-Path -LiteralPath $Path)) { return '' }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -le $StartOffset) { return '' }
  return [System.Text.Encoding]::UTF8.GetString($bytes, [int]$StartOffset, $bytes.Length - [int]$StartOffset)
}

function Assert-UserDataPreserved {
  $sentinel = Join-Path $canonicalUserData 'update-acceptance-user-data-sentinel'
  if (
    !(Test-Path -LiteralPath $sentinel) -or
    [System.IO.File]::ReadAllText($sentinel) -ne $script:UserDataSentinelValue
  ) {
    throw 'Native replacement did not preserve the exact user-data sentinel.'
  }
}

function Install-LegacyUninstallerPoison {
  if (!$PoisonLegacyUninstaller) { return }
  if ($PreviousVersion -ne '0.8.10') {
    throw 'The bounded legacy-uninstaller proof must use the signed v0.8.10 predecessor.'
  }

  $poisonPath = Join-Path $LogDir 'broken-predecessor-uninstaller.cmd'
  if (!(Test-Path -LiteralPath $poisonPath)) {
    $poisonSource = @'
@echo off
if defined DNAFORGE_BROKEN_UNINSTALLER_MARKER (
  >>"%DNAFORGE_BROKEN_UNINSTALLER_MARKER%" echo invoked
)
exit /b 2
'@
    [System.IO.File]::WriteAllText($poisonPath, $poisonSource, [System.Text.Encoding]::ASCII)
  }

  $probeMarker = Join-Path $LogDir 'broken-uninstaller-probe.log'
  if (Test-Path -LiteralPath $probeMarker) { Remove-Item -LiteralPath $probeMarker -Force }
  $priorMarker = [Environment]::GetEnvironmentVariable('DNAFORGE_BROKEN_UNINSTALLER_MARKER', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('DNAFORGE_BROKEN_UNINSTALLER_MARKER', $probeMarker, 'Process')
    & $poisonPath
    $probeExitCode = $LASTEXITCODE
  } finally {
    [Environment]::SetEnvironmentVariable('DNAFORGE_BROKEN_UNINSTALLER_MARKER', $priorMarker, 'Process')
  }
  if ($probeExitCode -ne 2 -or !(Test-Path -LiteralPath $probeMarker)) {
    throw 'The deliberately broken predecessor uninstaller did not prove its exit-2 marker contract.'
  }
  Remove-Item -LiteralPath $probeMarker -Force

  $script:BrokenUninstallerMarker = Join-Path $LogDir 'broken-uninstaller-invoked.log'
  if (Test-Path -LiteralPath $script:BrokenUninstallerMarker) {
    Remove-Item -LiteralPath $script:BrokenUninstallerMarker -Force
  }
  $script:LegacyInstallSentinel = Join-Path $script:InstallDir 'dnaforge-legacy-install-sentinel'
  [System.IO.File]::WriteAllText(
    $script:LegacyInstallSentinel,
    'the candidate must replace this old installation tree',
    [System.Text.Encoding]::ASCII
  )

  $uninstallRoots = @(
    'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $matches = @()
  foreach ($root in $uninstallRoots) {
    if (!(Test-Path -LiteralPath $root)) { continue }
    foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $entry) { continue }
      $displayVersionProperty = $entry.PSObject.Properties['DisplayVersion']
      $uninstallStringProperty = $entry.PSObject.Properties['UninstallString']
      $displayVersion = if ($displayVersionProperty) { [string]$displayVersionProperty.Value } else { '' }
      $uninstallString = if ($uninstallStringProperty) { [string]$uninstallStringProperty.Value } else { '' }
      if (
        $displayVersion -eq $PreviousVersion -and
        $uninstallString -and
        $uninstallString.Contains(
          $script:InstallDir,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      ) {
        $matches += $key
      }
    }
  }
  if ($matches.Count -eq 0) {
    throw "Could not find the registered v$PreviousVersion UninstallString for $script:InstallDir."
  }
  foreach ($key in $matches) {
    $replacement = '"{0}" /d /c call "{1}"' -f $env:ComSpec, $poisonPath
    Set-ItemProperty -LiteralPath $key.PSPath -Name UninstallString -Value $replacement
    Set-ItemProperty -LiteralPath $key.PSPath -Name QuietUninstallString -Value $replacement
  }
  [Environment]::SetEnvironmentVariable(
    'DNAFORGE_BROKEN_UNINSTALLER_MARKER',
    $script:BrokenUninstallerMarker,
    'Process'
  )
  Write-ProofLog "Installed exit-2 predecessor poison in $($matches.Count) uninstall registration(s)."
}

function Assert-LegacyRescueState {
  param([switch]$RequireSentinelRemoved)
  if (!$PoisonLegacyUninstaller) { return }
  if (Test-Path -LiteralPath $script:BrokenUninstallerMarker) {
    throw 'The candidate invoked the deliberately broken predecessor uninstaller.'
  }
  if ($RequireSentinelRemoved -and (Test-Path -LiteralPath $script:LegacyInstallSentinel)) {
    throw 'The candidate did not remove the legacy installation-tree sentinel.'
  }
}

if (!$LogDir) {
  $LogDir = Join-Path $env:RUNNER_TEMP 'dnaforge-windows-previous-version-update'
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:ProofLog = Join-Path $LogDir 'verify-windows-update-from-previous-version.log'
$script:AppOutLog = Join-Path $LogDir 'previous-app.stdout.log'
$script:AppErrLog = Join-Path $LogDir 'previous-app.stderr.log'
$script:ServerOutLog = Join-Path $LogDir 'local-feed.stdout.log'
$serverErrLog = Join-Path $LogDir 'local-feed.stderr.log'
$readyFile = Join-Path $LogDir 'local-feed-url.txt'
$receiptPath = Join-Path $LogDir 'windows-installed-update-regression.json'

function Write-ProofLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message
  Write-Host $line
  Add-Content -LiteralPath $script:ProofLog -Value $line -Encoding UTF8
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$previousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
$candidateDir = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$candidateInstaller = Join-Path $candidateDir "DNAForge-Setup-${CandidateVersion}.exe"
$candidateBlockmap = "$candidateInstaller.blockmap"
$candidateManifest = Join-Path $candidateDir 'latest.yml'
$canonicalUserData = Join-Path $env:APPDATA 'DNAForge'
$canonicalBootLog = Join-Path $canonicalUserData 'logs\main-boot.log'
$programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'

$script:ServerProcess = $null
$script:PreviousAppProcess = $null
$script:PostHogProcess = $null
$script:DiagnosticsProcess = $null
$installedExe = ''
$installDir = ''
$script:InstallDir = ''
$updaterCacheDir = ''
$telemetryFenceLeaseId = ''
$previousSidecarPids = @()
$candidateSidecarPids = @()
$candidateInstallerSignatureStatus = ''
$relaunchExecutablePath = ''
$script:BrokenUninstallerMarker = ''
$script:LegacyInstallSentinel = ''
$script:UserDataSentinelValue = "installed-update-$CandidateVersion-$([guid]::NewGuid().ToString('N'))"
$postHogBase = "http://127.0.0.1:$PostHogIsolationPort"
$diagnosticsBase = "http://127.0.0.1:$DiagnosticsIsolationPort"
$postHogOutLog = Join-Path $LogDir 'posthog-isolation.stdout.log'
$postHogErrLog = Join-Path $LogDir 'posthog-isolation.stderr.log'
$diagnosticsOutLog = Join-Path $LogDir 'diagnostics-isolation.stdout.log'
$diagnosticsErrLog = Join-Path $LogDir 'diagnostics-isolation.stderr.log'
$diagnosticsJournal = Join-Path $LogDir 'diagnostics-isolation-journal.json'
$previousInstallerSidecar = Join-Path (Split-Path -Parent $previousInstaller) 'dnaforge-diagnostics-url.txt'
$previousInstallerSidecarExisted = Test-Path -LiteralPath $previousInstallerSidecar
$previousInstallerSidecarOriginal = if ($previousInstallerSidecarExisted) {
  [System.IO.File]::ReadAllBytes($previousInstallerSidecar)
} else {
  $null
}
$candidateInstallerSidecar = ''
$candidateInstallerSidecarExisted = $false
$candidateInstallerSidecarOriginal = $null
$previousPostHogApiKey = [Environment]::GetEnvironmentVariable('POSTHOG_API_KEY', 'Process')
$previousPostHogHost = [Environment]::GetEnvironmentVariable('POSTHOG_HOST', 'Process')
$previousDiagnosticsUrl = [Environment]::GetEnvironmentVariable('DIAGNOSTICS_URL', 'Process')
$previousDiagnosticsOverride = [Environment]::GetEnvironmentVariable(
  'DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE',
  'Process'
)
$previousBrokenUninstallerMarker = [Environment]::GetEnvironmentVariable(
  'DNAFORGE_BROKEN_UNINSTALLER_MARKER',
  'Process'
)
$userDataExisted = Test-Path -LiteralPath $canonicalUserData
$existingInstalledExecutables = @()
if (Test-Path -LiteralPath $programsRoot) {
  $existingInstalledExecutables = @(Get-ChildItem -LiteralPath $programsRoot -Filter 'DNAForge.exe' -File -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { (Resolve-Path -LiteralPath $_.FullName).Path })
}

try {
  Write-ProofLog "Windows previous-version acceptance: previous=$PreviousVersion candidate=$CandidateVersion"
  if ($PreviousVersion -eq $CandidateVersion) {
    throw 'PreviousVersion and CandidateVersion must differ.'
  }
  foreach ($required in @($candidateInstaller, $candidateBlockmap, $candidateManifest)) {
    if (!(Test-Path -LiteralPath $required)) { throw "Candidate updater artifact missing: $required" }
  }
  if ($userDataExisted) {
    throw "Refusing to use a pre-existing DNAForge packaged profile: $canonicalUserData"
  }
  foreach ($candidate in (Get-DefaultInstallCandidates)) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'DNAForge.exe')) {
      throw "Refusing to overwrite a pre-existing DNAForge install: $candidate"
    }
  }

  node (Join-Path $repoRoot 'scripts\verify-windows-update-feed.mjs') `
    --manifest-file $candidateManifest `
    --artifact-directory $candidateDir `
    --expected-version $CandidateVersion
  if ($LASTEXITCODE -ne 0) { throw 'Candidate Windows update snapshot failed verification.' }
  node (Join-Path $repoRoot 'scripts\verify-windows-update-feed.mjs') `
    --assert-newer $CandidateVersion $PreviousVersion
  if ($LASTEXITCODE -ne 0) { throw 'Candidate version is not newer than the previous version.' }

  Assert-HumicSignature -Path $previousInstaller -Label "Previous v$PreviousVersion installer"
  $candidateInstallerSignatureStatus = Assert-CandidateInstallerSignature `
    -Path $candidateInstaller `
    -Label "Candidate v$CandidateVersion installer"

  Set-Content -LiteralPath $previousInstallerSidecar -Value $diagnosticsBase -Encoding ascii -NoNewline
  $env:POSTHOG_API_KEY = 'dnaforge-packaged-update-test'
  $env:POSTHOG_HOST = $postHogBase
  $env:DIAGNOSTICS_URL = $diagnosticsBase
  $env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE = '1'

  $script:PostHogProcess = Start-Process `
    -FilePath 'node' `
    -ArgumentList @(
      (Join-Path $repoRoot 'tools\devops\analytics\posthog-test-collector.mjs'),
      "--port=$PostHogIsolationPort",
      '--api-key=dnaforge-packaged-update-test'
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
    if ($postHogHealthy -and $diagnosticsHealthy) { break }
    foreach ($process in @($script:PostHogProcess, $script:DiagnosticsProcess)) {
      $process.Refresh()
      if ($process.HasExited) {
        throw "Packaged telemetry isolation process exited before ready (code=$($process.ExitCode))."
      }
    }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $isolationDeadline)
  if (!$postHogHealthy -or !$diagnosticsHealthy) {
    throw 'Packaged telemetry isolation endpoints did not become healthy.'
  }
  Write-ProofLog "Packaged telemetry isolation ready: posthog=$postHogBase diagnostics=$diagnosticsBase"

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
  [System.IO.File]::WriteAllText(
    (Join-Path $canonicalUserData 'update-acceptance-user-data-sentinel'),
    $script:UserDataSentinelValue,
    [System.Text.Encoding]::ASCII
  )

  foreach ($path in @($script:AppOutLog, $script:AppErrLog, $script:ServerOutLog, $serverErrLog, $readyFile)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
  $script:ServerProcess = Start-Process `
    -FilePath 'node' `
    -ArgumentList @(
      (Join-Path $repoRoot 'scripts\serve-local-update-feed.mjs'),
      '--directory', $candidateDir,
      '--ready-file', $readyFile
    ) `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $script:ServerOutLog `
    -RedirectStandardError $serverErrLog
  $readyDeadline = (Get-Date).AddSeconds($FeedReadyTimeoutSeconds)
  do {
    if ((Test-Path -LiteralPath $readyFile) -and (Get-Item -LiteralPath $readyFile).Length -gt 0) { break }
    $script:ServerProcess.Refresh()
    if ($script:ServerProcess.HasExited) {
      throw "Runner-local update server exited before ready (exit=$($script:ServerProcess.ExitCode))."
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $readyDeadline)
  if (!(Test-Path -LiteralPath $readyFile) -or (Get-Item -LiteralPath $readyFile).Length -le 0) {
    throw "Runner-local update server did not become ready in ${FeedReadyTimeoutSeconds}s."
  }
  $feedOrigin = (Get-Content -LiteralPath $readyFile -Raw).Trim()
  $feedUrl = "$feedOrigin/updates/stable/x64"
  Write-ProofLog "Runner-local candidate feed: $feedUrl/latest.yml"

  Write-ProofLog 'Installing the exact signed previous stable installer at the default per-user path.'
  $install = Start-Process -FilePath $previousInstaller -ArgumentList @('/S') -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Previous installer exited with code $($install.ExitCode)." }
  $installedExe = Resolve-InstalledExecutable -ExistingExecutablePaths $existingInstalledExecutables
  if (!$installedExe) { throw 'Previous installer completed, but DNAForge.exe was not found.' }
  $installDir = Split-Path -Parent $installedExe
  $script:InstallDir = $installDir
  Assert-DescendantPath -Path $installDir -Parent $programsRoot -Purpose 'to use a Windows update test install'
  $installedPreviousVersion = Get-ExecutableVersion $installedExe
  if ($installedPreviousVersion -ne $PreviousVersion) {
    $shownPreviousVersion = if ($installedPreviousVersion) { $installedPreviousVersion } else { '<none>' }
    throw "Installed previous executable reports v$shownPreviousVersion, expected v$PreviousVersion."
  }
  Assert-HumicSignature -Path $installedExe -Label "Installed previous v$PreviousVersion app"

  $updateConfig = Join-Path $installDir 'resources\app-update.yml'
  $appAsar = Join-Path $installDir 'resources\app.asar'
  $sealedPrimary = @(& node (Join-Path $repoRoot 'scripts\lib\patch-update-feed-base.mjs') sealed-authority $appAsar 1)
  $sealedStatus = $LASTEXITCODE
  if ($sealedStatus -eq 0 -and $sealedPrimary.Count -eq 1 -and ![string]::IsNullOrWhiteSpace([string]$sealedPrimary[0])) {
    $bakedPreviousFeedBase = ([string]$sealedPrimary[0]).Trim()
    Write-ProofLog "Installed v$PreviousVersion seals its update authorities; patching from compiled authority 1: $bakedPreviousFeedBase"
  } elseif ($sealedStatus -eq 3) {
    if ([string]::IsNullOrWhiteSpace($PreviousFeedBase)) {
      throw 'PreviousFeedBase is required for a predecessor without sealed update authorities so a non-empty compiled feed cannot bypass the runner-local candidate.'
    }
    $bakedPreviousFeedBase = $PreviousFeedBase
  } else {
    throw "Could not read the installed v$PreviousVersion compiled update authorities."
  }
  $prepareArgs = @(
    (Join-Path $repoRoot 'scripts\prepare-windows-app-for-staged-update.mjs'),
    '--config', $updateConfig,
    '--target-feed-url', $feedUrl
  )
  $preparedMode = 'generated-config'
  $compiledFeedUrl = ''
  if ($bakedPreviousFeedBase) {
    if ($feedOrigin.Length -ge $bakedPreviousFeedBase.Length) {




      $targetBase = $feedOrigin
    } else {
      $targetBase = $feedOrigin + '/' + ('x' * ($bakedPreviousFeedBase.Length - $feedOrigin.Length - 1))
    }
    $compiledFeedUrl = "$($targetBase.TrimEnd('/'))/updates/stable/x64"
    $prepareArgs += @(
      '--asar', $appAsar,
      '--source-base', $bakedPreviousFeedBase,
      '--target-base', $targetBase
    )
  }
  if ($AllowUnsignedLoopbackCandidate) {
    $prepareArgs += '--allow-unsigned-loopback-candidate'
  }
  $prepareOutput = & node @prepareArgs
  if ($LASTEXITCODE -ne 0) { throw 'Could not redirect the disposable previous install to the local candidate feed.' }
  $prepareOutput | ForEach-Object { Write-ProofLog $_ }
  if (@($prepareOutput) -contains 'mode=compiled-base') {
    $preparedMode = 'compiled-base'
  }
  if (
    $AllowUnsignedLoopbackCandidate -and
    @($prepareOutput) -notcontains 'candidate_signature_policy=unsigned-loopback-test'
  ) {
    throw 'Staged predecessor did not confirm candidate_signature_policy=unsigned-loopback-test.'
  }
  $cacheName = node --input-type=module -e "import{parse}from'yaml';import{readFileSync}from'node:fs';console.log(parse(readFileSync(process.argv[1],'utf8')).updaterCacheDirName)" $updateConfig
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($cacheName)) {
    throw 'Could not resolve updaterCacheDirName from the prepared previous install.'
  }
  $cacheName = $cacheName.Trim()
  $updaterCacheDir = Join-Path $env:LOCALAPPDATA $cacheName
  node (Join-Path $repoRoot 'scripts\verify-windows-installer-cache-baseline.mjs') `
    --cache-directory $updaterCacheDir `
    --expected-installer $previousInstaller
  if ($LASTEXITCODE -ne 0) {
    throw 'Previous installer cache baseline failed verification.'
  }
  Install-LegacyUninstallerPoison

  Write-ProofLog "Launching installed v$PreviousVersion and waiting for automatic detection + download."
  $launchArguments = @('--enable-logging')
  if ($RestartThroughRenderer) {
    $launchArguments += "--remote-debugging-port=$RendererDebugPort"
  }
  $script:PreviousAppProcess = Start-Process `
    -FilePath $installedExe `
    -ArgumentList $launchArguments `
    -PassThru `
    -WindowStyle Normal `
    -RedirectStandardOutput $script:AppOutLog `
    -RedirectStandardError $script:AppErrLog
  if ($preparedMode -eq 'compiled-base') {
    $expectedManifestRequest = "GET /$(($compiledFeedUrl -replace '^https?://[^/]+/?', '').TrimStart('/'))/latest.yml"
  } else {
    $expectedManifestRequest = 'GET /updates/stable/x64/latest.yml'
  }
  Wait-ForServerMarker -Marker $expectedManifestRequest -TimeoutSeconds 120
  Wait-ForLogMarker -Marker "[AutoUpdater] Update available: $CandidateVersion" -TimeoutSeconds 120
  Wait-ForLogMarker -Marker "[AutoUpdater] Update downloaded: $CandidateVersion" -TimeoutSeconds $UpdateDownloadTimeoutSeconds

  $previousSidecars = @(
    Get-InstallProcesses -InstallDirectory $installDir |
      Where-Object { $_.Name -ieq 'waypoint-api.exe' }
  )
  if ($previousSidecars.Count -eq 0) {
    throw "Installed v$PreviousVersion reached update-downloaded without a live waypoint-api.exe."
  }
  $previousSidecarPids = @($previousSidecars | ForEach-Object { [int]$_.ProcessId })
  $previousSidecars |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate |
    ConvertTo-Json -Depth 3 |
    Set-Content -LiteralPath (Join-Path $LogDir 'predecessor-sidecars.json') -Encoding utf8
  Write-ProofLog "Captured predecessor sidecar PIDs before restart: $($previousSidecarPids -join ',')"

  $candidateInstallerHash = (Get-FileHash -LiteralPath $candidateInstaller -Algorithm SHA256).Hash
  $cachedCandidateInstaller = Get-ChildItem `
    -LiteralPath $updaterCacheDir `
    -Filter '*.exe' `
    -File `
    -Recurse `
    -ErrorAction SilentlyContinue |
    Where-Object {
      (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -eq $candidateInstallerHash
    } |
    Select-Object -First 1
  if (!$cachedCandidateInstaller) {
    throw 'Downloaded candidate installer was not found in the updater cache by exact SHA256.'
  }
  $candidateInstallerSidecar = Join-Path `
    (Split-Path -Parent $cachedCandidateInstaller.FullName) `
    'dnaforge-diagnostics-url.txt'
  $candidateInstallerSidecarExisted = Test-Path -LiteralPath $candidateInstallerSidecar
  if ($candidateInstallerSidecarExisted) {
    $candidateInstallerSidecarOriginal = [System.IO.File]::ReadAllBytes($candidateInstallerSidecar)
  }
  Set-Content `
    -LiteralPath $candidateInstallerSidecar `
    -Value $diagnosticsBase `
    -Encoding ascii `
    -NoNewline
  Write-ProofLog "Bound candidate installer diagnostics to the local sink: $candidateInstallerSidecar"

  if (!(Test-Path -LiteralPath $canonicalBootLog)) {
    throw "Previous app never wrote its canonical boot log: $canonicalBootLog"
  }
  $initialBootLog = Get-Content -LiteralPath $canonicalBootLog -Raw
  if ($initialBootLog -notlike "*version=$PreviousVersion platform=win32*") {
    throw "Canonical boot log did not record previous v$PreviousVersion."
  }
  $bootOffset = (Get-Item -LiteralPath $canonicalBootLog).Length

  Clear-DNAForgeInstallLogs -InstallerPath $cachedCandidateInstaller.FullName
  if ($RestartThroughRenderer) {
    $rendererReceipt = Join-Path $LogDir 'restart-now.json'
    Write-ProofLog 'Clicking the visible Restart now action through the packaged renderer.'
    & (Join-Path $PSScriptRoot 'click-windows-update-restart.ps1') `
      -Port $RendererDebugPort `
      -Version $CandidateVersion `
      -OutputPath $rendererReceipt
    if (!(Test-Path -LiteralPath $rendererReceipt)) {
      throw 'Restart now helper did not write its action receipt.'
    }
  } else {
    Write-ProofLog 'Requesting a normal window close; quit orchestration must invoke quitAndInstall.'
    if (!$script:PreviousAppProcess.CloseMainWindow()) {
      throw 'CloseMainWindow returned false; the real normal-quit updater path was not exercised.'
    }
  }
  $exitDeadline = (Get-Date).AddSeconds(180)
  do {
    $script:PreviousAppProcess.Refresh()
    if ($script:PreviousAppProcess.HasExited) { break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $exitDeadline)
  if (!$script:PreviousAppProcess.HasExited) {
    throw 'Previous app did not exit after the update install request.'
  }

  Write-ProofLog 'Waiting for NSIS replacement and the candidate relaunch.'
  $relaunchDeadline = (Get-Date).AddSeconds($InstallRelaunchTimeoutSeconds)
  $candidateBoot = ''
  $installedCandidateVersion = ''
  do {
    Assert-LegacyRescueState
    $installedCandidateVersion = Get-ExecutableVersion $installedExe
    $candidateBoot = Read-NewBootLogBytes -Path $canonicalBootLog -StartOffset $bootOffset
    if (
      $installedCandidateVersion -eq $CandidateVersion -and
      $candidateBoot -like "*version=$CandidateVersion platform=win32*"
    ) {
      break
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $relaunchDeadline)
  if ($installedCandidateVersion -ne $CandidateVersion) {
    $shownCandidateVersion = if ($installedCandidateVersion) { $installedCandidateVersion } else { '<none>' }
    throw "Candidate did not replace the installed executable (reported v$shownCandidateVersion)."
  }
  if ($candidateBoot -notlike "*version=$CandidateVersion platform=win32*") {
    throw "Candidate v$CandidateVersion did not relaunch and append its boot marker."
  }
  Assert-UserDataPreserved
  Assert-LegacyRescueState -RequireSentinelRemoved
  Assert-HappyPathInstallLog `
    -LogPath (Get-PrimaryInstallLogPath) `
    -DualWriteLogPath (Get-DualWriteInstallLogPath -InstallerPath $cachedCandidateInstaller.FullName)
  if ($AllowUnsignedLoopbackCandidate) {
    $installedCandidateStatus = Get-AuthenticodeSignature -LiteralPath $installedExe
    if ($installedCandidateStatus.Status -ne 'NotSigned') {
      throw "Relaunched candidate app must be NotSigned in unsigned loopback test mode; got $($installedCandidateStatus.Status)."
    }
  } else {
    Assert-HumicSignature -Path $installedExe -Label "Relaunched candidate v$CandidateVersion app"
  }

  Wait-ForProcessIdsToExit `
    -ProcessIds $previousSidecarPids `
    -TimeoutSeconds 30 `
    -Label "Predecessor v$PreviousVersion sidecars"

  $candidateReadyDeadline = (Get-Date).AddSeconds(120)
  $candidateAppProcess = $null
  $candidateSidecars = @()
  do {
    $candidateAppProcess = Get-Process -Name 'DNAForge' -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne 0 -and
        $_.Path -and
        (Resolve-FullPath $_.Path) -eq (Resolve-FullPath $installedExe)
      } |
      Select-Object -First 1
    $candidateSidecars = @(
      Get-InstallProcesses -InstallDirectory $installDir |
        Where-Object { $_.Name -ieq 'waypoint-api.exe' }
    )
    if ($candidateAppProcess -and $candidateSidecars.Count -gt 0) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $candidateReadyDeadline)
  if (!$candidateAppProcess) {
    throw "Candidate v$CandidateVersion relaunched without a closable main window."
  }
  if ($candidateSidecars.Count -eq 0) {
    throw "Candidate v$CandidateVersion relaunched without a live waypoint-api.exe."
  }
  $relaunchExecutablePath = $candidateAppProcess.Path
  if (
    ![string]::Equals(
      (Resolve-FullPath $relaunchExecutablePath),
      (Resolve-FullPath $installedExe),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Candidate relaunched from an unexpected executable: $relaunchExecutablePath"
  }
  $candidateSidecarPids = @($candidateSidecars | ForEach-Object { [int]$_.ProcessId })
  $candidateSidecars |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate |
    ConvertTo-Json -Depth 3 |
    Set-Content -LiteralPath (Join-Path $LogDir 'candidate-sidecars.json') -Encoding utf8
  Write-ProofLog "Closing relaunched candidate with sidecar PIDs: $($candidateSidecarPids -join ',')"
  if (!$candidateAppProcess.CloseMainWindow()) {
    throw 'Candidate CloseMainWindow returned false; shutdown containment was not exercised.'
  }
  Wait-ForProcessIdsToExit `
    -ProcessIds @([int]$candidateAppProcess.Id) `
    -TimeoutSeconds 30 `
    -Label "Candidate v$CandidateVersion app"
  Wait-ForProcessIdsToExit `
    -ProcessIds $candidateSidecarPids `
    -TimeoutSeconds 30 `
    -Label "Candidate v$CandidateVersion sidecars"

  $candidateSignaturePolicy = if ($AllowUnsignedLoopbackCandidate) {
    'unsigned-loopback-test'
  } else {
    'production-signature-required'
  }
  $restartAction = if ($RestartThroughRenderer) { 'renderer' } else { 'window-close' }
  [ordered]@{
    schema = 'dnaforge.windows-installed-update-regression.v1'
    status = 'success'
    fromVersion = $PreviousVersion
    candidateVersion = $CandidateVersion
    installedVersion = $installedCandidateVersion
    feedUrl = $feedUrl
    candidateSignaturePolicy = $candidateSignaturePolicy
    candidateInstallerSignatureStatus = $candidateInstallerSignatureStatus
    restartAction = $restartAction
    updateAvailable = $true
    updateDownloaded = $true
    installComplete = $true
    legacyInstallRemoved = $PoisonLegacyUninstaller.IsPresent
    legacyUninstallerInvocations = 0
    relaunchObserved = $true
    bootMarkerObserved = $true
    expectedExecutablePath = (Resolve-FullPath $installedExe)
    relaunchExecutablePath = (Resolve-FullPath $relaunchExecutablePath)
    userDataPreserved = $true
    predecessorSidecarPids = @($previousSidecarPids)
    candidateSidecarPids = @($candidateSidecarPids)
    predecessorSidecarsExited = $true
    candidateSidecarsExited = $true
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding utf8

  Write-ProofLog "PASS: v$PreviousVersion detected, downloaded, installed, relaunched v$CandidateVersion, and both sidecar generations drained"
} finally {
  if ($candidateInstaller) {
    Write-InstallLogDump -WriteLog { param($message) Write-ProofLog $message } -InstallerPath $candidateInstaller
  }
  if ($script:ServerProcess -and !$script:ServerProcess.HasExited) {
    Stop-Process -Id $script:ServerProcess.Id -Force -ErrorAction SilentlyContinue
  }

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
    Start-Sleep -Seconds 1
    $uninstaller = Join-Path $installDir 'Uninstall DNAForge.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru -Wait | Out-Null
    }
    if (Test-Path -LiteralPath $installDir) {
      Assert-DescendantPath -Path $installDir -Parent $programsRoot -Purpose 'to clean the Windows update test install'
      Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  if ($telemetryFenceLeaseId) {
    node (Join-Path $repoRoot 'scripts\telemetry-suppression-fence.mjs') `
      clear `
      --user-data-dir $canonicalUserData `
      --lease-id $telemetryFenceLeaseId | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath $canonicalUserData)) {
      Write-ProofLog 'WARNING: packaged update telemetry fence did not clear cleanly.'
    }
  }

  if (!$userDataExisted -and (Test-Path -LiteralPath $canonicalUserData)) {
    Assert-DescendantPath -Path $canonicalUserData -Parent $env:APPDATA -Purpose 'to clean the Windows update test profile'
    Remove-Item -LiteralPath $canonicalUserData -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($candidateInstallerSidecar) {
    if ($candidateInstallerSidecarExisted) {
      [System.IO.File]::WriteAllBytes(
        $candidateInstallerSidecar,
        $candidateInstallerSidecarOriginal
      )
    } elseif (Test-Path -LiteralPath $candidateInstallerSidecar) {
      Remove-Item -LiteralPath $candidateInstallerSidecar -Force -ErrorAction SilentlyContinue
    }
  }
  if ($updaterCacheDir -and (Test-Path -LiteralPath $updaterCacheDir)) {
    Assert-DescendantPath -Path $updaterCacheDir -Parent $env:LOCALAPPDATA -Purpose 'to clean the Windows update test cache'
    Remove-Item -LiteralPath $updaterCacheDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  foreach ($process in @($script:PostHogProcess, $script:DiagnosticsProcess)) {
    if ($process -and !$process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if ($previousInstallerSidecarExisted) {
    [System.IO.File]::WriteAllBytes($previousInstallerSidecar, $previousInstallerSidecarOriginal)
  } elseif (Test-Path -LiteralPath $previousInstallerSidecar) {
    Remove-Item -LiteralPath $previousInstallerSidecar -Force -ErrorAction SilentlyContinue
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
  if ($null -ne $previousBrokenUninstallerMarker) {
    $env:DNAFORGE_BROKEN_UNINSTALLER_MARKER = $previousBrokenUninstallerMarker
  } else {
    Remove-Item Env:DNAFORGE_BROKEN_UNINSTALLER_MARKER -ErrorAction SilentlyContinue
  }
}

exit 0
