# Handoff — 2026-10-06

## Done
- Phase 0 spike against OpenCode 1.18.34 (`docs/API_SPIKE.md`), fixtures captured and redacted.
- Plugin, collector, repository, migrations, importer, analytics, CLI, build, workflows, docs.
- Verification (all run on Linux x64): typecheck; `bun run test`; Node CLI test; real-OpenCode E2E
  (20/20); npm-form plugin load from a packed tarball; linux-x64 standalone binary without Bun.

## Key decisions
- Hybrid collection: plugin live + OpenCode `opencode.db` as reconciliation/backfill baseline.
- Usage only from `step-finish` parts (dedup key = part id); cost = OpenCode list price
  (`host_computed`), zero cost with tokens and no known price → `unavailable`.
- Command runs keyed `cmd:<user message id>`; child sessions linked via task tool `metadata.sessionId`.
- DB path: `$OPENCODE_TOKEN_MONITOR_DB` → `$XDG_DATA_HOME/opencode-token-monitor` → `~/.local/share/…` on all OSes.

## Blocked / open
- Phase 9: no access to `codeStruggle/opencode-portable-profile`; kit ready in `integrations/portable-profile/`.
- License not chosen (`UNLICENSED`); no release tag, no npm publish.
- Not executed: PowerShell scripts, macOS/Windows/arm64 binaries, real providers, real profile commands.

## Next steps
1. Owner decides license and npm publishing; tag `v0.1.0` to run `.github/workflows/release.yml`.
2. Apply the integration kit to the profile repository and run its verify/install tests.
3. Run `tests/e2e/run-e2e.ts` on macOS and Windows; extend `docs/COMPATIBILITY.md`.
4. Observe at least one real provider (Anthropic/OpenAI) and confirm counter and cost semantics.

## Reproduce the E2E
`npm i -g opencode-ai@1.18.34 && bun run build && OPENCODE_BIN=opencode bun tests/e2e/run-e2e.ts`
