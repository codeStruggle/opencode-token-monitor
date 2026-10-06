# Portable profile integration kit

Files in this directory are **for the `codeStruggle/opencode-portable-profile` repository**. They are
kept here because Token Monitor's repository is the only place its release format is defined; the
profile copies them once and then only consumes pinned release bundles.

They have not yet been applied to the actual profile repository (no access from the session that
wrote them), so the profile's own `verify.sh` / installer conventions still need to be checked when
copying.

## What goes where in the profile

| File here | Destination in the profile |
| --- | --- |
| `scripts/update-token-monitor.sh` | `scripts/update-token-monitor.sh` |
| `scripts/update-token-monitor.ps1` | `scripts/update-token-monitor.ps1` |
| `scripts/verify-token-monitor.sh` | `scripts/verify-token-monitor.sh` (call from `verify.sh`) |
| `scripts/verify-token-monitor.ps1` | `scripts/verify-token-monitor.ps1` (call from `verify.ps1`) |
| `integrations/token-monitor/manifest.example.json` | reference only; `manifest.json` is written by the update script |
| — | `profile/plugins/opencode-token-monitor.js` (written by the update script) |

## First integration

```bash
scripts/update-token-monitor.sh 0.1.0 --tested-with <opencode version you tested>
git diff   # review: new bundle + manifest
```

```powershell
scripts/update-token-monitor.ps1 -Version 0.1.0 -TestedWith <opencode version you tested>
```

The update script:

1. requires an explicit version (no `latest`);
2. downloads `opencode-token-monitor.js` and `checksums.txt` from the GitHub release `v<version>`
   (override with `TOKEN_MONITOR_BASE_URL`) into a temporary directory;
3. checks the SHA-256 against `checksums.txt`, the `// Version:` header and the `// DB schema:` header;
   on any failure nothing in the profile changes;
4. writes the bundle and `integrations/token-monitor/manifest.json`, then runs
   `scripts/verify-token-monitor.sh` and the profile's `verify.sh`; if either fails, the previous
   bundle and manifest are restored;
5. prints old → new version (and schema), warns on a schema downgrade, never commits or pushes.

A SHA-256 match only proves the file equals the published checksum list, not who published it.

## verify.sh / verify.ps1 additions

Call the verify script from the profile's existing checks:

```bash
"$ROOT/scripts/verify-token-monitor.sh"
```

It checks: manifest present and pinned, bundle present, bundle SHA-256 equals the manifest, header
declares the manifest version and the generated-file marker. It does **not** require the Token Monitor
database or CLI to exist — both are absent on a fresh machine and that is fine.

## Installer / uninstaller

- If the installer already links or copies `profile/plugins/` into the global OpenCode config, the
  bundle is installed with no further change (OpenCode loads every file in `plugins/`).
- Do not add `opencode-token-monitor` to `opencode.json` / `opencode.jsonc`; the plugin is loaded by
  OpenCode's native global plugin directory.
- The uninstaller must not delete the Token Monitor database
  (`${XDG_DATA_HOME:-~/.local/share}/opencode-token-monitor/`). Deleting history is a separate,
  explicit `tokenmon data purge --yes`.

## README additions (suggested text)

> **Token Monitor.** The profile ships a pinned, generated build of
> [opencode-token-monitor](https://github.com/codeStruggle/opencode-token-monitor) in
> `profile/plugins/opencode-token-monitor.js` (see `integrations/token-monitor/manifest.json`). It records
> token usage into a local SQLite database outside this repository. Do not edit the bundle; update it with
> `scripts/update-token-monitor.sh <version>`. Query the data with the separate `tokenmon` CLI, which the
> profile does not install.
