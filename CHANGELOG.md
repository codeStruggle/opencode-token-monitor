# Changelog

All notable changes. Versions follow semver; the JSON output contract has its own `schemaVersion`.

## 0.1.0 — unreleased

First implementation of plan A.

- OpenCode plugin (single-file bundle) recording per-step usage, cost source, sessions, child-session
  links, commands, tools, context estimates, Git state and configuration fingerprints into SQLite.
- Process-wide duplicate-load guard, non-blocking batched writes, hook isolation, schema-version guard.
- `tokenmon import`: backfill and reconciliation from OpenCode's own database (read-only).
- `tokenmon` CLI: summary and named ranges, sessions, trace, commands, tools, context, cache, trend,
  compare, live, doctor, install-plugin, data prune/vacuum/purge; `--json` (schemaVersion 1.0.0),
  `--csv`, `--redact-paths`, `--tz`.
- Database schema version 1.
- Build of plugin bundle, npm CLI (Node ≥ 22.13) and standalone binaries; release workflow.
- `install` / `verify` / `uninstall` scripts for Linux/macOS (bash) and Windows (PowerShell), modelled on
  the portable profile's installers, with a shared install record, backups and checksum-verified downloads.
- Portable-profile integration kit (update/verify scripts, manifest example).
- Licensed under MIT.
- Verified against OpenCode 1.18.34 on Linux x64 (see `docs/COMPATIBILITY.md`).
