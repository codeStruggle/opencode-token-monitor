# Compatibility matrix

Status values: **tested** (run and observed, evidence linked), **known incompatible**, **unknown**
(not run). Nothing is claimed beyond this table.

## Token Monitor 0.1.0

| Component | Version / platform | Scope | Status | Evidence |
| --- | --- | --- | --- | --- |
| OpenCode plugin (local bundle) | OpenCode 1.18.34, Linux x64 | load, collect, duplicate guard, abort, restart, reconciliation | tested | `tests/e2e/run-e2e.ts` (20/20 checks) |
| OpenCode plugin (npm package form) | OpenCode 1.18.34, Linux x64 | install from packed tarball, load, collect | tested | manual run, see `docs/IMPLEMENTATION_STATUS.md` |
| OpenCode plugin (npm registry) | any | — | unknown | package not published |
| OpenCode plugin | OpenCode < 1.18 or > 1.18.34 | — | unknown | |
| OpenCode plugin | macOS, Windows | — | unknown | |
| Importer | OpenCode 1.18.34 SQLite storage | backfill, reconciliation | tested | `tests/integration/import.test.ts`, E2E |
| Importer | OpenCode JSON-file storage (older versions) | — | known incompatible | importer requires `project/session/message/part` tables |
| npm CLI | Node 22.22, Linux x64 (`node:sqlite`) | import, summary, doctor | tested | `tests/node/cli.test.mjs` |
| npm CLI | Node < 22.13 | — | known incompatible | no `node:sqlite` |
| npm CLI | Bun 1.4.2, Linux x64 and macOS arm64 | all commands | tested | `tests/integration/cli.test.ts`, CI run 37468216050 |
| npm CLI | Node 22, macOS arm64 (`node:sqlite`) | import, summary, doctor | tested | CI run 37468216050, job `test (macos-latest)` |
| Standalone `tokenmon-linux-x64` | Linux x64, no Bun on PATH | version, summary, doctor, embedded bundle | tested | manual smoke test |
| Standalone `tokenmon-linux-arm64` | — | cross-compiled only | unknown | |
| Standalone `tokenmon-macos-arm64` | macOS arm64 (GitHub runner), no Bun on PATH | version, doctor | tested | CI run 37468216050, job `test (macos-latest)` |
| Standalone `tokenmon-macos-x64` | — | cross-compiled only, unsigned | unknown | |
| Standalone `tokenmon-windows-x64.exe` | Windows x64 (GitHub runner) | `--version` (also via verify.ps1) | tested | CI run 37468216050, job `windows` |
| Profile scripts (bash) | bash 5, GNU coreutils, curl | update, verify, restore on failure | tested | `tests/integration/profile-scripts.test.ts` |
| Profile scripts (PowerShell) | PowerShell 7.4.6 on Linux | update, verify, restore on failure | tested | `tests/integration/profile-scripts.test.ts` |
| Profile scripts (PowerShell) | Windows PowerShell 5.1 / Windows | — | unknown | |
| `install/verify/uninstall.sh` | bash 5, GNU coreutils, Linux x64 | install, upgrade, backup/restore, link refusal, download + checksum, CLI, uninstall | tested | `tests/integration/installers.test.ts` |
| `install/verify/uninstall.sh` | macOS arm64 (GitHub runner, BSD tools) | same scenarios as Linux | tested | CI run 37468216050, job `test (macos-latest)` |
| `install/verify/uninstall.ps1` | PowerShell 7.4.6 on Linux | same scenarios as bash, plus record shared with bash | tested | `tests/integration/installers.test.ts` |
| `install/verify/uninstall.ps1` | Windows PowerShell 5.1, Windows x64 | install with CLI, verify, uninstall (database kept) | tested | CI run 37468216050, job `windows` |
| `install/verify/uninstall.ps1` | Windows with a junction-linked `plugins/` | link refusal | unknown | covered only with symlinks on Linux |
| Real providers (Anthropic, OpenAI, …) | — | field mapping, cost, cache | unknown | only the OpenAI-compatible adapter via a mock was observed |
