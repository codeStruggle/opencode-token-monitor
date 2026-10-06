# Verifies the OpenCode Token Monitor installation on Windows.
# A missing database or CLI is normal (nothing recorded yet / CLI not installed) and never a failure.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = "Stop"

if ($env:XDG_CONFIG_HOME) { $ConfigBase = $env:XDG_CONFIG_HOME } else { $ConfigBase = Join-Path $HOME ".config" }
$ConfigDir = Join-Path $ConfigBase "opencode"
$PluginsDir = Join-Path $ConfigDir "plugins"
$Target = Join-Path $PluginsDir "opencode-token-monitor.js"
$Marker = Join-Path $ConfigDir ".opencode-token-monitor-install"

function Fail([string]$Message) { Write-Host "Error: $Message" -ForegroundColor Red; exit 1 }
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-Marker {
    $Values = @{}
    if (Test-Path -LiteralPath $Marker) {
        foreach ($Line in [System.IO.File]::ReadAllLines($Marker)) {
            $Parts = $Line.TrimStart([char]0xFEFF).Split("`t", 2)
            if ($Parts.Count -eq 2) { $Values[$Parts[0]] = $Parts[1] }
        }
    }
    return $Values
}

Write-Host "OpenCode config directory: $ConfigDir"
if ((Test-Path -LiteralPath $PluginsDir) -and (Get-Item -LiteralPath $PluginsDir -Force).LinkType) {
    Write-Host "Plugins directory is a link or junction (e.g. portable profile): $PluginsDir"
}
if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { Fail "plugin missing: $Target" }

$Head = @(Get-Content -LiteralPath $Target -TotalCount 10)
if (-not ($Head -contains "// GENERATED FILE")) { Fail "$Target has no generated-file header" }
if (-not ($Head -contains "// DO NOT EDIT")) { Fail "$Target has no DO NOT EDIT marker" }
$VersionLine = $Head | Where-Object { $_ -like "// Version: *" } | Select-Object -First 1
if (-not $VersionLine) { Fail "$Target does not declare a version" }
$Version = $VersionLine.Substring("// Version: ".Length)
$SchemaLine = $Head | Where-Object { $_ -like "// DB schema: *" } | Select-Object -First 1
if ($SchemaLine) { $Schema = $SchemaLine.Substring("// DB schema: ".Length) } else { $Schema = "unknown" }
Write-Host "Plugin: $Target (version $Version, DB schema $Schema)"

$Record = Read-Marker
$Actual = Get-Sha256 $Target
if ($Record["PLUGIN_SHA256"]) {
    if ($Actual -ne $Record["PLUGIN_SHA256"]) { Fail "plugin SHA-256 $Actual differs from the installed $($Record['PLUGIN_SHA256']) (file modified after install?)" }
    Write-Host "Plugin checksum matches install record."
} else {
    Write-Host "No install record from install.ps1 (installed another way, e.g. the portable profile); checksum: $Actual"
}

foreach ($Cfg in @((Join-Path $ConfigDir "opencode.json"), (Join-Path $ConfigDir "opencode.jsonc"))) {
    if ((Test-Path -LiteralPath $Cfg -PathType Leaf) -and (Select-String -LiteralPath $Cfg -Pattern "opencode-token-monitor" -SimpleMatch -Quiet)) {
        Write-Host "Warning: $Cfg also declares opencode-token-monitor via npm; only one copy collects per project."
    }
}
$ProjectCopy = Join-Path (Join-Path (Join-Path (Get-Location).Path ".opencode") "plugins") "opencode-token-monitor.js"
if (Test-Path -LiteralPath $ProjectCopy) {
    Write-Host "Warning: this project also has .opencode\plugins\opencode-token-monitor.js; only one copy collects."
}

if ($env:OPENCODE_TOKEN_MONITOR_DB -and $env:OPENCODE_TOKEN_MONITOR_DB.Trim()) { $DbPath = $env:OPENCODE_TOKEN_MONITOR_DB }
else {
    if ($env:XDG_DATA_HOME) { $DataBase = $env:XDG_DATA_HOME } else { $DataBase = Join-Path (Join-Path $HOME ".local") "share" }
    $DbPath = Join-Path (Join-Path $DataBase "opencode-token-monitor") "token-monitor.sqlite"
}
if (Test-Path -LiteralPath $DbPath) { Write-Host "Database: $DbPath" }
else { Write-Host "Database: $DbPath (not created yet; normal before OpenCode has run with the plugin)" }

$Cli = [string]$Record["CLI_PATH"]
if (-not $Cli -or -not (Test-Path -LiteralPath $Cli)) {
    $Found = Get-Command tokenmon -ErrorAction SilentlyContinue
    if ($Found) { $Cli = $Found.Source } else { $Cli = "" }
}
if ($Cli) {
    $CliVersion = "unknown"
    try { $CliVersion = (& $Cli --version | Out-String).Trim() } catch { }
    Write-Host "tokenmon CLI: $Cli ($CliVersion)"
    if ($CliVersion -ne $Version) { Write-Host "Warning: CLI version $CliVersion differs from plugin version $Version" }
} else {
    Write-Host "tokenmon CLI not found (optional; install with install.ps1 -WithCli)."
}

$OpenCode = Get-Command opencode -ErrorAction SilentlyContinue
if ($OpenCode) {
    Write-Host "OpenCode: $($OpenCode.Source)"
    try { & opencode --version } catch { }
} else {
    Write-Host "OpenCode binary not found in PATH. The plugin is installed, but OpenCode itself is not installed by this script."
}

Write-Host "Verification passed."
exit 0
