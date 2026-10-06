# Installs the OpenCode Token Monitor plugin (and optionally the tokenmon CLI) on Windows.
#
#   .\install.ps1                          # bundle next to this script or in dist\ (after `bun run build`)
#   .\install.ps1 -Version 0.1.0           # download a pinned GitHub release and verify its checksum
#   .\install.ps1 -From path\to\opencode-token-monitor.js
#   .\install.ps1 -WithCli                 # also install tokenmon.exe into $HOME\.local\bin (PATH is not modified)
#
# Never modifies opencode.json / opencode.jsonc, never touches OpenCode itself, never creates the database.
# Compatible with Windows PowerShell 5.1 and PowerShell 7 (also runs under pwsh on Linux/macOS).
[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$From = "",
    [switch]$WithCli,
    [string]$CliDir = "",
    [switch]$Force,
    [switch]$IntoLink
)
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:XDG_CONFIG_HOME) { $ConfigBase = $env:XDG_CONFIG_HOME } else { $ConfigBase = Join-Path $HOME ".config" }
$ConfigDir = Join-Path $ConfigBase "opencode"
$PluginsDir = Join-Path $ConfigDir "plugins"
$PluginName = "opencode-token-monitor.js"
$Target = Join-Path $PluginsDir $PluginName
$Marker = Join-Path $ConfigDir ".opencode-token-monitor-install"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $CliDir) {
    if ($env:TOKENMON_BIN_DIR) { $CliDir = $env:TOKENMON_BIN_DIR } else { $CliDir = Join-Path (Join-Path $HOME ".local") "bin" }
}
$OnWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows

function Fail([string]$Message) { Write-Host "Error: $Message" -ForegroundColor Red; exit 1 }

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Install record shared with install.sh / uninstall.sh: one "KEY<TAB>value" per line, UTF-8 without BOM.
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

function Write-Marker([System.Collections.Specialized.OrderedDictionary]$Values) {
    $Text = ($Values.Keys | ForEach-Object { "$_`t$($Values[$_])" }) -join "`n"
    [System.IO.File]::WriteAllText($Marker, $Text + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Test-IsLink([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    return [bool](Get-Item -LiteralPath $Path -Force).LinkType
}

function Get-PlatformBinary {
    if ($OnWindows) {
        if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { Fail "only x64 Windows binaries are published (found $env:PROCESSOR_ARCHITECTURE)" }
        return "tokenmon-windows-x64.exe"
    }
    $Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    if ($Arch -eq "X64") { $A = "x64" } elseif ($Arch -eq "Arm64") { $A = "arm64" } else { Fail "unsupported CPU $Arch" }
    if ($IsMacOS) { return "tokenmon-macos-$A" }
    return "tokenmon-linux-$A"
}

# Verifies $File against checksums.txt in its directory (or the parent) when one exists (required for downloads).
function Test-Checksum([string]$File, [string]$Name, [bool]$Required) {
    $Dir = Split-Path -Parent $File
    $List = Join-Path $Dir "checksums.txt"
    if (-not (Test-Path -LiteralPath $List)) { $List = Join-Path (Split-Path -Parent $Dir) "checksums.txt" }
    if (-not (Test-Path -LiteralPath $List)) {
        if ($Required) { Fail "checksums.txt missing for $Name" }
        Write-Host "Note: no checksums.txt next to $File; checksum not verified."
        return
    }
    $Expected = $null
    foreach ($Line in Get-Content -LiteralPath $List) {
        $Parts = $Line.Trim() -split '\s+', 2
        if ($Parts.Count -eq 2) {
            $Listed = ($Parts[1].TrimStart('*') -split '[\\/]')[-1]
            if ($Listed -eq $Name) { $Expected = $Parts[0].ToLowerInvariant(); break }
        }
    }
    if (-not $Expected) {
        if ($Required) { Fail "checksums.txt has no entry for $Name" }
        Write-Host "Note: checksums.txt has no entry for $Name; checksum not verified."
        return
    }
    if ((Get-Sha256 $File) -ne $Expected) { Fail "SHA-256 mismatch for $Name" }
    Write-Host "Checksum OK: $Name"
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tokenmon-install-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

function Get-ReleaseFile([string]$Name) {
    if ($env:TOKEN_MONITOR_BASE_URL) { $Base = $env:TOKEN_MONITOR_BASE_URL } else { $Base = "https://github.com/codeStruggle/opencode-token-monitor/releases/download/v$Version" }
    $Sums = Join-Path $Tmp "checksums.txt"
    if (-not (Test-Path -LiteralPath $Sums)) { Save-Url "$Base/checksums.txt" $Sums }
    $Out = Join-Path $Tmp $Name
    Save-Url "$Base/$Name" $Out
    return $Out
}

# Invoke-WebRequest has no file:// support; local mirrors (file:// or a plain path) are copied.
function Save-Url([string]$Url, [string]$OutFile) {
    if ($Url -match '^https?://') { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile; return }
    $Path = $Url
    if ($Url -match '^file://') { $Path = ([System.Uri]$Url).LocalPath }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "cannot read $Url" }
    Copy-Item -LiteralPath $Path -Destination $OutFile
}

function Copy-Atomic([string]$Source, [string]$Destination) {
    $Part = "$Destination.tmp-$PID"
    Copy-Item -LiteralPath $Source -Destination $Part -Force
    Move-Item -LiteralPath $Part -Destination $Destination -Force
}

try {
    # --- resolve the plugin bundle ---------------------------------------------------------------
    if ($Version -and $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
        Fail "-Version needs an exact version like 0.1.0 ('latest' is not supported)"
    }
    $RequiredSum = $false
    if ($From) { $Bundle = $From }
    elseif ($Version) { $Bundle = Get-ReleaseFile $PluginName; $RequiredSum = $true }
    elseif (Test-Path -LiteralPath (Join-Path $ScriptDir $PluginName)) { $Bundle = Join-Path $ScriptDir $PluginName }
    elseif (Test-Path -LiteralPath (Join-Path (Join-Path $ScriptDir "dist") $PluginName)) { $Bundle = Join-Path (Join-Path $ScriptDir "dist") $PluginName }
    else { Fail "no plugin bundle found. Run 'bun run build', pass -From FILE, or pass -Version X to download a release." }
    if (-not (Test-Path -LiteralPath $Bundle -PathType Leaf)) { Fail "bundle not found: $Bundle" }

    $Head = @(Get-Content -LiteralPath $Bundle -TotalCount 10)
    if (-not ($Head -contains "// GENERATED FILE")) { Fail "$Bundle is not a Token Monitor release bundle (missing generated-file header)" }
    if (-not ($Head -contains "// DO NOT EDIT")) { Fail "$Bundle is missing the DO NOT EDIT marker" }
    $VersionLine = $Head | Where-Object { $_ -like "// Version: *" } | Select-Object -First 1
    if (-not $VersionLine) { Fail "$Bundle does not declare a version" }
    $BundleVersion = $VersionLine.Substring("// Version: ".Length)
    if ($Version -and $Version -ne $BundleVersion) { Fail "bundle declares $BundleVersion, expected $Version" }
    Test-Checksum $Bundle $PluginName $RequiredSum
    $NewSha = Get-Sha256 $Bundle

    # --- install the plugin ----------------------------------------------------------------------
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    if ((Test-IsLink $PluginsDir) -and -not $IntoLink) {
        Fail "$PluginsDir is a link or junction (probably managed by the portable profile). Update the bundle through the profile's scripts\update-token-monitor.ps1, or pass -IntoLink to write through the link anyway."
    }
    New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null

    $Previous = Read-Marker
    $BackupDir = $Previous["BACKUP_DIR"]
    if (-not $BackupDir -or -not (Test-Path -LiteralPath $BackupDir)) { $BackupDir = Join-Path $ConfigDir ".opencode-token-monitor-backup-$Stamp" }

    function Backup-Item([string]$Path, [string]$Name) {
        New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
        $Dest = Join-Path $BackupDir $Name
        if (Test-Path -LiteralPath $Dest) { $Dest = "$Dest.$Stamp" }
        Move-Item -LiteralPath $Path -Destination $Dest
        Write-Host "Backed up: $Path -> $Dest"
    }

    if (Test-IsLink $Target) {
        Fail "$Target is a link managed elsewhere; refusing to replace it"
    } elseif ((Test-Path -LiteralPath $Target) -and (Get-Sha256 $Target) -eq $NewSha) {
        Write-Host "Already installed: $Target ($BundleVersion)"
    } elseif ((Test-Path -LiteralPath $Target) -and $Previous["PLUGIN_SHA256"] -and (Get-Sha256 $Target) -eq $Previous["PLUGIN_SHA256"]) {
        Copy-Atomic $Bundle $Target
        Write-Host "Updated: $Target -> $BundleVersion"
    } elseif (Test-Path -LiteralPath $Target) {
        if (-not $Force) { Fail "$Target exists and was not installed by this script (or was modified). Re-run with -Force to replace it (a backup is kept)." }
        Backup-Item $Target $PluginName
        Copy-Atomic $Bundle $Target
        Write-Host "Installed: $Target ($BundleVersion)"
    } else {
        Copy-Atomic $Bundle $Target
        Write-Host "Installed: $Target ($BundleVersion)"
    }

    # --- optional CLI ----------------------------------------------------------------------------
    $CliPath = [string]$Previous["CLI_PATH"]
    $CliSha = [string]$Previous["CLI_SHA256"]
    if ($WithCli) {
        $BinName = Get-PlatformBinary
        if ($Version -and -not $From) { $CliSrc = Get-ReleaseFile $BinName; $CliReq = $true }
        elseif (Test-Path -LiteralPath (Join-Path $ScriptDir $BinName)) { $CliSrc = Join-Path $ScriptDir $BinName; $CliReq = $false }
        elseif (Test-Path -LiteralPath (Join-Path (Join-Path (Join-Path $ScriptDir "dist") "bin") $BinName)) { $CliSrc = Join-Path (Join-Path (Join-Path $ScriptDir "dist") "bin") $BinName; $CliReq = $false }
        else { Fail "no $BinName found. Run 'bun run build:binaries' or pass -Version X." }
        Test-Checksum $CliSrc $BinName $CliReq
        $NewCliSha = Get-Sha256 $CliSrc
        New-Item -ItemType Directory -Force -Path $CliDir | Out-Null
        if ($OnWindows) { $CliTarget = Join-Path $CliDir "tokenmon.exe" } else { $CliTarget = Join-Path $CliDir "tokenmon" }
        if (Test-IsLink $CliTarget) {
            Fail "$CliTarget is a link managed elsewhere; refusing to replace it"
        } elseif ((Test-Path -LiteralPath $CliTarget) -and (Get-Sha256 $CliTarget) -eq $NewCliSha) {
            Write-Host "Already installed: $CliTarget"
        } elseif ((Test-Path -LiteralPath $CliTarget) -and $CliTarget -eq $CliPath -and (Get-Sha256 $CliTarget) -eq $CliSha) {
            Copy-Atomic $CliSrc $CliTarget
            Write-Host "Updated: $CliTarget"
        } elseif (Test-Path -LiteralPath $CliTarget) {
            if (-not $Force) { Fail "$CliTarget exists and was not installed by this script. Re-run with -Force to replace it (a backup is kept)." }
            Backup-Item $CliTarget (Split-Path -Leaf $CliTarget)
            Copy-Atomic $CliSrc $CliTarget
            Write-Host "Installed: $CliTarget"
        } else {
            Copy-Atomic $CliSrc $CliTarget
            Write-Host "Installed: $CliTarget"
        }
        if (-not $OnWindows) { & chmod 755 $CliTarget }
        $CliPath = $CliTarget
        $CliSha = $NewCliSha
        $PathSep = [System.IO.Path]::PathSeparator
        if (-not (($env:PATH -split [regex]::Escape([string]$PathSep)) -contains $CliDir)) {
            Write-Host "Note: $CliDir is not on PATH. Add it yourself or call $CliTarget directly."
        }
    }

    $Record = [ordered]@{
        VERSION       = $BundleVersion
        PLUGIN_PATH   = $Target
        PLUGIN_SHA256 = $NewSha
        BACKUP_DIR    = $BackupDir
        CLI_PATH      = $CliPath
        CLI_SHA256    = $CliSha
    }
    Write-Marker $Record

    # --- notes -----------------------------------------------------------------------------------
    foreach ($Cfg in @((Join-Path $ConfigDir "opencode.json"), (Join-Path $ConfigDir "opencode.jsonc"))) {
        if ((Test-Path -LiteralPath $Cfg -PathType Leaf) -and (Select-String -LiteralPath $Cfg -Pattern "opencode-token-monitor" -SimpleMatch -Quiet)) {
            Write-Host "Warning: $Cfg also declares opencode-token-monitor via npm. Only one copy collects per project; consider removing one. (Config not modified.)"
        }
    }

    if ($env:OPENCODE_TOKEN_MONITOR_DB -and $env:OPENCODE_TOKEN_MONITOR_DB.Trim()) { $DbPath = $env:OPENCODE_TOKEN_MONITOR_DB }
    else {
        if ($env:XDG_DATA_HOME) { $DataBase = $env:XDG_DATA_HOME } else { $DataBase = Join-Path (Join-Path $HOME ".local") "share" }
        $DbPath = Join-Path (Join-Path $DataBase "opencode-token-monitor") "token-monitor.sqlite"
    }

    Write-Host ""
    Write-Host "Installed OpenCode Token Monitor $BundleVersion."
    Write-Host "Plugin: $Target"
    if (Test-Path -LiteralPath $BackupDir) { Write-Host "Backup: $BackupDir" }
    Write-Host "Database (created on first use, never removed by uninstall): $DbPath"
    Write-Host "Restart OpenCode to load the plugin. opencode.json and OpenCode itself were not modified."
}
finally {
    Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
