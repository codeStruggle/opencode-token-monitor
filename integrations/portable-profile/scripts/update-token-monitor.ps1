# Updates the pinned opencode-token-monitor bundle in the portable profile.
# Usage: scripts/update-token-monitor.ps1 -Version <version> [-TestedWith <opencode-version>[,...]]
# Env:   TOKEN_MONITOR_BASE_URL overrides the release download location (default: GitHub release v<version>).
# Never tracks "latest", never commits or pushes. On any failure the previous bundle and manifest stay in place.
# STATUS: not executed in CI yet (no PowerShell on the build host); see docs/IMPLEMENTATION_STATUS.md.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string[]]$TestedWith = @()
)
$ErrorActionPreference = "Stop"

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
  Write-Error "An explicit version like 0.1.0 is required (got '$Version'); 'latest' is not supported"
  exit 2
}

$Root = Split-Path -Parent $PSScriptRoot
$Bundle = Join-Path $Root "profile/plugins/opencode-token-monitor.js"
$Manifest = Join-Path $Root "integrations/token-monitor/manifest.json"
$BaseUrl = if ($env:TOKEN_MONITOR_BASE_URL) { $env:TOKEN_MONITOR_BASE_URL } else { "https://github.com/codeStruggle/opencode-token-monitor/releases/download/v$Version" }

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tokenmon-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "downloading $BaseUrl/{opencode-token-monitor.js,checksums.txt}"
  $NewBundle = Join-Path $Tmp "opencode-token-monitor.js"
  $Sums = Join-Path $Tmp "checksums.txt"
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/opencode-token-monitor.js" -OutFile $NewBundle
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/checksums.txt" -OutFile $Sums

  $Expected = (Get-Content $Sums | Where-Object { ($_ -split '\s+')[1] -eq "opencode-token-monitor.js" } | ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1)
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $NewBundle).Hash.ToLowerInvariant()
  if (-not $Expected) { throw "checksums.txt has no entry for opencode-token-monitor.js" }
  if ($Expected.ToLowerInvariant() -ne $Actual) { throw "sha256 mismatch (expected $Expected, got $Actual)" }
  $Header = Get-Content $NewBundle -TotalCount 8
  if (-not ($Header -contains "// Version: $Version")) { throw "downloaded bundle does not declare version $Version" }
  $SchemaLine = $Header | Where-Object { $_ -match '^// DB schema: ([0-9]+)$' } | Select-Object -First 1
  if (-not $SchemaLine) { throw "downloaded bundle does not declare its database schema version" }
  $Schema = [int]($SchemaLine -replace '^// DB schema: ', '')
  # The checksum proves the file matches the published checksum list, not who published it.

  $OldVersion = "(none)"
  $OldSchema = $null
  if (Test-Path $Manifest) {
    $Old = Get-Content $Manifest -Raw | ConvertFrom-Json
    $OldVersion = $Old.version
    $OldSchema = $Old.dbSchemaVersion
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $Bundle), (Split-Path $Manifest) | Out-Null
  $BundleBak = Join-Path $Tmp "bundle.bak"
  $ManifestBak = Join-Path $Tmp "manifest.bak"
  if (Test-Path $Bundle) { Copy-Item $Bundle $BundleBak }
  if (Test-Path $Manifest) { Copy-Item $Manifest $ManifestBak }

  function Restore-Previous {
    Write-Warning "restoring previous bundle and manifest"
    if (Test-Path $BundleBak) { Copy-Item $BundleBak $Bundle -Force } else { Remove-Item $Bundle -ErrorAction SilentlyContinue }
    if (Test-Path $ManifestBak) { Copy-Item $ManifestBak $Manifest -Force } else { Remove-Item $Manifest -ErrorAction SilentlyContinue }
  }

  Copy-Item $NewBundle $Bundle -Force
  $ManifestObject = [ordered]@{
    name       = "opencode-token-monitor"
    version    = $Version
    source     = "https://github.com/codeStruggle/opencode-token-monitor"
    artifact   = "profile/plugins/opencode-token-monitor.js"
    sha256     = $Actual
    dbSchemaVersion = $Schema
    testedWith = [ordered]@{ opencode = @($TestedWith) }
  }
  ($ManifestObject | ConvertTo-Json -Depth 4) | Set-Content -Path $Manifest -Encoding utf8

  $Verify = Join-Path $PSScriptRoot "verify-token-monitor.ps1"
  if (Test-Path $Verify) {
    & $Verify
    if ($LASTEXITCODE -ne 0) { Restore-Previous; exit 1 }
  }
  $ProfileVerify = Join-Path $Root "verify.ps1"
  if (Test-Path $ProfileVerify) {
    & $ProfileVerify
    if ($LASTEXITCODE -ne 0) { Restore-Previous; exit 1 }
  }

  Write-Host "updated opencode-token-monitor: $OldVersion -> $Version"
  if ($null -ne $OldSchema -and $OldSchema -ne $Schema) { Write-Host "database schema: $OldSchema -> $Schema" }
  if ($null -ne $OldSchema -and $Schema -lt $OldSchema) {
    Write-Warning "this is a schema downgrade. Databases already migrated by the newer plugin make this plugin stop writing (data is kept); upgrade again to resume collection."
  }
  Write-Host "sha256: $Actual"
  if ($TestedWith.Count -eq 0) { Write-Host "note: testedWith.opencode is empty; pass -TestedWith only for versions you actually tested" }
  Write-Host "review the changes with git diff; nothing was committed"
}
catch {
  Write-Error $_
  exit 1
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
