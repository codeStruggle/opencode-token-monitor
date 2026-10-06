#!/usr/bin/env bash
# Installs the OpenCode Token Monitor plugin (and optionally the tokenmon CLI) for Linux and macOS.
#
#   bash install.sh                      # bundle next to this script or in dist/ (after `bun run build`)
#   bash install.sh --version 0.1.0      # download a pinned GitHub release and verify its checksum
#   bash install.sh --from path/to/opencode-token-monitor.js
#   bash install.sh --with-cli           # also install tokenmon into ~/.local/bin (PATH is not modified)
#
# Never modifies opencode.json / opencode.jsonc, never touches OpenCode itself, never creates the database.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_BASE/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
PLUGIN_NAME="opencode-token-monitor.js"
TARGET="$PLUGINS_DIR/$PLUGIN_NAME"
MARKER="$CONFIG_DIR/.opencode-token-monitor-install"
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE_BASE="${TOKEN_MONITOR_BASE_URL:-}"

VERSION=""
FROM=""
WITH_CLI=0
CLI_DIR="${TOKENMON_BIN_DIR:-$HOME/.local/bin}"
FORCE=0
INTO_LINK=0

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo "Options: --version X | --from FILE | --with-cli | --cli-dir DIR | --force | --into-link"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) [[ $# -ge 2 ]] || usage; VERSION="$2"; shift 2 ;;
    --from) [[ $# -ge 2 ]] || usage; FROM="$2"; shift 2 ;;
    --with-cli) WITH_CLI=1; shift ;;
    --cli-dir) [[ $# -ge 2 ]] || usage; CLI_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --into-link) INTO_LINK=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

fail() { echo "Error: $*" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

marker_get() {
  [[ -f "$MARKER" ]] || return 0
  awk -F '\t' -v k="$1" '$1==k{sub($1 FS,""); print}' "$MARKER"
}

platform_binary() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) fail "unsupported OS $(uname -s); use install.ps1 on Windows" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "unsupported CPU $(uname -m)" ;;
  esac
  echo "tokenmon-$os-$arch"
}

# Verifies $1 against checksums.txt in its directory (or the parent) when one exists (required for downloads).
check_sum() {
  local file="$1" name="$2" required="$3" list expected dir
  dir="$(dirname -- "$file")"
  list="$dir/checksums.txt"
  # A build checkout keeps one list for dist/ (entries like bin/tokenmon-linux-x64).
  [[ -f "$list" ]] || list="$(dirname -- "$dir")/checksums.txt"
  if [[ ! -f "$list" ]]; then
    [[ "$required" == 1 ]] && fail "checksums.txt missing for $name"
    echo "Note: no checksums.txt next to $file; checksum not verified."
    return 0
  fi
  expected="$(awk -v n="$name" '{ f=$2; sub(/^\*/, "", f); sub(/^.*\//, "", f) } f==n { print $1; exit }' "$list")"
  if [[ -z "$expected" ]]; then
    [[ "$required" == 1 ]] && fail "checksums.txt has no entry for $name"
    echo "Note: checksums.txt has no entry for $name; checksum not verified."
    return 0
  fi
  [[ "$(sha256 "$file")" == "$expected" ]] || fail "SHA-256 mismatch for $name"
  echo "Checksum OK: $name"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download() {
  local name="$1" base
  [[ -n "$VERSION" ]] || fail "internal: download without version"
  base="${RELEASE_BASE:-https://github.com/codeStruggle/opencode-token-monitor/releases/download/v$VERSION}"
  [[ -f "$TMP/checksums.txt" ]] || curl -fsSL "$base/checksums.txt" -o "$TMP/checksums.txt" || fail "cannot download $base/checksums.txt"
  curl -fsSL "$base/$name" -o "$TMP/$name" || fail "cannot download $base/$name"
  echo "$TMP/$name"
}

# --- resolve the plugin bundle -------------------------------------------------------------------
if [[ -n "$VERSION" && ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  fail "--version needs an exact version like 0.1.0 ('latest' is not supported)"
fi
REQUIRED_SUM=0
if [[ -n "$FROM" ]]; then
  BUNDLE="$FROM"
elif [[ -n "$VERSION" ]]; then
  BUNDLE="$(download "$PLUGIN_NAME")"
  REQUIRED_SUM=1
elif [[ -f "$SCRIPT_DIR/$PLUGIN_NAME" ]]; then
  BUNDLE="$SCRIPT_DIR/$PLUGIN_NAME"
elif [[ -f "$SCRIPT_DIR/dist/$PLUGIN_NAME" ]]; then
  BUNDLE="$SCRIPT_DIR/dist/$PLUGIN_NAME"
else
  fail "no plugin bundle found. Run 'bun run build', pass --from FILE, or pass --version X to download a release."
fi
[[ -f "$BUNDLE" ]] || fail "bundle not found: $BUNDLE"

HEAD="$(head -n 10 "$BUNDLE")"
grep -qx "// GENERATED FILE" <<<"$HEAD" || fail "$BUNDLE is not a Token Monitor release bundle (missing generated-file header)"
grep -qx "// DO NOT EDIT" <<<"$HEAD" || fail "$BUNDLE is missing the DO NOT EDIT marker"
BUNDLE_VERSION="$(sed -n 's#^// Version: ##p' <<<"$HEAD" | head -n1)"
[[ -n "$BUNDLE_VERSION" ]] || fail "$BUNDLE does not declare a version"
[[ -z "$VERSION" || "$VERSION" == "$BUNDLE_VERSION" ]] || fail "bundle declares $BUNDLE_VERSION, expected $VERSION"
check_sum "$BUNDLE" "$PLUGIN_NAME" "$REQUIRED_SUM"
NEW_SHA="$(sha256 "$BUNDLE")"

# --- install the plugin --------------------------------------------------------------------------
mkdir -p "$CONFIG_DIR"
if [[ -L "$PLUGINS_DIR" && "$INTO_LINK" != 1 ]]; then
  fail "$PLUGINS_DIR is a link (probably managed by the portable profile). Update the bundle through the profile's scripts/update-token-monitor.sh, or pass --into-link to write through the link anyway."
fi
mkdir -p "$PLUGINS_DIR"

BACKUP_DIR="$(marker_get BACKUP_DIR)"
if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then BACKUP_DIR="$CONFIG_DIR/.opencode-token-monitor-backup-$STAMP"; fi
PREV_PLUGIN_SHA="$(marker_get PLUGIN_SHA256)"

backup() {
  local path="$1" name="$2"
  mkdir -p "$BACKUP_DIR"
  [[ -e "$BACKUP_DIR/$name" ]] && name="$name.$STAMP"
  mv "$path" "$BACKUP_DIR/$name"
  echo "Backed up: $path -> $BACKUP_DIR/$name"
}

place() {
  local src="$1" dst="$2" mode="$3"
  cp "$src" "$dst.tmp-$$"
  chmod "$mode" "$dst.tmp-$$"
  mv -f "$dst.tmp-$$" "$dst"
}

if [[ -L "$TARGET" ]]; then
  fail "$TARGET is a symlink managed elsewhere; refusing to replace it"
elif [[ -f "$TARGET" && "$(sha256 "$TARGET")" == "$NEW_SHA" ]]; then
  echo "Already installed: $TARGET ($BUNDLE_VERSION)"
elif [[ -f "$TARGET" && -n "$PREV_PLUGIN_SHA" && "$(sha256 "$TARGET")" == "$PREV_PLUGIN_SHA" ]]; then
  place "$BUNDLE" "$TARGET" 644
  echo "Updated: $TARGET -> $BUNDLE_VERSION"
elif [[ -e "$TARGET" ]]; then
  [[ "$FORCE" == 1 ]] || fail "$TARGET exists and was not installed by this script (or was modified). Re-run with --force to replace it (a backup is kept)."
  backup "$TARGET" "$PLUGIN_NAME"
  place "$BUNDLE" "$TARGET" 644
  echo "Installed: $TARGET ($BUNDLE_VERSION)"
else
  place "$BUNDLE" "$TARGET" 644
  echo "Installed: $TARGET ($BUNDLE_VERSION)"
fi

# --- optional CLI -------------------------------------------------------------------------------
CLI_PATH="$(marker_get CLI_PATH)"
CLI_SHA="$(marker_get CLI_SHA256)"
if [[ "$WITH_CLI" == 1 ]]; then
  BIN_NAME="$(platform_binary)"
  if [[ -n "$VERSION" && -z "$FROM" ]]; then
    CLI_SRC="$(download "$BIN_NAME")"; CLI_REQ=1
  elif [[ -f "$SCRIPT_DIR/$BIN_NAME" ]]; then
    CLI_SRC="$SCRIPT_DIR/$BIN_NAME"; CLI_REQ=0
  elif [[ -f "$SCRIPT_DIR/dist/bin/$BIN_NAME" ]]; then
    CLI_SRC="$SCRIPT_DIR/dist/bin/$BIN_NAME"; CLI_REQ=0
  else
    fail "no $BIN_NAME found. Run 'bun run build:binaries' or pass --version X."
  fi
  check_sum "$CLI_SRC" "$BIN_NAME" "$CLI_REQ"
  NEW_CLI_SHA="$(sha256 "$CLI_SRC")"
  mkdir -p "$CLI_DIR"
  CLI_TARGET="$CLI_DIR/tokenmon"
  if [[ -L "$CLI_TARGET" ]]; then
    fail "$CLI_TARGET is a symlink managed elsewhere; refusing to replace it"
  elif [[ -f "$CLI_TARGET" && "$(sha256 "$CLI_TARGET")" == "$NEW_CLI_SHA" ]]; then
    echo "Already installed: $CLI_TARGET"
  elif [[ -f "$CLI_TARGET" && "$CLI_TARGET" == "$CLI_PATH" && "$(sha256 "$CLI_TARGET")" == "$CLI_SHA" ]]; then
    place "$CLI_SRC" "$CLI_TARGET" 755
    echo "Updated: $CLI_TARGET"
  elif [[ -e "$CLI_TARGET" ]]; then
    [[ "$FORCE" == 1 ]] || fail "$CLI_TARGET exists and was not installed by this script. Re-run with --force to replace it (a backup is kept)."
    backup "$CLI_TARGET" "tokenmon"
    place "$CLI_SRC" "$CLI_TARGET" 755
    echo "Installed: $CLI_TARGET"
  else
    place "$CLI_SRC" "$CLI_TARGET" 755
    echo "Installed: $CLI_TARGET"
  fi
  CLI_PATH="$CLI_TARGET"
  CLI_SHA="$NEW_CLI_SHA"
  case ":$PATH:" in
    *":$CLI_DIR:"*) ;;
    *) echo "Note: $CLI_DIR is not on PATH. Add it yourself or call $CLI_TARGET directly." ;;
  esac
fi

{
  printf 'VERSION\t%s\n' "$BUNDLE_VERSION"
  printf 'PLUGIN_PATH\t%s\n' "$TARGET"
  printf 'PLUGIN_SHA256\t%s\n' "$NEW_SHA"
  printf 'BACKUP_DIR\t%s\n' "$BACKUP_DIR"
  printf 'CLI_PATH\t%s\n' "$CLI_PATH"
  printf 'CLI_SHA256\t%s\n' "$CLI_SHA"
} > "$MARKER"

# --- notes ---------------------------------------------------------------------------------------
for cfg in "$CONFIG_DIR/opencode.json" "$CONFIG_DIR/opencode.jsonc"; do
  if [[ -f "$cfg" ]] && grep -q 'opencode-token-monitor' "$cfg"; then
    echo "Warning: $cfg also declares opencode-token-monitor via npm. Only one copy collects per project; consider removing one. (Config not modified.)"
  fi
done

DB_PATH="${OPENCODE_TOKEN_MONITOR_DB:-}"
[[ -n "${DB_PATH// /}" ]] || DB_PATH="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-token-monitor/token-monitor.sqlite"

echo
echo "Installed OpenCode Token Monitor $BUNDLE_VERSION."
echo "Plugin: $TARGET"
[[ -d "$BACKUP_DIR" ]] && echo "Backup: $BACKUP_DIR"
echo "Database (created on first use, never removed by uninstall): $DB_PATH"
echo "Restart OpenCode to load the plugin. opencode.json and OpenCode itself were not modified."
