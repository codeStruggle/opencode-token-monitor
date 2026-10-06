#!/usr/bin/env bash
# Verifies the pinned opencode-token-monitor bundle against its manifest.
# A missing Token Monitor database or CLI is normal and never a failure.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/integrations/token-monitor/manifest.json"
fail() { echo "token-monitor: $*" >&2; exit 1; }
[ -f "$MANIFEST" ] || fail "manifest missing: $MANIFEST"
field() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$MANIFEST" | head -n1; }
VERSION="$(field version)"; SHA="$(field sha256)"; ARTIFACT="$(field artifact)"
[ -n "$VERSION" ] && [ "$VERSION" != "latest" ] || fail "manifest must pin an exact version"
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || fail "manifest sha256 is not a real hash"
BUNDLE="$ROOT/$ARTIFACT"
[ -f "$BUNDLE" ] || fail "bundle missing: $BUNDLE"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$BUNDLE" | cut -d' ' -f1)"; else ACTUAL="$(shasum -a 256 "$BUNDLE" | cut -d' ' -f1)"; fi
[ "$ACTUAL" = "$SHA" ] || fail "bundle sha256 $ACTUAL does not match manifest $SHA (generated file was modified?)"
head -n 8 "$BUNDLE" | grep -qx "// Version: $VERSION" || fail "bundle header does not declare version $VERSION"
head -n 8 "$BUNDLE" | grep -qx "// DO NOT EDIT" || fail "bundle is missing the generated-file header"
echo "token-monitor: ok ($VERSION, $SHA)"
