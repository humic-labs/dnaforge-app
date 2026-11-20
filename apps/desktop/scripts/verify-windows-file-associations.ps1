param(
  [Parameter(Mandatory = $true)][string] $InstalledExe,
  [Parameter(Mandatory = $true)][string] $GenBankFile,
  [Parameter(Mandatory = $true)][string] $ReportPath
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Find-SettingsControl([string]$Label, [bool]$Exact = $false) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $settings = Get-Process -Name SystemSettings -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
    if ($settings) {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($settings.MainWindowHandle)
      $controls = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($control in $controls) {
        $name = $control.Current.Name
        if ($control.Current.IsOffscreen -or !$control.Current.IsEnabled -or !$name) { continue }
        $match = if ($Exact) { $name -eq $Label } else { $name -match ('(^|[^a-z0-9])' + [regex]::Escape($Label) + '($|[^a-z0-9])') }
        if (!$match) { continue }
        foreach ($pattern in @([System.Windows.Automation.InvokePattern]::Pattern,
            [System.Windows.Automation.SelectionItemPattern]::Pattern)) {
          $action = $null
          if ($control.TryGetCurrentPattern($pattern, [ref]$action)) {
            if ($pattern -eq [System.Windows.Automation.InvokePattern]::Pattern) { $action.Invoke() }
            else { $action.Select() }
            return
          }
        }
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Could not select '$Label' in Windows Default Apps."
}
$sandbox = $env:USERNAME -eq 'WDAGUtilityAccount' -and (Test-Path 'C:\Users\WDAGUtilityAccount')
$hostedRunner = $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted'
if ($env:OS -ne 'Windows_NT' -or !($sandbox -or $hostedRunner)) {
  throw 'This proof needs a disposable Windows Sandbox or hosted Windows runner with an English desktop.'
}
$exe = (Resolve-Path -LiteralPath $InstalledExe).ProviderPath
$extension = [IO.Path]::GetExtension($GenBankFile).TrimStart('.').ToLowerInvariant()
if ($extension -notin @('gb','gbk','gbff','genbank')) { throw 'Supply a GenBank document.' }
$script = Join-Path (Split-Path $exe) 'resources\query-windows-associations.ps1'
if (!(Test-Path -LiteralPath $script)) { throw 'Install the candidate in this sandbox first.' }
$extensions = @('gb', 'gbk', 'gbff', 'genbank')
$all = $extensions + @('dna')
function Read-Handlers {
  $reader = Get-Content -Raw -Encoding UTF8 -LiteralPath $script
  $command = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()`n& {`n$reader`n} -Extensions '$($all -join ',')'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $result = & powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded
  if ($LASTEXITCODE -ne 0) { throw 'Effective shell query failed.' }
  return $result | ConvertFrom-Json
}
function App-Processes {
  return @(Get-Process DNAForge -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $exe -and $_.SessionId -eq (Get-Process -Id $PID).SessionId })
}
function Select-Default([string]$suffix, [string]$name, [bool]$cancel) {
  Start-Process 'ms-settings:defaultapps?registeredAppUser=DNAForge'
  Find-SettingsControl ".$suffix"
  Find-SettingsControl $name $true
  if ($cancel) { Find-SettingsControl 'Cancel' $true }
  else { Find-SettingsControl 'Set default' $true }
}
function Wait-ForDefault([string]$suffix, [string]$expected) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $value = (Read-Handlers).$suffix
    if ($value.progId -eq $expected) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Windows reported '$($value.progId)' for .$suffix; expected '$expected'."
}
if (Test-Path -LiteralPath $ReportPath) { throw 'Supply a new report path.' }
if (@(App-Processes).Count -ne 0) { throw 'Close the installed candidate before the cold-launch proof.' }
$before = Read-Handlers
foreach ($suffix in $extensions) {
  if (!$before.$suffix.progId -or $before.$suffix.progId -eq 'DNAForge.GenBank') {
    throw "Select an alternate application for .$suffix in the disposable profile first."
  }
}
$hash = (Get-FileHash $GenBankFile -Algorithm SHA256).Hash
$profileRoot = Join-Path $env:APPDATA 'DNAForge\quick-look-packages'
$run = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("file-open-" + [guid]::NewGuid()))
$report = [ordered]@{application=$exe; before=$before; opens=@(); cancel='not exercised'; restored=$false}
try {
  Select-Default 'gb' 'DNAForge' $true
  $cancelled = Read-Handlers
  foreach ($suffix in $all) {
    if ($cancelled.$suffix.progId -ne $before.$suffix.progId) { throw "Cancel changed .$suffix." }
  }
  $report.cancel='passed'
  foreach ($suffix in $extensions) {
    Select-Default $suffix 'DNAForge' $false
    Wait-ForDefault $suffix 'DNAForge.GenBank'
  }
  $report.after = Read-Handlers
  foreach ($suffix in $extensions) {
    if ($report.after.$suffix.progId -ne 'DNAForge.GenBank') { throw "Wrong handler for .$suffix." }
  }
  if ($report.after.dna.progId -ne $before.dna.progId) { throw 'Unrelated .dna default changed.' }
  $coldPid = $null
  foreach ($suffix in $extensions) {
    $name = "native-preview-{0}.$suffix" -f [guid]::NewGuid()
    $source = Join-Path $run.FullName $name
    Copy-Item -LiteralPath $GenBankFile -Destination $source
    Start-Process -FilePath $source
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $receipt = $null
    do {
      foreach ($file in @(Get-ChildItem -Path $profileRoot -Filter quick-look.json -Recurse -ErrorAction SilentlyContinue)) {
        if ($file.FullName -match '[\\/]\.staging-') { continue }
        $manifest = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        if ($manifest.sourceFileName -ceq $name -and $manifest.sourceContentHash -eq $hash -and $manifest.records.Count) {
          $receipt = $file.FullName
          break
        }
      }
      if (!$receipt) { Start-Sleep -Milliseconds 400 }
    } while (!$receipt -and [DateTime]::UtcNow -lt $deadline)
    if (!$receipt) { throw "No matching preview for .$suffix." }
    $running = @(App-Processes)
    $main = @($running | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
    if ($main.Count -ne 1) { throw 'Expected one visible window process of the installed candidate.' }
    if ($null -eq $coldPid) { $coldPid = $main[0].Id }
    if ($main[0].Id -ne $coldPid) { throw 'Warm open did not reach the same process.' }
    if ((Get-FileHash $source -Algorithm SHA256).Hash -ne $hash) { throw "The .$suffix source changed." }
    $report.opens += @{ file=$source; sourceHash=$hash; manifest=$receipt; processId=$coldPid }
  }
  $report.openVerdict = 'passed'
} finally {
  try {
    $actual = Read-Handlers
    foreach ($suffix in $all) {
      if ($actual.$suffix.progId -eq $before.$suffix.progId) { continue }
      Select-Default $suffix $before.$suffix.name $false
      Wait-ForDefault $suffix $before.$suffix.progId
    }
    $restored = Read-Handlers
    foreach ($suffix in $all) {
      if ($restored.$suffix.progId -ne $before.$suffix.progId) { throw "Restoration failed for .$suffix." }
    }
    $report.restored = $true
    $report.final = $restored
  } finally {
    $report | ConvertTo-Json -Depth 6 | Out-File -FilePath $ReportPath -Encoding utf8 -NoClobber
  }
}
