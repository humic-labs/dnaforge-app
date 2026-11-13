param(
  [string]$ParserPath = (Join-Path $PSScriptRoot '..\resources\dnaforge-download-identity.ps1'),
  [string]$VectorPath = (Join-Path $PSScriptRoot '..\..\..\test-fixtures\analytics\windows-download-id-vectors.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$vectors = Get-Content -LiteralPath $VectorPath -Raw | ConvertFrom-Json
foreach ($vector in $vectors.valid) {
  $actual = (& $ParserPath -InstallerPath $vector.filename | Out-String).Trim()
  if ($actual -cne $vector.download_id) {
    throw "Valid installer filename parsed incorrectly: $($vector.filename) -> '$actual'"
  }
}
foreach ($filename in $vectors.invalid) {
  $actual = (& $ParserPath -InstallerPath $filename | Out-String).Trim()
  if ($actual) {
    throw "Invalid installer filename was attributed: $filename -> '$actual'"
  }
}

Write-Host "PASS: Windows download identity vectors ($($vectors.valid.Count) valid, $($vectors.invalid.Count) invalid)."
