#!/usr/bin/env bash
# Updates the pinned opencode-token-monitor bundle in the portable profile.
# Usage: scripts/update-token-monitor.sh <version> [--tested-with <opencode-version>]...
# Env:   TOKEN_MONITOR_BASE_URL overrides the release download location (default: GitHub release v<version>).
# Never tracks "latest", never commits or pushes. On any failure the previous bundle and manifest stay in place.
set -euo pipefail

usage() { echo "usage: $0 <version> [--tested-with <opencode-version>]..." >&2; exit 2; }
[ $# -ge 1 ] || usage
VERSION="$1"; shift
TESTED=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tested-with) [ $# -ge 2 ] || usage; TESTED+=("$2"); shift 2 ;;
    *) usage ;;
  esac
done
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: an explicit version like 0.1.0 is required (got '$VERSION'); 'latest' is not supported" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/profile/plugins/opencode-token-monitor.js"
MANIFEST="$ROOT/integrations/token-monitor/manifest.json"
BASE_URL="${TOKEN_MONITOR_BASE_URL:-https://github.com/codeStruggle/opencode-token-monitor/releases/download/v$VERSION}"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading $BASE_URL/{opencode-token-monitor.js,checksums.txt}"
curl -fsSL "$BASE_URL/opencode-token-monitor.js" -o "$TMP/opencode-token-monitor.js"
curl -fsSL "$BASE_URL/checksums.txt" -o "$TMP/checksums.txt"

EXPECTED="$(awk '$2 == "opencode-token-monitor.js" { print $1 }' "$TMP/checksums.txt")"
ACTUAL="$(sha256 "$TMP/opencode-token-monitor.js")"
if [ -z "$EXPECTED" ]; then echo "error: checksums.txt has no entry for opencode-token-monitor.js" >&2; exit 1; fi
if [ "$EXPECTED" != "$ACTUAL" ]; then echo "error: sha256 mismatch (expected $EXPECTED, got $ACTUAL)" >&2; exit 1; fi
if ! head -n 8 "$TMP/opencode-token-monitor.js" | grep -qx "// Version: $VERSION"; then
  echo "error: downloaded bundle does not declare version $VERSION" >&2; exit 1
fi
SCHEMA="$(head -n 8 "$TMP/opencode-token-monitor.js" | sed -n 's#^// DB schema: \([0-9][0-9]*\)$#\1#p')"
if [ -z "$SCHEMA" ]; then echo "error: downloaded bundle does not declare its database schema version" >&2; exit 1; fi
# The checksum proves the file matches the published checksum list, not who published it.

OLD_VERSION="(none)"
OLD_SCHEMA=""
if [ -f "$MANIFEST" ]; then
  OLD_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$MANIFEST" | head -n1)"
  OLD_SCHEMA="$(sed -n 's/.*"dbSchemaVersion": *\([0-9][0-9]*\).*/\1/p' "$MANIFEST" | head -n1)"
fi
mkdir -p "$(dirname "$BUNDLE")" "$(dirname "$MANIFEST")"
for f in "$BUNDLE" "$MANIFEST"; do [ -f "$f" ] && cp -p "$f" "$TMP/$(basename "$f").bak"; done
restore() {
  echo "restoring previous bundle and manifest" >&2
  if [ -f "$TMP/opencode-token-monitor.js.bak" ]; then cp -p "$TMP/opencode-token-monitor.js.bak" "$BUNDLE"; else rm -f "$BUNDLE"; fi
  if [ -f "$TMP/manifest.json.bak" ]; then cp -p "$TMP/manifest.json.bak" "$MANIFEST"; else rm -f "$MANIFEST"; fi
}

tested_json=""
for v in "${TESTED[@]+"${TESTED[@]}"}"; do tested_json="${tested_json:+$tested_json, }\"$v\""; done
cp "$TMP/opencode-token-monitor.js" "$BUNDLE"
cat > "$MANIFEST" <<JSON
{
  "name": "opencode-token-monitor",
  "version": "$VERSION",
  "source": "https://github.com/codeStruggle/opencode-token-monitor",
  "artifact": "profile/plugins/opencode-token-monitor.js",
  "sha256": "$ACTUAL",
  "dbSchemaVersion": $SCHEMA,
  "testedWith": {
    "opencode": [$tested_json]
  }
}
JSON

VERIFY="$ROOT/scripts/verify-token-monitor.sh"
if [ -x "$VERIFY" ] && ! "$VERIFY"; then restore; exit 1; fi
if [ -x "$ROOT/verify.sh" ] && ! "$ROOT/verify.sh"; then restore; exit 1; fi

echo "updated opencode-token-monitor: $OLD_VERSION -> $VERSION"
if [ -n "$OLD_SCHEMA" ] && [ "$OLD_SCHEMA" != "$SCHEMA" ]; then echo "database schema: $OLD_SCHEMA -> $SCHEMA"; fi
if [ -n "$OLD_SCHEMA" ] && [ "$SCHEMA" -lt "$OLD_SCHEMA" ]; then
  echo "warning: this is a schema downgrade. Databases already migrated by the newer plugin make this plugin stop writing (data is kept); upgrade again to resume collection." >&2
fi
echo "sha256: $ACTUAL"
[ -n "$tested_json" ] || echo "note: testedWith.opencode is empty; add --tested-with <version> only for versions you actually tested"
echo "review the changes with git diff; nothing was committed"
