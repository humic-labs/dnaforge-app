param(
  [Parameter(Mandatory = $true)][string]$PreviousInstallerPath,
  [Parameter(Mandatory = $true)][string]$PreviousVersion,
  [Parameter(Mandatory = $true)][string]$CandidateVersion,
  [Parameter(Mandatory = $true)][string]$ExpectedCandidateAsarSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedCandidateInstallerSha256,
  [Parameter(Mandatory = $true)][string]$PrimaryUpdateFeedBase,
  [Parameter(Mandatory = $true)][string]$FallbackUpdateFeedBase,
  [Parameter(Mandatory = $true)][ValidateSet('bootstrap', 'steady-state', 'production')][string]$CanaryMode,
  [string]$CandidateFallbackUpdateFeedBase = '',
  [string]$RolloutId = '',
  [string]$LogDir = '',
  [int]$UpdateDownloadTimeoutSeconds = 1200,
  [int]$InstallRelaunchTimeoutSeconds = 420,
  [switch]$PoisonLegacyUninstaller,
  [switch]$RestartThroughRenderer,
  [int]$RendererDebugPort = 9337
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Get-UpdaterCacheName {
  param([Parameter(Mandatory = $true)][string]$Path)
  $readYaml = @'
const fs = require('node:fs');
const { parseDocument } = require(process.argv[1]);
const doc = parseDocument(fs.readFileSync(process.argv[2], 'utf8'));
if (doc.errors.length) throw doc.errors[0];
const value = doc.get('updaterCacheDirName');
if (typeof value !== 'string' || !/^[A-Za-z0-9@._-]+$/.test(value) || value === '.' || value === '..') {
  throw new Error('Invalid updaterCacheDirName in installed app-update.yml');
}
process.stdout.write(value);
'@
  $value = & node -e $readYaml (Join-Path $script:RepoRoot 'scripts\vendor\database-recovery-yaml.cjs') $Path
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) { throw 'Could not read the installed updater cache directory.' }
  return $value
}

function Normalize-ProductVersion {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  $match = [regex]::Match($Value, '^(\d+\.\d+\.\d+)')
  if (!$match.Success) { return '' }
  return $match.Groups[1].Value
}

function Reset-OwnedUpdaterCache {
  param([string]$CacheRoot, [string]$OwnedCacheRoot)
  if ([string]::IsNullOrWhiteSpace($OwnedCacheRoot) -or
      ![System.IO.Path]::GetFullPath($CacheRoot).Equals([System.IO.Path]::GetFullPath($OwnedCacheRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to reset an updater cache without exact test ownership.'
  }
  if (!(Test-Path -LiteralPath $CacheRoot)) { return }
  $entries = @((Get-Item -LiteralPath $CacheRoot -Force)) + @(Get-ChildItem -LiteralPath $CacheRoot -Recurse -Force)
  if (@($entries | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }).Count) {
    throw 'Refusing to reset an updater cache containing a symbolic link or junction.'
  }
  Remove-Item -LiteralPath $CacheRoot -Recurse -Force
  if (Test-Path -LiteralPath $CacheRoot) { throw 'The owned updater cache was not cleared.' }
}

function Assert-DownloadedCandidateInstaller {
  param([string]$Label)
  $cachedInstaller = Get-ChildItem $script:OwnedUpdaterCacheRoot -Filter '*.exe' -File -Recurse | Where-Object {
    (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -eq $ExpectedCandidateInstallerSha256
  } | Select-Object -First 1
  if (!$cachedInstaller) { throw "$Label candidate installer exact SHA-256 was not found in updater cache." }
  Assert-HumicSignature -Path $cachedInstaller.FullName -Label "$Label candidate v$CandidateVersion installer"
}

function Get-ExecutableVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (!(Test-Path -LiteralPath $Path)) { return '' }
  return Normalize-ProductVersion ([System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion)
}

function Assert-HumicSignature {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
  Write-ProofLog "$Label Authenticode status=$($signature.Status) signer=$subject"
  if ($signature.Status -ne 'Valid') { throw "$Label signature is not valid: $($signature.Status)" }
  if ($subject -notlike '*Humic Labs Inc.*') { throw "$Label signer is not Humic Labs Inc.: $subject" }
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
    if (Test-Path -LiteralPath $exe) { return (Resolve-Path -LiteralPath $exe).Path }
  }
  return ''
}

function Write-ProofLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message
  Write-Host $line
  Add-Content -LiteralPath $script:ProofLog -Value $line -Encoding UTF8
}

function Test-LogMarker {
  param([Parameter(Mandatory = $true)][string]$Marker)
  foreach ($path in @($script:AppOutLog, $script:AppErrLog)) {
    if ((Test-Path -LiteralPath $path) -and (Select-String -LiteralPath $path -SimpleMatch $Marker -Quiet)) { return $true }
  }
  return $false
}

function Wait-ForLogMarker {
  param([Parameter(Mandatory = $true)][string]$Marker, [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-LogMarker $Marker) { Write-ProofLog "Observed app marker: $Marker"; return }
    if ($script:AppProcess) {
      $script:AppProcess.Refresh()
      if ($script:AppProcess.HasExited) { throw "App exited before marker: $Marker" }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for app marker: $Marker"
}

function Stop-ExactApp {
  if ($script:AppProcess) {
    $script:AppProcess.Refresh()
    if (!$script:AppProcess.HasExited) {
      [void]$script:AppProcess.CloseMainWindow()
      if (!$script:AppProcess.WaitForExit(30000)) { Stop-Process -Id $script:AppProcess.Id -Force }
    }
  }
  $script:AppProcess = $null
}

function Seed-Profile {
  param([Parameter(Mandatory = $true)][string]$Profile, [Parameter(Mandatory = $true)][ValidateSet('eligible', 'ineligible')][string]$Admission)
  New-Item -ItemType Directory -Force -Path $Profile | Out-Null
  node (Join-Path $script:RepoRoot 'scripts\telemetry-suppression-fence.mjs') create `
    --user-data-dir $Profile --reason packaged_update_test --lifetime-seconds 3600 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not seed telemetry suppression in $Profile" }
  if ($Admission -eq 'eligible') {
    [System.IO.File]::WriteAllText(
      (Join-Path $Profile 'update-acceptance-user-data-sentinel'),
      $script:UserDataSentinelValue,
      [System.Text.Encoding]::ASCII
    )
  }
  if ($CanaryMode -eq 'production') {
    if ($Admission -ne 'eligible') { throw 'Production acceptance has no synthetic ineligible profile.' }
    foreach ($name in @('.updaterId', 'install-id')) {
      if (Test-Path (Join-Path $Profile $name)) { throw "Production profile unexpectedly contains preseeded $name." }
    }
  } elseif ($CanaryMode -eq 'bootstrap') {
    $updaterId = if ($Admission -eq 'eligible') { '00000000-0000-5000-8000-000000000001' } else { '00000000-0000-5000-8000-0000ffffffff' }
    [System.IO.File]::WriteAllText((Join-Path $Profile '.updaterId'), $updaterId, [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText((Join-Path $Profile 'install-id'), $RolloutId, [System.Text.Encoding]::ASCII)
  } else {
    [System.IO.File]::WriteAllText((Join-Path $Profile '.updaterId'), '00000000-0000-5000-8000-0000ffffffff', [System.Text.Encoding]::ASCII)
    $installId = if ($Admission -eq 'eligible') { $RolloutId } else { "not-$RolloutId" }
    [System.IO.File]::WriteAllText((Join-Path $Profile 'install-id'), $installId, [System.Text.Encoding]::ASCII)
  }
}

function Assert-UserDataPreserved {
  param([Parameter(Mandatory = $true)][string]$Profile)
  $sentinel = Join-Path $Profile 'update-acceptance-user-data-sentinel'
  if (!(Test-Path -LiteralPath $sentinel) -or [System.IO.File]::ReadAllText($sentinel) -ne $script:UserDataSentinelValue) {
    throw 'Native replacement did not preserve the exact user-data sentinel.'
  }
  node --no-warnings (Join-Path $script:RepoRoot 'scripts\profile-preservation-sentinel.mjs') assert `
    (Join-Path $Profile 'dnaforge.db') $script:DatabaseSentinelKey $script:DatabaseSentinelValue
  if ($LASTEXITCODE -ne 0) { throw 'Native replacement did not preserve the predecessor database sentinel.' }
}

function Seed-DatabaseSentinel {
  param([Parameter(Mandatory = $true)][string]$Profile)
  node --no-warnings (Join-Path $script:RepoRoot 'scripts\profile-preservation-sentinel.mjs') seed `
    (Join-Path $Profile 'dnaforge.db') $script:DatabaseSentinelKey $script:DatabaseSentinelValue
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit the sentinel into the predecessor database.' }
}

function Test-LegacyUninstallEntry {
  param([AllowNull()][object]$Entry, [string]$Version, [string]$InstallDir)
  if (!$Entry) { return $false }
  $versionProperty = $Entry.PSObject.Properties['DisplayVersion']
  $commandProperty = $Entry.PSObject.Properties['UninstallString']
  return [bool](
    $versionProperty -and $commandProperty -and
    $versionProperty.Value -eq $Version -and
    $commandProperty.Value -and
    $commandProperty.Value.ToString().Contains($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)
  )
}

function Install-LegacyUninstallerPoison {
  if (!$PoisonLegacyUninstaller) { return }
  if ($PreviousVersion -ne '0.8.10') {
    throw 'The bounded legacy-uninstaller proof must use the signed v0.8.10 predecessor.'
  }

  $poisonPath = Join-Path $LogDir 'broken-predecessor-uninstaller.exe'
  if (!(Test-Path -LiteralPath $poisonPath)) {
    $poisonSource = @'
using System;
using System.IO;

public static class BrokenPredecessorUninstaller
{
    [STAThread]
    public static int Main(string[] args)
    {
        string marker = Environment.GetEnvironmentVariable("DNAFORGE_BROKEN_UNINSTALLER_MARKER");
        if (!String.IsNullOrWhiteSpace(marker))
        {
            File.AppendAllText(marker, DateTime.UtcNow.ToString("o") + Environment.NewLine);
        }
        return 2;
    }
}
'@
    $compileScript = @'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{0}'))) -OutputAssembly ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{1}'))) -OutputType ConsoleApplication
'@ -f [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($poisonSource)), [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($poisonPath))
    $encodedCompile = [System.Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($compileScript))
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoLogo -NoProfile -NonInteractive -EncodedCommand $encodedCompile
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $poisonPath)) {
      throw 'The bounded predecessor uninstaller fixture could not be compiled.'
    }
  }

  $probeMarker = Join-Path $LogDir 'broken-uninstaller-probe.log'
  if (Test-Path -LiteralPath $probeMarker) { Remove-Item -LiteralPath $probeMarker -Force }
  $priorMarker = [Environment]::GetEnvironmentVariable('DNAFORGE_BROKEN_UNINSTALLER_MARKER', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('DNAFORGE_BROKEN_UNINSTALLER_MARKER', $probeMarker, 'Process')
    $probe = Start-Process -FilePath $poisonPath -PassThru -Wait
  } finally {
    [Environment]::SetEnvironmentVariable('DNAFORGE_BROKEN_UNINSTALLER_MARKER', $priorMarker, 'Process')
  }
  if ($probe.ExitCode -ne 2 -or !(Test-Path -LiteralPath $probeMarker)) {
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
      if (Test-LegacyUninstallEntry -Entry $entry -Version $PreviousVersion -InstallDir $script:InstallDir) {
        $matches += $key
      }
    }
  }
  if ($matches.Count -eq 0) {
    throw "Could not find the registered v$PreviousVersion UninstallString for $script:InstallDir."
  }
  foreach ($key in $matches) {
    $replacement = '"{0}"' -f $poisonPath
    Set-ItemProperty -LiteralPath $key.PSPath -Name UninstallString -Value $replacement
    Set-ItemProperty -LiteralPath $key.PSPath -Name QuietUninstallString -Value $replacement
  }
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

function Request-UpdateInstall {
  param([Parameter(Mandatory = $true)][string]$Label)
  if ($RestartThroughRenderer) {
    $receipt = Join-Path $LogDir "$Label-restart-now.json"
    Write-ProofLog "Clicking the visible Restart now action through the packaged renderer ($Label)."
    & (Join-Path $PSScriptRoot 'click-windows-update-restart.ps1') `
      -Port $RendererDebugPort -Version $CandidateVersion -OutputPath $receipt
    if (!(Test-Path -LiteralPath $receipt)) { throw 'Restart now helper did not write its action receipt.' }
  } else {
    Write-ProofLog "Requesting normal app quit through CloseMainWindow ($Label)."
    if (!$script:AppProcess.CloseMainWindow()) { throw "$Label CloseMainWindow refused the normal quit path." }
  }
}

function Start-AppWithProfile {
  param([Parameter(Mandatory = $true)][string]$Profile, [Parameter(Mandatory = $true)][string]$Label, [string]$ResolverRules = '')
  $script:AppOutLog = Join-Path $LogDir "$Label.stdout.log"
  $script:AppErrLog = Join-Path $LogDir "$Label.stderr.log"
  foreach ($path in @($script:AppOutLog, $script:AppErrLog)) { if (Test-Path $path) { Remove-Item $path -Force } }
  $cleanEnvironment = @{}
  foreach ($name in @('SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $value) { $cleanEnvironment[$name] = $value }
  }
  $arguments = @('--enable-logging', ('--user-data-dir="{0}"' -f $Profile))
  if ($ResolverRules) { $arguments += ('--host-resolver-rules="{0}"' -f $ResolverRules) }
  if ($RestartThroughRenderer) { $arguments += "--remote-debugging-port=$RendererDebugPort" }
  if ($script:BrokenUninstallerMarker) {
    $cleanEnvironment['DNAFORGE_BROKEN_UNINSTALLER_MARKER'] = $script:BrokenUninstallerMarker
  }
  $script:AppProcess = Start-Process -FilePath $script:InstalledExe -ArgumentList $arguments `
    -UseNewEnvironment -Environment $cleanEnvironment -PassThru `
    -RedirectStandardOutput $script:AppOutLog -RedirectStandardError $script:AppErrLog
}

function Assert-AppBytesUnchanged {
  param([string]$ExpectedExe, [string]$ExpectedAsar, [string]$ExpectedConfig, [string]$Label)
  if ((Get-FileHash $script:InstalledExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedExe) { throw "$Label changed executable bytes" }
  if ((Get-FileHash $script:AppAsar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedAsar) { throw "$Label changed app.asar bytes" }
  if ((Get-FileHash $script:UpdateConfig -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedConfig) { throw "$Label changed app-update.yml bytes" }
  Assert-HumicSignature -Path $script:InstalledExe -Label $Label
}

function Block-PrimaryHostname {
  $hostName = ([uri]$PrimaryUpdateFeedBase).DnsSafeHost
  if ([string]::IsNullOrWhiteSpace($hostName)) { throw 'Primary update authority has no hostname.' }
  Add-Content -LiteralPath $script:HostsPath -Value "`n127.0.0.1 $hostName # $script:HostsMarker`n::1 $hostName # $script:HostsMarker" -Encoding ascii
  $script:PrimaryBlocked = $true
}

function Unblock-PrimaryHostname {
  if (!$script:PrimaryBlocked) { return }
  $lines = [System.IO.File]::ReadAllLines($script:HostsPath) | Where-Object { $_ -notlike "*$script:HostsMarker*" }
  [System.IO.File]::WriteAllLines($script:HostsPath, $lines, [System.Text.Encoding]::ASCII)
  $script:PrimaryBlocked = $false
}

function Assert-ExactRelaunchProcess {
  $match = Get-ExactMainProcess
  if (!$match) { throw "No relaunched main process executes the exact test install: $script:InstalledExe" }
  $script:AppProcess = Get-Process -Id $match.ProcessId -ErrorAction Stop
  Write-ProofLog "Exact candidate relaunch pid=$($match.ProcessId) executable=$($match.ExecutablePath)"
}

function Test-ExactMainProcess {
  param([AllowNull()][object]$Entry, [string]$Executable)
  if (!$Entry) { return $false }
  $path = $Entry.PSObject.Properties['ExecutablePath']
  $command = $Entry.PSObject.Properties['CommandLine']
  return [bool]($path -and $path.Value -and $command -and $command.Value -and
    [System.IO.Path]::GetFullPath($path.Value).Equals([System.IO.Path]::GetFullPath($Executable), [System.StringComparison]::OrdinalIgnoreCase) -and
    $command.Value -notmatch '(?:^|\s)--type(?:=|\s)')
}

function Get-ExactMainProcess {
  $matches = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    Test-ExactMainProcess -Entry $_ -Executable $script:InstalledExe
  })
  if ($matches.Count -gt 1) { throw 'More than one main process executes the owned installation.' }
  return $matches | Select-Object -First 1
}

function Wait-ForCandidateRelaunch {
  param([string]$BootLog, [long]$BootOffset, [string]$Label)
  $deadline = (Get-Date).AddSeconds($InstallRelaunchTimeoutSeconds)
  $readyPid = 0
  do {
    Assert-LegacyRescueState
    if ((Get-ExecutableVersion $script:InstalledExe) -eq $CandidateVersion -and (Test-Path -LiteralPath $BootLog)) {
      $main = Get-ExactMainProcess
      $live = if ($main) { '1' } else { '0' }
      $raw = node (Join-Path $script:RepoRoot 'scripts\startup-boot-oracle.mjs') $BootLog $BootOffset $CandidateVersion 1 $live win32
      if ($LASTEXITCODE -ne 0) { throw 'The candidate startup oracle failed.' }
      $oracle = $raw | ConvertFrom-Json
      Copy-Item -LiteralPath $BootLog -Destination (Join-Path $LogDir "$Label.main-boot.log") -Force
      if ($oracle.status -eq 'fatal') { throw "$Label candidate recorded a fatal startup failure." }
      if ($oracle.status -eq 'ready') {
        if ($readyPid -eq $main.ProcessId) {
          Assert-ExactRelaunchProcess
          Write-ProofLog "$Label candidate has one stable live main process and a fresh ready renderer."
          return
        }
        $readyPid = $main.ProcessId
      } else { $readyPid = 0 }
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  throw "$Label candidate did not establish a fresh stable renderer before the relaunch deadline."
}

function Get-InstalledFallbackFeedBase {
  $authority = @(& node (Join-Path $script:RepoRoot 'scripts\lib\patch-update-feed-base.mjs') sealed-authority $script:AppAsar 2 $PrimaryUpdateFeedBase)
  $status = $LASTEXITCODE
  if ($status -eq 3) { return $FallbackUpdateFeedBase }
  if ($status -ne 0 -or $authority.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$authority[0])) {
    throw 'Could not read the previous app compiled fallback update authority.'
  }
  return ([string]$authority[0]).Trim()
}

function Restore-PreviousPublicApp {
  Stop-ExactApp
  if ($script:InstallDir) {
    Invoke-CompletedSilentUninstall -InstallDirectory $script:InstallDir
    if (Test-Path $script:InstallDir) { Remove-Item $script:InstallDir -Recurse -Force }
  }
  $install = Start-Process -FilePath $script:PreviousInstaller -ArgumentList @('/S') -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Previous installer exited with $($install.ExitCode)" }
  $script:InstalledExe = Resolve-InstalledExecutable
  if (!$script:InstalledExe) { throw 'Installed DNAForge.exe was not found.' }
  $script:InstallDir = Split-Path -Parent $script:InstalledExe
  $script:AppAsar = Join-Path $script:InstallDir 'resources\app.asar'
  $script:UpdateConfig = Join-Path $script:InstallDir 'resources\app-update.yml'
  $script:UpdaterCacheName = Get-UpdaterCacheName -Path $script:UpdateConfig
  if ((Get-ExecutableVersion $script:InstalledExe) -ne $PreviousVersion) { throw 'Installed previous version mismatch.' }
  Assert-HumicSignature -Path $script:InstalledExe -Label "Restored previous v$PreviousVersion app"
}

function Invoke-CompletedSilentUninstall {
  param([Parameter(Mandatory = $true)][string]$InstallDirectory, [int]$TimeoutSeconds = 180)
  $uninstaller = Join-Path $InstallDirectory 'Uninstall DNAForge.exe'
  if (!(Test-Path -LiteralPath $uninstaller)) { throw 'The owned installation has no packaged uninstaller.' }
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$InstallDirectory") -PassThru
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force
    throw 'The owned uninstaller did not complete before its deadline.'
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "The owned uninstaller exited with $($process.ExitCode)." }
  if (Test-Path -LiteralPath (Join-Path $InstallDirectory 'DNAForge.exe')) {
    throw 'The installed executable remained after the owned uninstaller completed.'
  }
  Write-ProofLog 'The owned uninstaller completed in place and removed the installed executable.'
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This native replacement proof requires a disposable GitHub-hosted Windows runner.'
}
if (!$CandidateFallbackUpdateFeedBase) { $CandidateFallbackUpdateFeedBase = $FallbackUpdateFeedBase }
if (!$LogDir) { $LogDir = Join-Path $env:RUNNER_TEMP 'dnaforge-public-update-windows-x64' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:ProofLog = Join-Path $LogDir 'acceptance.log'
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$outage = node (Join-Path $script:RepoRoot 'scripts\update-acceptance-outage.mjs') $PreviousVersion $PrimaryUpdateFeedBase | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the declared predecessor outage.' }
$candidateConnectionRefusedVerified = 'false'
$fallbackPayloadFresh = 'false'
$script:HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$script:HostsMarker = "DNAFORGE_UPDATE_ACCEPTANCE_$($env:GITHUB_RUN_ID)_windows_x64"
$script:PrimaryBlocked = $false
$script:AppProcess = $null
$script:InstalledExe = ''
$script:AppAsar = ''
$script:UpdateConfig = ''
$script:InstallDir = ''
$script:PreviousInstaller = ''
$script:OwnedUpdaterCacheRoot = ''
$script:BrokenUninstallerMarker = ''
$script:LegacyInstallSentinel = ''
$script:UserDataSentinelValue = "update-acceptance-$($env:SOURCE_SHA)-windows-x64"
$script:DatabaseSentinelKey = 'release.acceptance.native-update'
$script:DatabaseSentinelValue = "native-update-database-sentinel-$PreviousVersion-to-$CandidateVersion-windows-x64"
$canonicalUserData = Join-Path $env:APPDATA 'DNAForge'
$ineligibleProfile = Join-Path $env:RUNNER_TEMP 'dnaforge-profile-ineligible'
$primaryProfile = Join-Path $env:RUNNER_TEMP 'dnaforge-profile-primary'
$fallbackProfile = Join-Path $env:RUNNER_TEMP 'dnaforge-profile-fallback'
$installDir = ''

try {
  if ($PreviousVersion -eq $CandidateVersion) { throw 'PreviousVersion and CandidateVersion must differ.' }
  if ($CanaryMode -ne 'production' -and [string]::IsNullOrWhiteSpace($RolloutId)) {
    throw 'RolloutId is required for canary acceptance.'
  }
  foreach ($digest in @($ExpectedCandidateAsarSha256, $ExpectedCandidateInstallerSha256)) {
    if ($digest -notmatch '^[0-9a-f]{64}$') { throw "Malformed expected SHA-256: $digest" }
  }
  foreach ($path in @($canonicalUserData, $ineligibleProfile, $primaryProfile, $fallbackProfile)) {
    if (Test-Path $path) { throw "Refusing pre-existing update acceptance profile: $path" }
  }
  foreach ($candidate in (Get-DefaultInstallCandidates)) {
    if (Test-Path (Join-Path $candidate 'DNAForge.exe')) { throw "Refusing pre-existing DNAForge install: $candidate" }
  }
  $script:PreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
  Assert-HumicSignature -Path $script:PreviousInstaller -Label "Previous v$PreviousVersion installer"
  Write-ProofLog 'Installing the exact immediately previous public signed installer.'
  Restore-PreviousPublicApp
  $installDir = $script:InstallDir
  $previousFallbackUpdateFeedBase = Get-InstalledFallbackFeedBase
  Write-ProofLog "Previous app fallback authority: $previousFallbackUpdateFeedBase"
  Write-ProofLog "Candidate fallback authority: $CandidateFallbackUpdateFeedBase"
  $cacheRoot = Join-Path $env:LOCALAPPDATA $script:UpdaterCacheName
  if (Test-Path -LiteralPath $cacheRoot) {
    node (Join-Path $script:RepoRoot 'scripts\verify-windows-installer-cache-baseline.mjs') `
      --cache-directory $cacheRoot --expected-installer $script:PreviousInstaller
    if ($LASTEXITCODE -ne 0) { throw 'Refusing an unowned pre-existing updater cache.' }
  }
  $script:OwnedUpdaterCacheRoot = [System.IO.Path]::GetFullPath($cacheRoot)
  Install-LegacyUninstallerPoison

  $previousExeHash = (Get-FileHash $script:InstalledExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $previousAsarHash = (Get-FileHash $script:AppAsar -Algorithm SHA256).Hash.ToLowerInvariant()
  $previousConfigHash = (Get-FileHash $script:UpdateConfig -Algorithm SHA256).Hash.ToLowerInvariant()

  if ($CanaryMode -ne 'production') {
    Seed-Profile -Profile $ineligibleProfile -Admission ineligible
    Start-AppWithProfile -Profile $ineligibleProfile -Label 'ineligible'
    if ($CanaryMode -eq 'bootstrap') {
      Wait-ForLogMarker -Marker "[AutoUpdater] Feed (generic): $($FallbackUpdateFeedBase.TrimEnd('/'))/updates/stable/x64" -TimeoutSeconds 150
      Wait-ForLogMarker -Marker 'Staging percentage: 0.01' -TimeoutSeconds 150
    } else {
      Wait-ForLogMarker -Marker "[AutoUpdater] Feed 1/2: $($PrimaryUpdateFeedBase.TrimEnd('/'))/updates/stable/x64" -TimeoutSeconds 150
      Wait-ForLogMarker -Marker 'Exact CI rollout profile rejected: profile-mismatch.' -TimeoutSeconds 150
    }
    Wait-ForLogMarker -Marker "Update for version $PreviousVersion is not available" -TimeoutSeconds 150
    Stop-ExactApp
    Assert-AppBytesUnchanged -ExpectedExe $previousExeHash -ExpectedAsar $previousAsarHash -ExpectedConfig $previousConfigHash -Label 'ineligible public check'
  }

  Seed-Profile -Profile $canonicalUserData -Admission eligible
  Start-AppWithProfile -Profile $canonicalUserData -Label 'eligible-update'
  if ($CanaryMode -eq 'production') {
    Wait-ForLogMarker -Marker "[AutoUpdater] Feed 1/2: $($PrimaryUpdateFeedBase.TrimEnd('/'))/updates/stable/x64" -TimeoutSeconds 150
  } elseif ($CanaryMode -eq 'bootstrap') {
    Wait-ForLogMarker -Marker "[AutoUpdater] Feed (generic): $($FallbackUpdateFeedBase.TrimEnd('/'))/updates/stable/x64" -TimeoutSeconds 150
    Wait-ForLogMarker -Marker 'Staging percentage: 0.01' -TimeoutSeconds 150
  } else {
    Wait-ForLogMarker -Marker "[AutoUpdater] Feed 1/2: $($PrimaryUpdateFeedBase.TrimEnd('/'))/updates/stable/x64" -TimeoutSeconds 150
    Wait-ForLogMarker -Marker 'Exact CI rollout profile admitted.' -TimeoutSeconds 150
  }
  Wait-ForLogMarker -Marker "[AutoUpdater] Update available: $CandidateVersion" -TimeoutSeconds 150
  Wait-ForLogMarker -Marker "[AutoUpdater] Update downloaded: $CandidateVersion" -TimeoutSeconds $UpdateDownloadTimeoutSeconds
  Assert-AppBytesUnchanged -ExpectedExe $previousExeHash -ExpectedAsar $previousAsarHash -ExpectedConfig $previousConfigHash -Label 'eligible pre-install download'

  Assert-DownloadedCandidateInstaller -Label 'Primary downloaded'
  Seed-DatabaseSentinel -Profile $canonicalUserData

  $bootLog = Join-Path $canonicalUserData 'logs\main-boot.log'
  $bootOffset = if (Test-Path $bootLog) { (Get-Item $bootLog).Length } else { 0 }
  Request-UpdateInstall -Label 'primary'
  if (!$script:AppProcess.WaitForExit(180000)) { throw 'Previous app did not exit for install.' }
  $script:AppProcess = $null

  Wait-ForCandidateRelaunch -BootLog $bootLog -BootOffset $bootOffset -Label 'primary'
  Assert-UserDataPreserved -Profile $canonicalUserData
  Assert-LegacyRescueState -RequireSentinelRemoved
  if ((Get-FileHash $script:AppAsar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedCandidateAsarSha256) { throw 'Installed candidate ASAR differs from retained source artifact.' }
  Assert-HumicSignature -Path $script:InstalledExe -Label "Relaunched candidate v$CandidateVersion app"
  Stop-ExactApp

  $candidateAsarHash = (Get-FileHash $script:AppAsar -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($CanaryMode -ne 'bootstrap') {
    Restore-PreviousPublicApp
    $installDir = $script:InstallDir
    Reset-OwnedUpdaterCache -CacheRoot (Join-Path $env:LOCALAPPDATA $script:UpdaterCacheName) -OwnedCacheRoot $script:OwnedUpdaterCacheRoot
    Write-ProofLog 'Cleared the exact test-owned updater cache before the fallback download.'
    Install-LegacyUninstallerPoison
    Assert-AppBytesUnchanged -ExpectedExe $previousExeHash -ExpectedAsar $previousAsarHash -ExpectedConfig $previousConfigHash -Label 'restored previous app before fallback'
    if (Test-Path $canonicalUserData) { Remove-Item $canonicalUserData -Recurse -Force }
    Seed-Profile -Profile $canonicalUserData -Admission eligible
    Block-PrimaryHostname
    Write-ProofLog "Declared predecessor fallback outage: $($outage.name) ($($outage.expectedError))"
    Start-AppWithProfile -Profile $canonicalUserData -Label 'fallback-update' -ResolverRules $outage.resolverRules
    Wait-ForLogMarker -Marker '[AutoUpdater] Feed 1/2:' -TimeoutSeconds 150
    Wait-ForLogMarker -Marker $outage.expectedError -TimeoutSeconds 150
    Wait-ForLogMarker -Marker '[AutoUpdater] Authority 1 failed; trying 2/2' -TimeoutSeconds 150
    Wait-ForLogMarker -Marker "[AutoUpdater] Feed 2/2: $($previousFallbackUpdateFeedBase.TrimEnd('/'))/updates/stable/x64" -TimeoutSeconds 150
    if ($CanaryMode -eq 'steady-state') {
      Wait-ForLogMarker -Marker 'Exact CI rollout profile admitted.' -TimeoutSeconds 150
    }
    Wait-ForLogMarker -Marker "[AutoUpdater] Update downloaded: $CandidateVersion" -TimeoutSeconds $UpdateDownloadTimeoutSeconds
    if (Test-LogMarker 'Update has already been downloaded') { throw 'Fallback reused a cached payload instead of downloading from the fallback authority.' }
    Assert-DownloadedCandidateInstaller -Label 'Fresh fallback downloaded'
    $fallbackPayloadFresh = 'true'
    Seed-DatabaseSentinel -Profile $canonicalUserData
    Assert-AppBytesUnchanged -ExpectedExe $previousExeHash -ExpectedAsar $previousAsarHash -ExpectedConfig $previousConfigHash -Label 'fallback pre-install download'
    $bootLog = Join-Path $canonicalUserData 'logs\main-boot.log'
    $bootOffset = if (Test-Path $bootLog) { (Get-Item $bootLog).Length } else { 0 }
    Request-UpdateInstall -Label 'fallback'
    if (!$script:AppProcess.WaitForExit(180000)) { throw 'Fallback previous app did not exit for install.' }
    $script:AppProcess = $null
    Wait-ForCandidateRelaunch -BootLog $bootLog -BootOffset $bootOffset -Label 'fallback'
    Assert-UserDataPreserved -Profile $canonicalUserData
    Assert-LegacyRescueState -RequireSentinelRemoved
    if ((Get-FileHash $script:AppAsar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedCandidateAsarSha256) { throw 'Fallback candidate ASAR differs from retained source artifact.' }
    Assert-HumicSignature -Path $script:InstalledExe -Label "Fallback relaunched candidate v$CandidateVersion app"
    Stop-ExactApp
    Start-AppWithProfile -Profile $canonicalUserData -Label 'candidate-connection-refused'
    Wait-ForLogMarker -Marker 'net::ERR_CONNECTION_REFUSED' -TimeoutSeconds 150
    Wait-ForLogMarker -Marker '[AutoUpdater] Authority 1 failed; trying 2/2' -TimeoutSeconds 150
    Wait-ForLogMarker -Marker "[AutoUpdater] Feed 2/2: $($CandidateFallbackUpdateFeedBase.TrimEnd('/'))/updates/stable/x64" -TimeoutSeconds 150
    Wait-ForLogMarker -Marker "Update for version $CandidateVersion is not available (latest version: $CandidateVersion," -TimeoutSeconds 150
    if (Test-LogMarker '[AutoUpdater] Check failed:') { throw 'Candidate fallback ended in a terminal check error.' }
    Assert-UserDataPreserved -Profile $canonicalUserData
    $candidateConnectionRefusedVerified = 'true'
    Unblock-PrimaryHostname
    $candidateAsarHash = (Get-FileHash $script:AppAsar -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  @(
    "source_run_id=$env:SOURCE_RUN_ID", "source_attempt_id=$env:SOURCE_ATTEMPT_ID", "source_sha=$env:SOURCE_SHA", "tag=v$CandidateVersion",
    "previous_version=$PreviousVersion", "candidate_version=$CandidateVersion", 'platform=win32', 'arch=x64',
    "acceptance_mode=$CanaryMode", 'user_data_preserved=true', 'database_preserved=true', 'renderer_ready=true',
    "fallback_fault=$($outage.name)", "candidate_connection_refused_verified=$candidateConnectionRefusedVerified",
    "fallback_payload_fresh=$fallbackPayloadFresh",
    "candidate_app_asar_sha256=$candidateAsarHash", "candidate_installer_sha256=$ExpectedCandidateInstallerSha256",
    "legacy_rescue=$($PoisonLegacyUninstaller.IsPresent.ToString().ToLowerInvariant())",
    'legacy_uninstaller_invoked=false',
    "legacy_install_sentinel_removed=$($PoisonLegacyUninstaller.IsPresent.ToString().ToLowerInvariant())",
    "restart_action=$(if ($RestartThroughRenderer) { 'renderer' } else { 'window-close' })"
  ) | Set-Content -LiteralPath (Join-Path $LogDir 'acceptance-identity.txt') -Encoding ascii
  if ($CanaryMode -eq 'production') {
    Write-ProofLog "PASS: ordinary untouched public v$PreviousVersion profile updated to v$CandidateVersion through final production primary and fallback feeds (windows x64)"
  } elseif ($CanaryMode -eq 'bootstrap') {
    Write-ProofLog "PASS: untouched public v$PreviousVersion updated to v$CandidateVersion through the bootstrap R2 feed (windows x64)"
  } else {
    Write-ProofLog "PASS: untouched public v$PreviousVersion updated to v$CandidateVersion; primary and Feed 2/2 fallback passed (windows x64)"
  }
} finally {
  foreach ($entry in @(
    @{ Source = (Join-Path $canonicalUserData 'logs\main-boot.log'); Name = 'last.main-boot.log' },
    @{ Source = (Join-Path $env:LOCALAPPDATA 'DNAForge\logs\install.log'); Name = 'native-install.log' }
  )) {
    if (Test-Path -LiteralPath $entry.Source) { Copy-Item -LiteralPath $entry.Source -Destination (Join-Path $LogDir $entry.Name) -Force }
  }
  Stop-ExactApp
  Unblock-PrimaryHostname
  if ($installDir) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like "$installDir*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $uninstaller = Join-Path $installDir 'Uninstall DNAForge.exe'
    if (Test-Path $uninstaller) { Start-Process $uninstaller -ArgumentList @('/S') -Wait | Out-Null }
  }
  foreach ($path in @($canonicalUserData, $ineligibleProfile, $primaryProfile, $fallbackProfile)) {
    if (Test-Path $path) { Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
