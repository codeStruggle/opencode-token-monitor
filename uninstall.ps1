# Removes what install.ps1 installed (plugin bundle, optional tokenmon CLI) on Windows and restores
# backups. Files modified after installation are preserved. The usage database is NEVER deleted;
# remove it explicitly with `tokenmon data purge --yes` if you want to.
#
#   .\uninstall.ps1           # uses the install record written by install.ps1 / install.sh
#   .\uninstall.ps1 -Force    # no install record: remove a Token Monitor bundle anyway
# Compatible with Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param([switch]$Force)
$ErrorActionPreference = "Stop"

if ($env:XDG_CONFIG_HOME) { $ConfigBase = $env:XDG_CONFIG_HOME } else { $ConfigBase = Join-Path $HOME ".config" }
$ConfigDir = Join-Path $ConfigBase "opencode"
$Target = Join-Path (Join-Path $ConfigDir "plugins") "opencode-token-monitor.js"
$Marker = Join-Path $ConfigDir ".opencode-token-monitor-install"

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

# Removes $Path only if its content still matches $Sha; then restores a backup named $Name if present.
function Remove-Managed([string]$Path, [string]$Sha, [string]$Name, [string]$BackupDir) {
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        $Item = Get-Item -LiteralPath $Path -Force
        if ($Item.LinkType) {
            Write-Host "Preserved link managed elsewhere: $Path"
        } elseif ((Get-Sha256 $Path) -eq $Sha) {
            Remove-Item -LiteralPath $Path -Force
            Write-Host "Removed: $Path"
        } else {
            Write-Host "Preserved modified file: $Path"
        }
    }
    if ($BackupDir -and $Path) {
        $Backup = Join-Path $BackupDir $Name
        if ((Test-Path -LiteralPath $Backup) -and -not (Test-Path -LiteralPath $Path)) {
            Move-Item -LiteralPath $Backup -Destination $Path
            Write-Host "Restored backup: $Path"
        }
    }
}

if ($env:OPENCODE_TOKEN_MONITOR_DB -and $env:OPENCODE_TOKEN_MONITOR_DB.Trim()) { $DbPath = $env:OPENCODE_TOKEN_MONITOR_DB }
else {
    if ($env:XDG_DATA_HOME) { $DataBase = $env:XDG_DATA_HOME } else { $DataBase = Join-Path (Join-Path $HOME ".local") "share" }
    $DbPath = Join-Path (Join-Path $DataBase "opencode-token-monitor") "token-monitor.sqlite"
}

if (Test-Path -LiteralPath $Marker) {
    $Record = Read-Marker
    $BackupDir = [string]$Record["BACKUP_DIR"]
    Remove-Managed ([string]$Record["PLUGIN_PATH"]) ([string]$Record["PLUGIN_SHA256"]) "opencode-token-monitor.js" $BackupDir
    $CliPath = [string]$Record["CLI_PATH"]
    if ($CliPath) { Remove-Managed $CliPath ([string]$Record["CLI_SHA256"]) (Split-Path -Leaf $CliPath) $BackupDir }
    Remove-Item -LiteralPath $Marker -Force
    if ($BackupDir -and (Test-Path -LiteralPath $BackupDir)) {
        if (@(Get-ChildItem -LiteralPath $BackupDir -Force).Count -eq 0) { Remove-Item -LiteralPath $BackupDir -Force }
        else { Write-Host "Backup directory kept (not empty): $BackupDir" }
    }
} elseif ((Test-Path -LiteralPath $Target -PathType Leaf) -and -not (Get-Item -LiteralPath $Target -Force).LinkType) {
    $Head = @(Get-Content -LiteralPath $Target -TotalCount 10)
    if ($Force -and ($Head -contains "// GENERATED FILE")) {
        Remove-Item -LiteralPath $Target -Force
        Write-Host "Removed: $Target"
    } else {
        Write-Host "No install record found; $Target was installed another way (e.g. the portable profile). Left in place; use -Force to remove it."
    }
} else {
    Write-Host "Nothing to uninstall."
}

Write-Host ""
Write-Host "OpenCode Token Monitor uninstalled."
Write-Host "Usage history kept: $DbPath (delete explicitly with: tokenmon data purge --yes)"
Write-Host "opencode.json and OpenCode itself were not modified."
