param(
  [Parameter(Mandatory = $true)][string] $InstalledExe,
  [Parameter(Mandatory = $true)][string] $GenBankFile
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
$before = & $script -Extensions $extension | ConvertFrom-Json
if ($before.$extension -eq 'DNAForge.GenBank') { throw 'Start a new sandbox where DNAForge is not already the default.' }
$source = Join-Path $env:TEMP ("native-preview-{0}.$extension" -f [guid]::NewGuid())
Copy-Item -LiteralPath $GenBankFile -Destination $source
$hash = (Get-FileHash $source -Algorithm SHA256).Hash
$profileRoot = Join-Path $env:APPDATA 'DNAForge\quick-look-packages'
Start-Process 'ms-settings:defaultapps?registeredAppUser=DNAForge'
Find-SettingsControl ".$extension"
Find-SettingsControl 'DNAForge' $true
Find-SettingsControl 'Set default' $true
$deadline = [DateTime]::UtcNow.AddMinutes(3)
do {
  Start-Sleep -Milliseconds 750
  $current = & powershell.exe -NoProfile -NonInteractive -File $script -Extensions $extension | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Effective shell query failed.' }
} while ($current.$extension -ne 'DNAForge.GenBank' -and [DateTime]::UtcNow -lt $deadline)
if ($current.$extension -ne 'DNAForge.GenBank') { throw 'Windows did not confirm the new default.' }
Start-Process -FilePath $source
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$receipt = $null
do {
  foreach ($file in @(Get-ChildItem -Path $profileRoot -Filter quick-look.json -Recurse -ErrorAction SilentlyContinue)) {
    $candidate = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if ($candidate.sourceFileName -ceq [IO.Path]::GetFileName($source) -and
        $candidate.sourceContentHash -eq $hash -and $candidate.records.Count -gt 0) {
      $receipt = $file
      break
    }
  }
  if (!$receipt) { Start-Sleep -Milliseconds 500 }
} while (!$receipt -and [DateTime]::UtcNow -lt $deadline)
if (!$receipt) { throw 'Shell opening the actual file did not produce the matching preview.' }
if (!(Get-Process DNAForge -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })) {
  throw 'The installed candidate is not running.'
}
if ((Get-FileHash $source -Algorithm SHA256).Hash -ne $hash) { throw 'The source changed.' }
[ordered]@{ application = $exe; source = $source; before = $before; after = $current;
  sourceHash = $hash; preview = $receipt.FullName } | ConvertTo-Json
