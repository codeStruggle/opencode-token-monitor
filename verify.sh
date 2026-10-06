#!/usr/bin/env bash
# Verifies the OpenCode Token Monitor installation on Linux and macOS.
# A missing database or CLI is normal (nothing recorded yet / CLI not installed) and never a failure.
set -euo pipefail

CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_BASE/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
TARGET="$PLUGINS_DIR/opencode-token-monitor.js"
MARKER="$CONFIG_DIR/.opencode-token-monitor-install"

fail() { echo "Error: $*" >&2; exit 1; }
warn() { echo "Warning: $*"; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
marker_get() {
  [[ -f "$MARKER" ]] || return 0
  awk -F '\t' -v k="$1" '$1==k{sub($1 FS,""); print}' "$MARKER"
}

echo "OpenCode config directory: $CONFIG_DIR"
[[ -L "$PLUGINS_DIR" ]] && echo "Plugins directory is a link (e.g. portable profile): $PLUGINS_DIR"
[[ -f "$TARGET" ]] || fail "plugin missing: $TARGET"

HEAD="$(head -n 10 "$TARGET")"
grep -qx "// GENERATED FILE" <<<"$HEAD" || fail "$TARGET has no generated-file header"
grep -qx "// DO NOT EDIT" <<<"$HEAD" || fail "$TARGET has no DO NOT EDIT marker"
VERSION="$(sed -n 's#^// Version: ##p' <<<"$HEAD" | head -n1)"
SCHEMA="$(sed -n 's#^// DB schema: ##p' <<<"$HEAD" | head -n1)"
[[ -n "$VERSION" ]] || fail "$TARGET does not declare a version"
echo "Plugin: $TARGET (version $VERSION, DB schema ${SCHEMA:-unknown})"

ACTUAL="$(sha256 "$TARGET")"
EXPECTED="$(marker_get PLUGIN_SHA256)"
if [[ -n "$EXPECTED" ]]; then
  [[ "$ACTUAL" == "$EXPECTED" ]] || fail "plugin SHA-256 $ACTUAL differs from the installed $EXPECTED (file modified after install?)"
  echo "Plugin checksum matches install record."
else
  echo "No install record from install.sh (installed another way, e.g. the portable profile); checksum: $ACTUAL"
fi

for cfg in "$CONFIG_DIR/opencode.json" "$CONFIG_DIR/opencode.jsonc"; do
  if [[ -f "$cfg" ]] && grep -q 'opencode-token-monitor' "$cfg"; then
    warn "$cfg also declares opencode-token-monitor via npm; only one copy collects per project."
  fi
done
if [[ -f "$PWD/.opencode/plugins/opencode-token-monitor.js" ]]; then
  warn "this project also has .opencode/plugins/opencode-token-monitor.js; only one copy collects."
fi

DB_PATH="${OPENCODE_TOKEN_MONITOR_DB:-}"
[[ -n "${DB_PATH// /}" ]] || DB_PATH="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-token-monitor/token-monitor.sqlite"
if [[ -f "$DB_PATH" ]]; then
  echo "Database: $DB_PATH"
else
  echo "Database: $DB_PATH (not created yet; normal before OpenCode has run with the plugin)"
fi

CLI="$(marker_get CLI_PATH)"
if [[ -z "$CLI" || ! -x "$CLI" ]]; then CLI="$(command -v tokenmon || true)"; fi
if [[ -n "$CLI" ]]; then
  CLI_VERSION="$("$CLI" --version 2>/dev/null || echo unknown)"
  echo "tokenmon CLI: $CLI ($CLI_VERSION)"
  [[ "$CLI_VERSION" == "$VERSION" ]] || warn "CLI version $CLI_VERSION differs from plugin version $VERSION"
else
  echo "tokenmon CLI not found (optional; install with install.sh --with-cli)."
fi

if command -v opencode >/dev/null 2>&1; then
  echo "OpenCode: $(command -v opencode)"
  opencode --version </dev/null || true
else
  echo "OpenCode binary not found in PATH. The plugin is installed, but OpenCode itself is not installed by this script."
fi

echo "Verification passed."
