param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid update version: $Version" }

function Receive-CdpResponse {
  param(
    [Parameter(Mandatory = $true)][System.Net.WebSockets.ClientWebSocket]$Socket,
    [Parameter(Mandatory = $true)][int]$Id
  )

  while ($true) {
    $buffer = [byte[]]::new(65536)
    $message = [System.Text.StringBuilder]::new()
    do {
      $segment = [System.ArraySegment[byte]]::new($buffer)
      $received = $Socket.ReceiveAsync(
        $segment,
        [System.Threading.CancellationToken]::None
      ).GetAwaiter().GetResult()
      if ($received.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        throw 'The app closed its developer connection before acknowledging Restart now.'
      }
      [void]$message.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count))
    } while (!$received.EndOfMessage)

    $response = $message.ToString() | ConvertFrom-Json
    $responseId = $response.PSObject.Properties['id']
    if ($null -ne $responseId -and $responseId.Value -eq $Id) { return $response }
  }
}

function Invoke-CdpCommand {
  param(
    [Parameter(Mandatory = $true)][System.Net.WebSockets.ClientWebSocket]$Socket,
    [Parameter(Mandatory = $true)][int]$Id,
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Params = @{}
  )

  $payload = @{ id = $Id; method = $Method; params = $Params } |
    ConvertTo-Json -Compress -Depth 10
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  [void]$Socket.SendAsync(
    [System.ArraySegment[byte]]::new($bytes),
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [System.Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()
  return Receive-CdpResponse -Socket $Socket -Id $Id
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$target = $null
do {
  try {
    $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
    $target = @($targets | Where-Object {
      $_.type -eq 'page' -and $_.url -like '*app.asar/out/renderer/*'
    }) | Select-Object -First 1
  } catch {
    $target = $null
  }
  if (!$target) { Start-Sleep -Milliseconds 500 }
} while (!$target -and (Get-Date) -lt $deadline)

if (!$target -or [string]::IsNullOrWhiteSpace($target.webSocketDebuggerUrl)) {
  throw "Could not find the packaged DNAForge renderer on developer port $Port."
}

$socket = [System.Net.WebSockets.ClientWebSocket]::new()
try {
  [void]$socket.ConnectAsync(
    [uri]$target.webSocketDebuggerUrl,
    [System.Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()

  $expectedMessage = "Update v$Version ready. Restart to apply."
  $expectedJson = $expectedMessage | ConvertTo-Json -Compress
  $expression = @"
(() => {
  const expected = $expectedJson;
  if (!document.body?.innerText.includes(expected)) return { ready: false, reason: 'toast' };
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === 'Restart now');
  if (!button) return { ready: false, reason: 'button' };
  setTimeout(() => button.click(), 250);
  return { ready: true, scheduled: true, message: expected, action: 'Restart now' };
})()
"@

  $id = 1
  $clicked = $null
  do {
    $response = Invoke-CdpCommand -Socket $socket -Id $id -Method 'Runtime.evaluate' -Params @{
      expression = $expression
      returnByValue = $true
      awaitPromise = $true
    }
    $cdpError = $response.PSObject.Properties['error']
    if ($null -ne $cdpError) { throw "CDP rejected Runtime.evaluate: $($cdpError.Value.message)" }
    $exception = $response.result.PSObject.Properties['exceptionDetails']
    if ($null -ne $exception) {
      throw "Renderer evaluation failed: $($exception.Value.text)"
    }
    $clicked = $response.result.result.value
    if (!$clicked.ready) { Start-Sleep -Milliseconds 500 }
    $id += 1
  } while (!$clicked.ready -and (Get-Date) -lt $deadline)

  if (!$clicked.ready -or !$clicked.scheduled) {
    throw "The update-ready toast or Restart now button did not appear for v$Version."
  }

  $receipt = [ordered]@{
    version = $Version
    message = $clicked.message
    action = $clicked.action
    renderer_url = $target.url
    clicked_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $parent = Split-Path -Parent $OutputPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $receipt | ConvertTo-Json | Set-Content -LiteralPath $OutputPath -Encoding utf8
} finally {
  $socket.Dispose()
}
