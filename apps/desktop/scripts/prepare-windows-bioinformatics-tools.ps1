$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Split-Path -Parent $ScriptDir
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..\..\..'))
$AssetLockPath = Join-Path $RepoRoot '.ci\release-assets.lock.json'
if (!(Test-Path -LiteralPath $AssetLockPath)) {
  throw "Missing release asset lock: $AssetLockPath"
}
$AssetLock = Get-Content -LiteralPath $AssetLockPath -Raw | ConvertFrom-Json
if ($AssetLock.contract -ne 'dnaforge-release-assets.v1') {
  throw "Unsupported release asset lock contract: $($AssetLock.contract)"
}

$BundleDir = [System.IO.Path]::GetFullPath((Join-Path $DesktopDir 'resources\binaries'))
$TempRoot = if ($env:DNAFORGE_WINDOWS_TOOLS_CACHE) {
  $env:DNAFORGE_WINDOWS_TOOLS_CACHE
} elseif ($env:RUNNER_TEMP) {
  Join-Path $env:RUNNER_TEMP 'dnaforge-windows-bioinformatics-tools'
} else {
  Join-Path $env:TEMP 'dnaforge-windows-bioinformatics-tools'
}
$TempRoot = [System.IO.Path]::GetFullPath($TempRoot)

function Get-LockedWindowsTool {
  param([Parameter(Mandatory = $true)][string]$ToolId)

  $toolProperty = $AssetLock.tools.PSObject.Properties[$ToolId]
  if ($null -eq $toolProperty) {
    throw "Release asset lock has no tool '$ToolId'"
  }
  $platformProperty = $toolProperty.Value.platforms.PSObject.Properties['x86_64-pc-windows-msvc']
  if ($null -eq $platformProperty) {
    throw "Release asset lock has no Windows asset for '$ToolId'"
  }
  $asset = $platformProperty.Value
  $fileName = ($asset.key -split '/')[-1]
  return @{
    Url = "$($AssetLock.publicBaseUrl.TrimEnd('/'))/$($asset.key)"
    File = $fileName
    Sha256 = $asset.sha256.ToUpperInvariant()
  }
}

$Tools = @{
  Blast = Get-LockedWindowsTool 'blast'
  Diamond = Get-LockedWindowsTool 'diamond'
  Mafft = Get-LockedWindowsTool 'mafft'
  Infernal = Get-LockedWindowsTool 'infernal'
}

function Get-Sha256Hex {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $bytes = $sha256.ComputeHash($stream)
      return (($bytes | ForEach-Object { $_.ToString('X2') }) -join '')
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-UnderDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $resolved = Resolve-FullPath $Path
  $resolvedRoot = Resolve-FullPath $Root
  if (!$resolvedRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $resolvedRoot += [System.IO.Path]::DirectorySeparatorChar
  }

  if (!$resolved.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside ${Root}: $resolved"
  }
}

function Get-Archive {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Tool
  )

  New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
  $archive = Join-Path $TempRoot $Tool.File

  if (Test-Path -LiteralPath $archive) {
    $existingHash = Get-Sha256Hex $archive
    if ($existingHash -ne $Tool.Sha256) {
      Remove-Item -LiteralPath $archive -Force
    }
  }

  if (!(Test-Path -LiteralPath $archive)) {
    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
      Write-Host "[windows-tools] Downloading $($Tool.Url) (attempt $attempt/$maxAttempts)"
      Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
      & curl.exe -L --fail --connect-timeout 30 --max-time 300 -o $archive $Tool.Url
      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0) {
        break
      }
      Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
      if ($attempt -eq $maxAttempts) {
        throw "curl failed for $($Tool.Url) with exit code $exitCode after $maxAttempts attempts"
      }
      Start-Sleep -Seconds ([Math]::Min(30, 2 * $attempt))
    }
  }

  $hash = Get-Sha256Hex $archive
  if ($hash -ne $Tool.Sha256) {
    throw "SHA256 mismatch for $($Tool.File): expected $($Tool.Sha256), got $hash"
  }

  return $archive
}

function Reset-Dir {
  param([Parameter(Mandatory = $true)][string]$Path)
  Assert-UnderDirectory -Path $Path -Root $TempRoot
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  if ($FilePath -match '\.(bat|cmd)$') {
    $commandLine = '"' + $FilePath + '" ' + ($Arguments -join ' ') + ' >NUL 2>NUL'
    & cmd.exe /d /c $commandLine
  } else {
    & $FilePath @Arguments *> $null
  }

  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "$FilePath $($Arguments -join ' ') failed with exit code $exitCode"
  }
}

function Find-Msys2Shell {
  $launcherCandidates = @()
  if ($env:RUNNER_TEMP) {
    $launcherCandidates += (Join-Path $env:RUNNER_TEMP 'setup-msys2\msys2.cmd')
  }

  foreach ($candidate in ($launcherCandidates | Where-Object { $_ })) {
    if (Test-Path -LiteralPath $candidate) {
      Write-Host "[windows-tools] Using MSYS2 shell: $candidate"
      return [pscustomobject]@{ Path = $candidate; Argument = '-c' }
    }
  }

  $candidates = @()
  $candidates += $env:MSYS2_BASH
  $candidates += 'C:\msys64\usr\bin\bash.exe'
  $candidates = $candidates | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      Write-Host "[windows-tools] Using MSYS2 shell: $candidate"
      return [pscustomobject]@{ Path = $candidate; Argument = '-lc' }
    }
  }

  throw 'MSYS2 Bash not found. Install MSYS2 or run after msys2/setup-msys2 in CI.'
}

function Convert-ToMsysPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = [System.IO.Path]::GetFullPath($Path).Replace('\', '/')
  if ($resolved -match '^([A-Za-z]):/(.*)$') {
    return "/$($Matches[1].ToLowerInvariant())/$($Matches[2])"
  }
  return $resolved
}

function Invoke-CmscanBuild {
  $msys2 = Find-Msys2Shell
  $buildScript = Join-Path $ScriptDir 'build-windows-cmscan.sh'
  if (!(Test-Path -LiteralPath $buildScript)) {
    throw "Missing cmscan build script: $buildScript"
  }

  $outputDir = Join-Path $TempRoot 'cmscan-win-x64'
  $sourceCache = Join-Path $TempRoot 'cmscan-source'
  Assert-UnderDirectory -Path $outputDir -Root $TempRoot
  New-Item -ItemType Directory -Force -Path $sourceCache | Out-Null

  $previousMsystem = $env:MSYSTEM
  $previousChereInvoking = $env:CHERE_INVOKING
  $previousInfernalVersion = $env:INFERNAL_VERSION
  $previousInfernalSourceUrl = $env:INFERNAL_SOURCE_URL
  $previousInfernalSourceSha256 = $env:INFERNAL_SOURCE_SHA256
  $previousScript = $env:DNAFORGE_CMSCAN_SCRIPT
  $previousOutput = $env:DNAFORGE_CMSCAN_OUTPUT
  $previousSourceCache = $env:DNAFORGE_CMSCAN_SOURCE_CACHE
  $previousScriptPosix = $env:DNAFORGE_CMSCAN_SCRIPT_POSIX
  $previousOutputPosix = $env:DNAFORGE_CMSCAN_OUTPUT_POSIX
  $previousSourceCachePosix = $env:DNAFORGE_CMSCAN_SOURCE_CACHE_POSIX

  try {
    $env:MSYSTEM = 'MINGW64'
    $env:CHERE_INVOKING = '1'
    $env:INFERNAL_VERSION = '1.1.5'
    $env:INFERNAL_SOURCE_URL = $Tools.Infernal.Url
    $env:INFERNAL_SOURCE_SHA256 = $Tools.Infernal.Sha256.ToLowerInvariant()
    $env:DNAFORGE_CMSCAN_SCRIPT = $buildScript
    $env:DNAFORGE_CMSCAN_OUTPUT = $outputDir
    $env:DNAFORGE_CMSCAN_SOURCE_CACHE = $sourceCache
    $env:DNAFORGE_CMSCAN_SCRIPT_POSIX = Convert-ToMsysPath $buildScript
    $env:DNAFORGE_CMSCAN_OUTPUT_POSIX = Convert-ToMsysPath $outputDir
    $env:DNAFORGE_CMSCAN_SOURCE_CACHE_POSIX = Convert-ToMsysPath $sourceCache

    Write-Host "[windows-tools] Building native cmscan.exe with MSYS2/MinGW"
    $msys2Path = $msys2.Path
    $msys2Argument = $msys2.Argument
    $buildExitCode = 1
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $buildOutput = & $msys2Path $msys2Argument 'export PATH=/mingw64/bin:/usr/bin:$PATH; "$DNAFORGE_CMSCAN_SCRIPT_POSIX" "$DNAFORGE_CMSCAN_OUTPUT_POSIX" "$DNAFORGE_CMSCAN_SOURCE_CACHE_POSIX"' 2>&1
      $buildExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $buildOutput | ForEach-Object { Write-Host $_ }
    if ($buildExitCode -ne 0) {
      throw "cmscan build failed with exit code $buildExitCode"
    }
  } finally {
    $env:MSYSTEM = $previousMsystem
    $env:CHERE_INVOKING = $previousChereInvoking
    $env:INFERNAL_VERSION = $previousInfernalVersion
    $env:INFERNAL_SOURCE_URL = $previousInfernalSourceUrl
    $env:INFERNAL_SOURCE_SHA256 = $previousInfernalSourceSha256
    $env:DNAFORGE_CMSCAN_SCRIPT = $previousScript
    $env:DNAFORGE_CMSCAN_OUTPUT = $previousOutput
    $env:DNAFORGE_CMSCAN_SOURCE_CACHE = $previousSourceCache
    $env:DNAFORGE_CMSCAN_SCRIPT_POSIX = $previousScriptPosix
    $env:DNAFORGE_CMSCAN_OUTPUT_POSIX = $previousOutputPosix
    $env:DNAFORGE_CMSCAN_SOURCE_CACHE_POSIX = $previousSourceCachePosix
  }

  if (!(Test-Path -LiteralPath (Join-Path $outputDir 'cmscan.exe'))) {
    throw "cmscan build completed without producing cmscan.exe in $outputDir"
  }

  return $outputDir
}

New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null

$extractRoot = Join-Path $TempRoot 'extract'
Reset-Dir $extractRoot

$blastArchive = Get-Archive $Tools.Blast
$blastExtract = Join-Path $extractRoot 'blast'
Reset-Dir $blastExtract
& tar.exe -xzf $blastArchive -C $blastExtract
if ($LASTEXITCODE -ne 0) {
  throw "Failed to extract $blastArchive"
}
$blastBin = Join-Path $blastExtract 'ncbi-blast-2.16.0+\bin'
Copy-Item -LiteralPath (Join-Path $blastBin 'blastn.exe') -Destination (Join-Path $BundleDir 'blastn.exe') -Force
Copy-Item -LiteralPath (Join-Path $blastBin 'makeblastdb.exe') -Destination (Join-Path $BundleDir 'makeblastdb.exe') -Force
Get-ChildItem -LiteralPath $blastBin -Filter '*.dll' |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BundleDir $_.Name) -Force
  }
$blastDlls = @(Get-ChildItem -LiteralPath $blastBin -Filter '*.dll' | Sort-Object Name | ForEach-Object {
    [ordered]@{
      file = $_.Name
      productName = $_.VersionInfo.ProductName
      productVersion = $_.VersionInfo.ProductVersion
      fileVersion = $_.VersionInfo.FileVersion
    }
  })
foreach ($dll in $blastDlls) {
  Write-Host "[windows-tools] BLAST+ library $($dll.file): $($dll.productName) $($dll.productVersion) (file $($dll.fileVersion))"
}
ConvertTo-Json -InputObject ([ordered]@{ dlls = $blastDlls }) -Depth 4 |
  Set-Content -LiteralPath (Join-Path $BundleDir 'blast-dll-versions.json') -Encoding utf8
Get-ChildItem -LiteralPath $blastBin -Filter '*.manifest' |
  Where-Object { $_.Name -in @('blastn.exe.manifest', 'makeblastdb.exe.manifest') } |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BundleDir $_.Name) -Force
  }

$diamondArchive = Get-Archive $Tools.Diamond
$diamondExtract = Join-Path $extractRoot 'diamond'
Reset-Dir $diamondExtract
Expand-Archive -LiteralPath $diamondArchive -DestinationPath $diamondExtract -Force
Copy-Item -LiteralPath (Join-Path $diamondExtract 'diamond.exe') -Destination (Join-Path $BundleDir 'diamond.exe') -Force

$mafftArchive = Get-Archive $Tools.Mafft
$mafftExtract = Join-Path $extractRoot 'mafft'
Reset-Dir $mafftExtract
Expand-Archive -LiteralPath $mafftArchive -DestinationPath $mafftExtract -Force
$mafftSourceDir = Join-Path $mafftExtract 'mafft-win'
$mafftBundleDir = Join-Path $BundleDir 'mafft-win'
Assert-UnderDirectory -Path $mafftBundleDir -Root $BundleDir
Remove-Item -LiteralPath $mafftBundleDir -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $mafftSourceDir -Destination $mafftBundleDir -Recurse -Force

@'
@echo off
call "%~dp0mafft-win\mafft.bat" %*
exit /b %ERRORLEVEL%
'@ | Set-Content -LiteralPath (Join-Path $BundleDir 'mafft.bat') -Encoding ASCII

$cmscanDir = Invoke-CmscanBuild
Copy-Item -LiteralPath (Join-Path $cmscanDir 'cmscan.exe') -Destination (Join-Path $BundleDir 'cmscan.exe') -Force
Copy-Item -LiteralPath (Join-Path $cmscanDir 'cmpress.exe') -Destination (Join-Path $BundleDir 'cmpress.exe') -Force
Get-ChildItem -LiteralPath $cmscanDir -Filter '*.dll' |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BundleDir $_.Name) -Force
  }
Get-ChildItem -LiteralPath $cmscanDir -Filter '*LICENSE*.txt' |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BundleDir $_.Name) -Force
  }
Copy-Item -LiteralPath (Join-Path $cmscanDir 'build-metadata.json') -Destination (Join-Path $BundleDir 'cmscan-build-metadata.json') -Force
Copy-Item -LiteralPath (Join-Path $cmscanDir 'SHA256SUMS.txt') -Destination (Join-Path $BundleDir 'cmscan-SHA256SUMS.txt') -Force

Invoke-Checked (Join-Path $BundleDir 'blastn.exe') @('-version')
Invoke-Checked (Join-Path $BundleDir 'makeblastdb.exe') @('-version')
Invoke-Checked (Join-Path $BundleDir 'diamond.exe') @('version')
Invoke-Checked (Join-Path $BundleDir 'mafft.bat') @('--version')
Invoke-Checked (Join-Path $BundleDir 'cmscan.exe') @('-h')
Invoke-Checked (Join-Path $BundleDir 'cmpress.exe') @('-h')

Write-Host '[windows-tools] Bundled Windows bioinformatics tools:'
Get-ChildItem -LiteralPath $BundleDir |
  Where-Object { $_.Name -match '^(blastn|makeblastdb|diamond|mafft|mafft-win|cmscan|cmpress|libgcc|libwinpthread|.*LICENSE)' } |
  Sort-Object Name |
  ForEach-Object {
    $size = if ($_.PSIsContainer) { '<dir>' } else { $_.Length }
    Write-Host ("  {0,12}  {1}" -f $size, $_.Name)
  }
