# Verifies the pinned opencode-token-monitor bundle against its manifest.
# A missing Token Monitor database or CLI is normal and never a failure.
# STATUS: not executed in CI yet (no PowerShell on the build host); see docs/IMPLEMENTATION_STATUS.md.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $Root "integrations/token-monitor/manifest.json"
function Fail([string]$Message) { Write-Host "token-monitor: $Message"; exit 1 }
if (-not (Test-Path $ManifestPath)) { Fail "manifest missing: $ManifestPath" }
$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
if (-not $Manifest.version -or $Manifest.version -eq "latest") { Fail "manifest must pin an exact version" }
if ($Manifest.sha256 -notmatch '^[0-9a-f]{64}$') { Fail "manifest sha256 is not a real hash" }
$BundlePath = Join-Path $Root $Manifest.artifact
if (-not (Test-Path $BundlePath)) { Fail "bundle missing: $BundlePath" }
$Actual = (Get-FileHash -Algorithm SHA256 -Path $BundlePath).Hash.ToLowerInvariant()
if ($Actual -ne $Manifest.sha256) { Fail "bundle sha256 $Actual does not match manifest $($Manifest.sha256) (generated file was modified?)" }
$Head = Get-Content $BundlePath -TotalCount 8
if (-not ($Head -contains "// Version: $($Manifest.version)")) { Fail "bundle header does not declare version $($Manifest.version)" }
if (-not ($Head -contains "// DO NOT EDIT")) { Fail "bundle is missing the generated-file header" }
Write-Host "token-monitor: ok ($($Manifest.version), $($Manifest.sha256))"
exit 0
