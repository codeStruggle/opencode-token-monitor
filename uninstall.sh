#!/usr/bin/env bash
# Removes what install.sh installed (plugin bundle, optional tokenmon CLI) on Linux and macOS and
# restores backups. Files modified after installation are preserved. The usage database is NEVER
# deleted; remove it explicitly with `tokenmon data purge --yes` if you want to.
#
#   bash uninstall.sh            # uses the install record written by install.sh
#   bash uninstall.sh --force    # no install record: remove a Token Monitor bundle anyway
set -euo pipefail

CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_BASE/opencode"
TARGET="$CONFIG_DIR/plugins/opencode-token-monitor.js"
MARKER="$CONFIG_DIR/.opencode-token-monitor-install"
FORCE=0

case "${1:-}" in
  "") ;;
  --force) FORCE=1 ;;
  *) echo "Usage: $0 [--force]" >&2; exit 2 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
marker_get() {
  [[ -f "$MARKER" ]] || return 0
  awk -F '\t' -v k="$1" '$1==k{sub($1 FS,""); print}' "$MARKER"
}

# Removes $1 only if its content still matches $2; then restores a backup named $3 if present.
remove_managed() {
  local path="$1" sha="$2" name="$3" backup_dir="$4"
  if [[ -L "$path" ]]; then
    echo "Preserved symlink managed elsewhere: $path"
  elif [[ -f "$path" ]]; then
    if [[ "$(sha256 "$path")" == "$sha" ]]; then
      rm -f "$path"
      echo "Removed: $path"
    else
      echo "Preserved modified file: $path"
    fi
  fi
  if [[ -n "$backup_dir" && -e "$backup_dir/$name" && ! -e "$path" && ! -L "$path" ]]; then
    mv "$backup_dir/$name" "$path"
    echo "Restored backup: $path"
  fi
}

DB_PATH="${OPENCODE_TOKEN_MONITOR_DB:-}"
[[ -n "${DB_PATH// /}" ]] || DB_PATH="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-token-monitor/token-monitor.sqlite"

if [[ -f "$MARKER" ]]; then
  BACKUP_DIR="$(marker_get BACKUP_DIR)"
  remove_managed "$(marker_get PLUGIN_PATH)" "$(marker_get PLUGIN_SHA256)" "opencode-token-monitor.js" "$BACKUP_DIR"
  CLI_PATH="$(marker_get CLI_PATH)"
  [[ -n "$CLI_PATH" ]] && remove_managed "$CLI_PATH" "$(marker_get CLI_SHA256)" "tokenmon" "$BACKUP_DIR"
  rm -f "$MARKER"
  if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
    rmdir "$BACKUP_DIR" 2>/dev/null || echo "Backup directory kept (not empty): $BACKUP_DIR"
  fi
elif [[ -f "$TARGET" && ! -L "$TARGET" ]]; then
  if [[ "$FORCE" == 1 ]] && head -n 10 "$TARGET" | grep -qx "// GENERATED FILE"; then
    rm -f "$TARGET"
    echo "Removed: $TARGET"
  else
    echo "No install record found; $TARGET was installed another way (e.g. the portable profile). Left in place; use --force to remove it."
  fi
else
  echo "Nothing to uninstall."
fi

echo
echo "OpenCode Token Monitor uninstalled."
echo "Usage history kept: $DB_PATH (delete explicitly with: tokenmon data purge --yes)"
echo "opencode.json and OpenCode itself were not modified."
