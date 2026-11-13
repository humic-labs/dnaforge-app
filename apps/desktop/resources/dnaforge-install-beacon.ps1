param(
  [Parameter(Mandatory = $true)][string]$DiagnosticsBase,
  [Parameter(Mandatory = $true)][string]$Event,
  [Parameter(Mandatory = $true)][string]$AppVersion,
  [Parameter(Mandatory = $true)][string]$AttemptId,
  [string]$DownloadId = '',
  [string]$DesktopBuildTag = '',
  [string]$DesktopReleaseChannel = '',
  [Parameter(Mandatory = $true)][string]$ExeDir
)

$ErrorActionPreference = 'Stop'
try {
  $base = $DiagnosticsBase.Trim().TrimEnd('/')
  $sidecar = Join-Path $ExeDir 'dnaforge-diagnostics-url.txt'
  if (
    [string]$env:DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE -ceq '1' -and
    (Test-Path -LiteralPath $sidecar)
  ) {
    $raw = (Get-Content -LiteralPath $sidecar -Raw -ErrorAction Stop).Trim()
    if ($raw -match '^http://(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$') {
      $base = $Matches[0].TrimEnd('/')
    }
  }

  $telemetryActor = 'user'
  $explicitActor = [string]$env:DNAFORGE_TELEMETRY_ACTOR
  if ($explicitActor.Trim().ToLowerInvariant() -eq 'maintainer') {
    $telemetryActor = 'maintainer'
  }
  elseif ($explicitActor.Trim().ToLowerInvariant() -eq 'ci') {
    $telemetryActor = 'ci'
  }

  $body = @{
    schema      = 1
    event_id    = [guid]::NewGuid().ToString()
    event       = $Event.Trim()
    app_version = $AppVersion.Trim()
    platform    = 'win-x64'
    attempt_id  = $AttemptId.Trim()
    telemetry_actor = $telemetryActor
  }

  $actorAssertion = [string]$env:DNAFORGE_TELEMETRY_ACTOR_ASSERTION
  if ($actorAssertion -cmatch '^dfactor2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' -and $actorAssertion.Length -le 2048) {
    $body.telemetry_actor_assertion = $actorAssertion
  }

  if ($DownloadId -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    $body.download_id = $DownloadId
  }

  if ($DesktopBuildTag -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') {
    $body.desktop_build_tag = $DesktopBuildTag
  }

  $releaseChannel = $DesktopReleaseChannel.Trim().ToLowerInvariant()
  if (@('closed_beta', 'dev', 'preview', 'prod', 'unknown') -contains $releaseChannel) {
    $body.desktop_release_channel = $releaseChannel
  }

  $ciRunId = [string]$env:DNAFORGE_TELEMETRY_CI_RUN_ID
  if ([string]::IsNullOrWhiteSpace($ciRunId)) {
    $ciRunId = [string]$env:GITHUB_RUN_ID
  }
  if ($telemetryActor -eq 'ci' -and $ciRunId -match '^[1-9][0-9]{0,19}$') {
    $body.ci_run_id = $ciRunId
  }
  $bodyJson = $body | ConvertTo-Json -Compress

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-RestMethod `
        -Method Post `
        -Uri "$base/api/diagnostics/install-beacon" `
        -ContentType 'application/json' `
        -Body $bodyJson `
        -TimeoutSec 5 | Out-Null
      break
    }
    catch {
      $statusCode = 0
      if ($null -ne $_.Exception.Response) {
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = 0 }
      }
      $retryable = $statusCode -eq 0 -or $statusCode -eq 429 -or $statusCode -ge 500
      if (-not $retryable -or $attempt -eq 3) { break }
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
}
catch {
  exit 0
}
