param(
  [Parameter(Mandatory = $true)][string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

try {
  $filename = [System.IO.Path]::GetFileName($InstallerPath)
  $pattern = '^DNAForge-Setup-[0-9A-Za-z][0-9A-Za-z.-]{0,63}--dfdl1-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?: \(([1-9][0-9]*)\))?\.exe$'
  if ($filename -cmatch $pattern) {
    Write-Output $Matches[1]
  }
}
catch {
  exit 0
}
