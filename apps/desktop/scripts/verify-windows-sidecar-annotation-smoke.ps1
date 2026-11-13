param(
  [string]$SidecarDir = '',

  [string]$SourceApiDir = '',

  [Parameter(Mandatory = $true)]
  [string]$BinariesDir,

  [Parameter(Mandatory = $true)]
  [string]$AnnotationDataDir,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [int]$Port = 18125,

  [int]$StartupBudget = 45,

  [int]$TimeoutSeconds = 300,

  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:SessionToken = 'ci-' + [guid]::NewGuid().ToString('N')

function Fail-Probe {
  param(
    [Parameter(Mandatory = $true)][string]$Gate,
    [Parameter(Mandatory = $true)][string]$Message
  )
  throw "FAIL ($Gate): $Message`n  evidence: $script:StdoutPath`n  stderr: $script:StderrPath"
}

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
}

function Get-GenBankOriginSequence {
  param([Parameter(Mandatory = $true)][string]$Path)

  $inOrigin = $false
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^ORIGIN') {
      $inOrigin = $true
      continue
    }
    if ($line -match '^//') {
      $inOrigin = $false
    }
    if ($inOrigin) {
      $parts.Add((($line -replace '[0-9\s]', '').ToUpperInvariant()))
    }
  }
  return ($parts -join '')
}

function Get-GenBankFeatureSubsequence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$FeatureName
  )

  $sequence = Get-GenBankOriginSequence -Path $Path
  $featureMatches = New-Object System.Collections.Generic.List[object]
  $featureType = ''
  $start1 = $null
  $end1 = $null

  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^     (\S+)\s+(\d+)\.\.(\d+)') {
      $featureType = $Matches[1]
      $start1 = [int]$Matches[2]
      $end1 = [int]$Matches[3]
      continue
    }
    if ($featureType -eq 'gene' -and $line -match '^                     /gene="([^"]+)"' -and $Matches[1] -eq $FeatureName) {
      $featureMatches.Add([pscustomobject]@{ Start1 = $start1; End1 = $end1 })
    }
  }

  if ($featureMatches.Count -ne 1) {
    throw "Expected exactly one gene '$FeatureName' in GenBank fixture $Path; found $($featureMatches.Count)"
  }
  $match = $featureMatches[0]
  if ($match.Start1 -lt 1 -or $match.End1 -lt $match.Start1 -or $match.End1 -gt $sequence.Length) {
    throw "Invalid GenBank range for gene '$FeatureName': $($match.Start1)..$($match.End1)"
  }
  return $sequence.Substring($match.Start1 - 1, $match.End1 - $match.Start1 + 1)
}

function Invoke-JsonGet {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$Timeout = 15
  )

  $json = curl.exe -s --max-time $Timeout -H "X-DNAForge-Session: $script:SessionToken" $Url
  if (-not $json) {
    return $null
  }
  try {
    return ($json | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Invoke-Annotation {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Sequence,
    [Parameter(Mandatory = $true)][bool]$Linear,
    [int]$Timeout = 180
  )

  $bodyPath = [System.IO.Path]::GetTempFileName()
  try {
    @{ sequence = $Sequence; linear = $Linear } |
      ConvertTo-Json -Compress |
      Set-Content -LiteralPath $bodyPath -Encoding UTF8

    $json = curl.exe -s --max-time $Timeout -X POST "http://127.0.0.1:$Port/annotation" `
      -H "X-DNAForge-Session: $script:SessionToken" `
      -H 'Content-Type: application/json' --data-binary "@$bodyPath"
    if (-not $json) {
      Fail-Probe 'C' 'annotation endpoint returned no response'
    }

    try {
      return ($json | ConvertFrom-Json)
    } catch {
      $snippet = $json.Substring(0, [Math]::Min(400, $json.Length))
      Fail-Probe 'C' "annotation endpoint returned invalid JSON -> $snippet"
    }
  } finally {
    Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
  }
}

function Wait-Health {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][int]$Port
  )

  $startEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $deadline = $startEpoch + $TimeoutSeconds
  do {
    if ($Process.HasExited) {
      Fail-Probe 'A' "sidecar exited before health became ready; exitCode=$($Process.ExitCode)"
    }

    $health = Invoke-JsonGet -Url "http://127.0.0.1:$Port/health" -Timeout 5
    if ($health -and [string]$health.status -eq 'healthy') {
      $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $startEpoch
      Write-Host "probe: GATE A PASS - sidecar /health ready in ${elapsed}s"
      if ($elapsed -gt $StartupBudget) {
        Fail-Probe 'A-SPEED' "sidecar took ${elapsed}s (budget ${StartupBudget}s)"
      }
      if ([string]$health.app_version -ne $ExpectedVersion) {
        Fail-Probe 'B' "app_version mismatch (expected $ExpectedVersion) -> $($health | ConvertTo-Json -Compress)"
      }
      if ($health.PSObject.Properties.Name -contains 'mcp_session_fingerprint') {
        Fail-Probe 'B' "authenticated /health leaked token-derived material -> $($health | ConvertTo-Json -Compress)"
      }
      Write-Host "probe: GATE B PASS - authenticated /health accepted this launch token, app_version=$ExpectedVersion"
      return
    }

    Start-Sleep -Seconds 2
  } while ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -lt $deadline)

  Fail-Probe 'A' "sidecar /health did not become ready within ${TimeoutSeconds}s"
}

function Wait-AnnotationReady {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 180
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastSummary = ''
  do {
    $status = Invoke-JsonGet -Url "http://127.0.0.1:$Port/toolbox/status" -Timeout 15
    if ($status) {
      $annotation = @($status.capabilities) | Where-Object { $_.id -eq 'annotation' } | Select-Object -First 1
      if ($annotation) {
        $components = @($annotation.components)
        $summary = ($components | ForEach-Object { "$($_.id):$($_.status)" }) -join ', '
        if ($summary -and $summary -ne $lastSummary) {
          Write-Host "probe: annotation toolbox waiting - $summary"
          $lastSummary = $summary
        }
        $ids = @($components | ForEach-Object { [string]$_.id })
        $unready = @($components | Where-Object { [string]$_.status -ne 'ready' })
        $hasCmscan = $ids -contains 'cmscan'
        $hasDatabases = $ids -contains 'databases'
        if ($unready.Count -eq 0 -and $hasCmscan -and $hasDatabases) {
          Write-Host ("probe: annotation toolbox ready - {0}" -f (($ids | Sort-Object) -join ', '))
          return
        }
      }
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)

  $snapshot = curl.exe -s --max-time 15 -H "X-DNAForge-Session: $script:SessionToken" "http://127.0.0.1:$Port/toolbox/status"
  if ($snapshot -and $script:LogDir) {
    Set-Content -LiteralPath (Join-Path $script:LogDir 'toolbox-status.json') -Value $snapshot -Encoding UTF8
  }
  $snippet = if ($snapshot) { $snapshot.Substring(0, [Math]::Min(4000, $snapshot.Length)) } else { '<no response>' }
  Fail-Probe 'E' "annotation toolbox did not become fully ready with cmscan + databases -> $snippet"
}

$repoRoot = Get-RepoRoot
$BinariesDir = (Resolve-Path $BinariesDir).Path
$AnnotationDataDir = (Resolve-Path $AnnotationDataDir).Path
$useCompiledSidecar = -not [string]::IsNullOrWhiteSpace($SidecarDir)
$useSourceSidecar = -not [string]::IsNullOrWhiteSpace($SourceApiDir)
if ($useCompiledSidecar -eq $useSourceSidecar) {
  throw 'FAIL (SETUP): provide exactly one of -SidecarDir or -SourceApiDir'
}
if ($useCompiledSidecar) {
  $SidecarDir = (Resolve-Path $SidecarDir).Path
} else {
  $SourceApiDir = (Resolve-Path $SourceApiDir).Path
}
if (-not $LogDir) {
  $LogDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dnaforge-windows-sidecar-annotation-smoke'
}
$script:LogDir = $LogDir
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$script:StdoutPath = Join-Path $LogDir 'sidecar.stdout.log'
$script:StderrPath = Join-Path $LogDir 'sidecar.stderr.log'
if ($useCompiledSidecar) {
  $sidecarExe = Join-Path $SidecarDir 'waypoint-api.exe'
  if (-not (Test-Path -LiteralPath $sidecarExe)) {
    Fail-Probe 'SETUP' "missing sidecar executable: $sidecarExe"
  }
}

$pkg = Get-Content -Raw (Join-Path $repoRoot 'apps\desktop\package.json') | ConvertFrom-Json
if ([string]$pkg.version -ne $ExpectedVersion) {
  Fail-Probe 'SETUP' "ExpectedVersion $ExpectedVersion does not match apps/desktop/package.json $($pkg.version)"
}

$oldEnv = @{
  WAYPOINT_DATA_DIR = $env:WAYPOINT_DATA_DIR
  WAYPOINT_BINARIES_PATH = $env:WAYPOINT_BINARIES_PATH
  WAYPOINT_APP_VERSION = $env:WAYPOINT_APP_VERSION
  DNAFORGE_MCP_SESSION_TOKEN = $env:DNAFORGE_MCP_SESSION_TOKEN
  DNAFORGE_MCP_AGENT_IDENTITY = $env:DNAFORGE_MCP_AGENT_IDENTITY
  DNAFORGE_MCP_GRANT_CAPABILITIES = $env:DNAFORGE_MCP_GRANT_CAPABILITIES
  DNAFORGE_ANNOTATION_DEBUG_ERRORS = $env:DNAFORGE_ANNOTATION_DEBUG_ERRORS
}
$process = $null
try {
  $env:WAYPOINT_DATA_DIR = $AnnotationDataDir
  $env:WAYPOINT_BINARIES_PATH = $BinariesDir
  $env:WAYPOINT_APP_VERSION = $ExpectedVersion
  $env:DNAFORGE_MCP_SESSION_TOKEN = $script:SessionToken
  $env:DNAFORGE_MCP_AGENT_IDENTITY = 'ci-sidecar-annotation-smoke'
  $env:DNAFORGE_MCP_GRANT_CAPABILITIES = '["debug.echo"]'
  $env:DNAFORGE_ANNOTATION_DEBUG_ERRORS = '1'

  if ($useCompiledSidecar) {
    Write-Host "probe: starting $sidecarExe on port $Port"
  } else {
    Write-Host "probe: starting source sidecar from $SourceApiDir on port $Port"
  }
  Write-Host "probe: WAYPOINT_DATA_DIR=$AnnotationDataDir"
  Write-Host "probe: WAYPOINT_BINARIES_PATH=$BinariesDir"

  if ($useCompiledSidecar) {
    $process = Start-Process `
      -FilePath $sidecarExe `
      -ArgumentList @('--port', [string]$Port) `
      -RedirectStandardOutput $script:StdoutPath `
      -RedirectStandardError $script:StderrPath `
      -PassThru `
      -WindowStyle Hidden
  } else {
    $process = Start-Process `
      -FilePath 'python' `
      -ArgumentList @('-m', 'uvicorn', 'src.main:app', '--host', '127.0.0.1', '--port', [string]$Port) `
      -WorkingDirectory $SourceApiDir `
      -RedirectStandardOutput $script:StdoutPath `
      -RedirectStandardError $script:StderrPath `
      -PassThru `
      -WindowStyle Hidden
  }

  Wait-Health -Process $process -Port $Port
  Wait-AnnotationReady -Port $Port

  $puc19Path = Join-Path $repoRoot 'test-fixtures\sequences\circular\pUC19.gb'
  $mg1655Path = Join-Path $repoRoot 'test-fixtures\sequences\circular\ecoli-mg1655-complete.gb'
  if (-not (Test-Path -LiteralPath $puc19Path)) { Fail-Probe 'C' "missing pUC19 fixture: $puc19Path" }
  if (-not (Test-Path -LiteralPath $mg1655Path)) { Fail-Probe 'C' "missing MG1655 fixture: $mg1655Path" }

  $puc19Seq = Get-GenBankOriginSequence -Path $puc19Path
  $puc19 = Invoke-Annotation -Port $Port -Sequence $puc19Seq -Linear $false -Timeout 180
  if ($puc19.PSObject.Properties['error']) {
    Fail-Probe 'C' "pUC19 annotation returned error -> $($puc19.error)"
  }
  $puc19Features = @($puc19.features)
  if ($puc19Features.Count -eq 0) {
    Fail-Probe 'C' 'pUC19 annotation returned zero features'
  }
  $nonRfam = $puc19Features | Where-Object { $_.db_source -ne 'rna' } | Select-Object -First 1
  if (-not $nonRfam) {
    Fail-Probe 'C' 'pUC19 annotation returned no non-Rfam feature'
  }

  $tmRnaSeq = Get-GenBankFeatureSubsequence -Path $mg1655Path -FeatureName 'ssrA'
  if ($tmRnaSeq.Length -ne 363) {
    Fail-Probe 'C' "MG1655 ssrA feature extraction produced $($tmRnaSeq.Length) bp, expected 363"
  }
  $rfam = Invoke-Annotation -Port $Port -Sequence $tmRnaSeq -Linear $true -Timeout 240
  if ($rfam.PSObject.Properties['error']) {
    Fail-Probe 'C' "Rfam ssrA annotation returned error -> $($rfam.error)"
  }
  $rfamFeatures = @($rfam.features)
  $tmRnaHit = $rfamFeatures | Where-Object {
    $_.db_source -eq 'rna' -and (
      $_.accession -eq 'RF00023' -or
      $_.name -match 'tmRNA|transfer-messenger' -or
      $_.description -match 'tmRNA|transfer-messenger'
    )
  } | Select-Object -First 1
  if (-not $tmRnaHit) {
    $sample = ($rfamFeatures | ConvertTo-Json -Compress -Depth 6)
    $snippet = if ($sample) { $sample.Substring(0, [Math]::Min(800, $sample.Length)) } else { '<no features>' }
    Fail-Probe 'C' "expected Rfam RF00023/tmRNA hit was absent -> $snippet"
  }
  if ($tmRnaHit.start -ne 1 -or $tmRnaHit.end -ne 363) {
    Fail-Probe 'C' "Rfam RF00023/tmRNA coordinates were $($tmRnaHit.start)..$($tmRnaHit.end), expected 1..363"
  }

  Write-Host "probe: GATE C PASS - pUC19 non-Rfam feature '$($nonRfam.name)' and Rfam hit '$($tmRnaHit.name)'"
  Write-Host 'probe: GATE E PASS - bundled annotation binaries and databases ready'
  Write-Host ''
  Write-Host 'PASS: Windows sidecar annotation verified - /health + pUC19 compute + Rfam RF00023 + toolbox.'
  Write-Host "  stdout: $script:StdoutPath"
  Write-Host "  stderr: $script:StderrPath"
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit(5000) | Out-Null
  }
  foreach ($name in $oldEnv.Keys) {
    if ($null -eq $oldEnv[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" $oldEnv[$name]
    }
  }
}
