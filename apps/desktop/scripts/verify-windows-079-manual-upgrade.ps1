param(
  [Parameter(Mandatory)][string]$Original079,
  [Parameter(Mandatory)][string]$Original097,
  [Parameter(Mandatory)][string]$Fixed097,
  [Parameter(Mandatory)][string]$CandidateBuildReceipt,
  [Parameter(Mandatory)][string]$EvidenceDir
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This destructive reset proof requires a disposable GitHub Actions Windows runner.' }
$EvidenceDir = [IO.Path]::GetFullPath($EvidenceDir)
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$root = Join-Path $env:RUNNER_TEMP 'fixture-manual-upgrade'
$install = Join-Path $root 'a real user selected installation directory with a longer path\DNAForge'
$profile = Join-Path $root 'profile'
$workspace = Join-Path $env:USERPROFILE 'Documents\fixture-manual-upgrade-workspace'
$uiScript = Join-Path $PSScriptRoot 'prove-windows-manual-upgrade-ui.cjs'
$receipt = [ordered]@{ sourceSha=$env:GITHUB_SHA; windowsVersion=[Environment]::OSVersion.VersionString; originalUninstallerModified=$false; manualArgumentsHaveUpdatedMarker=$false; installDir=$install; workspace=$workspace; phases=@() }
function Save-Receipt { $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $EvidenceDir 'journey-receipt.json') }
function File-Hash([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
foreach ($pair in @(@($Original079,'2839aff012e01bfdedeb7149eedd0bd727105a8647314bea9610caf7c8dfe6b0'),@($Original097,'4f8673cad447590545d963365f8a3cb45d3467078f92e748734715938b401122'))) {

  if ((File-Hash $pair[0]) -ne $pair[1]) { throw "Original release digest mismatch: $($pair[0])" }
}
foreach ($file in @($Original079,$Original097,$Fixed097)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Humic Labs Inc.*') { throw "Invalid signed installer: $file ($($signature.Status))" }
}
$receipt.original079Sha256 = File-Hash $Original079
$receipt.original097Sha256 = File-Hash $Original097
$receipt.fixed097Sha256 = File-Hash $Fixed097
$buildReceipt = Get-Content -LiteralPath $CandidateBuildReceipt -Raw | ConvertFrom-Json
if (!$buildReceipt.signed -or $receipt.fixed097Sha256 -ne $buildReceipt.candidateInstallerSha256) { throw 'Fixed installer does not match its signed build receipt' }
$receipt.candidateBuildSourceSha = $buildReceipt.sourceSha




Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class InstallerDialog3100 {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode)] static extern IntPtr GetControlText(IntPtr hwnd, uint message, IntPtr size, StringBuilder text, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)] static extern IntPtr SendWindowMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  static string Text(IntPtr hwnd) {
    var text=new StringBuilder(4096); IntPtr copied;
    GetControlText(hwnd,0x000D,(IntPtr)text.Capacity,text,2,250,out copied);
    return text.ToString();
  }
  public static string Snapshot(uint ownedPid) {
    var result=new StringBuilder();
    EnumWindows((window,arg) => {
      uint pid; GetWindowThreadProcessId(window,out pid); if(pid != ownedPid) return true;
      result.AppendLine("WINDOW " + window + " " + Text(window));
      EnumChildWindows(window,(child,unused) => { result.AppendLine("CONTROL " + child + " id=" + GetDlgCtrlID(child) + " " + Text(child)); return true; },IntPtr.Zero);
      return true;
    },IntPtr.Zero);
    return result.ToString();
  }
  public static string DismissFailure(uint ownedPid) {
    string result = null;
    EnumWindows((window,arg) => {
      uint pid; GetWindowThreadProcessId(window, out pid); if(pid != ownedPid) return true;
      var text = new StringBuilder();
      IntPtr ok = IntPtr.Zero;
      // GetWindowText cannot reliably read another process's control text.
      EnumChildWindows(window, (child,unused) => { var label=Text(child); text.AppendLine(label); if(label.Trim() == "OK") ok=child; return true; }, IntPtr.Zero);
      if(text.ToString().IndexOf("Failed to uninstall old application files",StringComparison.OrdinalIgnoreCase) >= 0) {
        result=text.ToString(); IntPtr ignored;
        if(ok != IntPtr.Zero) SendWindowMessage(ok,0x00F5,IntPtr.Zero,IntPtr.Zero,2,1000,out ignored);
        // A MessageBox with only OK also permits the ordinary Close action.
        SendWindowMessage(window,0x0010,IntPtr.Zero,IntPtr.Zero,2,1000,out ignored);
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
function Install([string]$installer,[string]$phase) {
  $arguments = "/S /currentuser /D=$install"
  if ($arguments -match '--updated') { throw 'Manual proof must not use updater arguments' }
  $eventId = "fixture-$phase"
  Register-CimIndicationEvent -Query "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName='old-uninstaller.exe'" -SourceIdentifier $eventId | Out-Null
  $p = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddMinutes(5)
  $dialogs = @()
  while (!$p.HasExited -and (Get-Date) -lt $deadline) {
    $message = [InstallerDialog3100]::DismissFailure([uint32]$p.Id)
    if ($message -and $dialogs -notcontains $message) { $dialogs += $message }
    Start-Sleep -Milliseconds 250
    $p.Refresh()
  }
  $timedOut = !$p.HasExited
  if ($timedOut) {
    [InstallerDialog3100]::Snapshot([uint32]$p.Id) | Set-Content -LiteralPath (Join-Path $EvidenceDir "$phase-windows.txt")
    Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $p.Id -or $_.ParentProcessId -eq $p.Id } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDir "$phase-processes.json")
    Stop-Process -Id $p.Id -Force
  }
  $p.WaitForExit()
  Start-Sleep -Seconds 1
  $legacyStarts = @(Get-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue)
  Unregister-Event -SourceIdentifier $eventId
  $legacyStarts | ForEach-Object { Remove-Event -EventIdentifier $_.EventIdentifier }
  $result = [ordered]@{phase=$phase;arguments=$arguments;exitCode=$p.ExitCode;timedOut=$timedOut;failureDialogs=$dialogs;legacyUninstallerStarts=$legacyStarts.Count}
  $receipt.phases += $result
  Save-Receipt
  $result | ConvertTo-Json -Depth 4 | Write-Host
  if ($timedOut) { throw "Installer timed out: $phase" }
  return $result
}
function Registration {
  $rows = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -match '^DNAForge(?:\s+\d+\.\d+\.\d+)?$' })
  if ($rows.Count -ne 1) { throw "Expected one DNAForge registration, got $($rows.Count)" }
  $row = $rows[0]
  $installKey = "HKCU:\Software\$($row.PSChildName)"
  $location = (Get-ItemProperty -LiteralPath $installKey).InstallLocation
  if ($location -ne $install) { throw "Wrong registered installation: $location" }
  return [ordered]@{ version=$row.DisplayVersion; installLocation=$location; uninstallString=$row.UninstallString; uninstallKey=$row.PSPath; installKey=$installKey }
}
function Open-Sequence([string]$phase,[string]$version) {
  Write-Host "Opening installed $version through Files: $phase"
  & node $uiScript (Join-Path $install 'DNAForge.exe') $profile $workspace (Join-Path $EvidenceDir $phase) $version
  if ($LASTEXITCODE -ne 0) { throw "Packaged sequence journey failed: $phase" }
}
function Reset-Proof {
  $absoluteRoot = [IO.Path]::GetFullPath($root)
  if (!$absoluteRoot.StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Reset escaped runner temporary directory' }
  if (Test-Path -LiteralPath $install) {
    $registration = Registration
    if ($registration.installLocation -ne $install) { throw 'Cannot reset another installation' }
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($install + '\',[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $registration.uninstallKey -Recurse -Force
    Remove-Item -LiteralPath $registration.installKey -Recurse -Force
  }
  if (Test-Path -LiteralPath $absoluteRoot) { Remove-Item -LiteralPath $absoluteRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $workspace | Out-Null
  Set-Content -LiteralPath (Join-Path $workspace 'manual-upgrade-sequence.fasta') -Value ">User-created sequence retained across manual replacement`nATGCGTACGTTAGCTAGCTAGCGATCGATCGATGCTAGCTAGCTGATCGATCGTACGATCGATCGTAGCTAGCTAGCTGATCGATCGATGCTAGCTAGCTAGCATCGATCGATGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG" -Encoding utf8
  & git -C $workspace init -q
}
try {
  if (Test-Path -LiteralPath $workspace) { throw 'Runner already contains the proof workspace; refusing to overwrite user files' }
  if (@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -match '^DNAForge(?:\s+\d+\.\d+\.\d+)?$' }).Count -ne 0) { throw 'Runner already contains DNAForge; refusing proof' }


  $longInstall = $install
  $install = Join-Path $root 'short-DNAForge'
  Reset-Proof
  if ((Install $Original079 'control-short-fresh-079').exitCode -ne 0) { throw 'Short-path control fresh installation failed' }
  Open-Sequence 'control-short-079-open' '0.7.9'
  $shortAttempt = Install $Original097 'control-short-original-manual-079-to-097'
  if ($shortAttempt.exitCode -ne 0 -or $shortAttempt.legacyUninstallerStarts -ne 1 -or (Registration).version -ne '0.9.7') { throw 'Short-path original manual control did not succeed' }
  Open-Sequence 'control-short-original-097-open' '0.9.7'
  $receipt.originalShortPathManualControlPassed = $true
  Reset-Proof
  $install = $longInstall
  Reset-Proof
  if ((Install $Original079 'original-fresh-079').exitCode -ne 0) { throw 'Original fresh install failed' }
  $receipt.originalRegistration = Registration
  if ($receipt.originalRegistration.version -ne '0.7.9') { throw 'Original 0.7.9 not installed' }
  $oldUninstaller = Join-Path $install 'Uninstall DNAForge.exe'
  $receipt.originalUninstallerSha256 = File-Hash $oldUninstaller
  $receipt.longestOriginalPayloadPath = (Get-ChildItem -LiteralPath $install -Recurse -File | Sort-Object { $_.FullName.Length } -Descending | Select-Object -First 1).FullName
  Open-Sequence 'original-079-open' '0.7.9'
  $workspaceHash = File-Hash (Join-Path $workspace 'manual-upgrade-sequence.fasta')
  $oldAsarHash = File-Hash (Join-Path $install 'resources\app.asar')
  $originalAttempt = Install $Original097 'original-manual-079-to-097'
  if ($originalAttempt.exitCode -ne 2 -or $originalAttempt.failureDialogs.Count -eq 0 -or $originalAttempt.legacyUninstallerStarts -ne 5) { throw 'Exact original failure was not reproduced; do not claim it was' }
  if ((Registration).version -ne '0.7.9' -or (File-Hash (Join-Path $install 'resources\app.asar')) -ne $oldAsarHash -or (File-Hash $oldUninstaller) -ne $receipt.originalUninstallerSha256) { throw 'Original failed upgrade did not retain untouched 0.7.9' }
  Open-Sequence 'original-079-still-opens-after-failure' '0.7.9'
  $receipt.originalFailureReproduced = $true

  Reset-Proof
  if ((Install $Original079 'reset-fresh-079').exitCode -ne 0) { throw 'Fresh reset installation failed' }
  Open-Sequence 'reset-079-open' '0.7.9'
  $before = Registration
  $sentinel = Join-Path $install 'legacy-only-obsolete-sentinel.txt'
  Set-Content -LiteralPath $sentinel -Value 'Old tree must be removed, not overlaid'
  $dataSentinel = Join-Path $profile 'user-data-survives.txt'
  Set-Content -LiteralPath $dataSentinel -Value 'Persistent user profile'
  if ((File-Hash $oldUninstaller) -ne $receipt.originalUninstallerSha256) { throw 'Reset did not use the exact original uninstaller' }
  $fixedAttempt = Install $Fixed097 'fixed-manual-079-to-097'
  if ($fixedAttempt.exitCode -ne 0 -or $fixedAttempt.legacyUninstallerStarts -ne 0) { throw 'Fixed manual replacement failed or ran the old uninstaller' }
  if ((Registration).version -ne '0.9.7') { throw 'Replacement registration is not 0.9.7' }
  if ((File-Hash (Join-Path $install 'resources\app.asar')) -ne $buildReceipt.originalAppAsarSha256) { throw 'Installed candidate is not the exact qualified full app payload' }
  if (Test-Path -LiteralPath $sentinel) { throw 'Fixed candidate left obsolete files' }
  if (!(Test-Path -LiteralPath $dataSentinel) -or (File-Hash (Join-Path $workspace 'manual-upgrade-sequence.fasta')) -ne $workspaceHash) { throw 'User data changed during replacement' }
  Open-Sequence 'fixed-097-open-preserved-sequence' '0.9.7'
  Open-Sequence 'fixed-097-second-launch' '0.9.7'
  $receipt.fixedManualReplacementPassed = $true
  $receipt.sameProfileReopened = $true
  $receipt.sequenceBytesPreserved = $true
  $receipt.obsoleteTreeRemoved = $true
  Reset-Proof
  New-Item -ItemType Directory -Force -Path $install | Out-Null
  $unregisteredFile = Join-Path $install 'unregistered-user-file.txt'
  Set-Content -LiteralPath $unregisteredFile -Value 'A selected directory is not proof of a previous installation'
  $freshAttempt = Install $Fixed097 'fixed-fresh-unregistered-directory'
  if ($freshAttempt.exitCode -ne 0 -or $freshAttempt.legacyUninstallerStarts -ne 0 -or !(Test-Path -LiteralPath $unregisteredFile)) { throw 'Fresh install moved or deleted an unregistered directory' }
  Open-Sequence 'fixed-fresh-097-open' '0.9.7'
  $receipt.freshInstallPreservesUnregisteredFiles = $true
  $previousLocation = $install
  $install = Join-Path $root 'relocated-DNAForge'
  $relocatedAttempt = Install $Fixed097 'fixed-explicit-different-directory'
  if ($relocatedAttempt.exitCode -ne 0 -or $relocatedAttempt.legacyUninstallerStarts -ne 1 -or (Registration).version -ne '0.9.7') { throw 'Explicit relocation did not retain the ordinary uninstall/install path' }
  Open-Sequence 'fixed-relocated-097-open' '0.9.7'
  $receipt.explicitRelocationPassed = $true
  $receipt.result = 'PASS'
  Save-Receipt
} finally {
  Save-Receipt
  $receipt | ConvertTo-Json -Depth 8 | Write-Host
  Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=(Get-Date).AddHours(-1)} -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -like '*DNAForge*' } |
    Select-Object TimeCreated,Message | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $EvidenceDir 'windows-application-errors.json')
  foreach ($file in @((Join-Path $env:LOCALAPPDATA 'DNAForge\logs\install.log'),(Join-Path (Split-Path $Original079) 'dnaforge-install.log'),(Join-Path (Split-Path $Fixed097) 'dnaforge-install.log'))) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $EvidenceDir (([IO.Path]::GetFileName((Split-Path $file))) + '-' + [IO.Path]::GetFileName($file))) -Force }
  }
}
