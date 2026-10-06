# Repository instructions for coding agents

- Source of truth for the plan: `docs/opencode-token-monitor-plan-A.md`; status and evidence:
  `docs/IMPLEMENTATION_STATUS.md`; session handoff: `.opencode/HANDOFF.md`.
- Code, identifiers, comments, logs, errors, test names and technical docs are in English.
  User-facing READMEs exist in English (authoritative), Chinese and German.
- Toolchain: Bun 1.4.2 (`bun install`, `bun run typecheck`, `bun run test`, `bun run build`),
  Node ≥ 22.13 for `node --test tests/node/cli.test.mjs`.
- Run `bun run check` (typecheck + tests + build) before committing.
- Only `src/collector/opencode-adapter.ts` and `src/collector/collector.ts` may read OpenCode data
  shapes. Analytics read only the Token Monitor schema; the CLI only formats analytics DTOs.
- Never record exact usage from anything but step-finish parts or OpenCode's storage; estimates
  must stay in `context_sources` and be labelled ESTIMATED.
- Plugin hooks must never throw or block; new hooks go through `safe()` and the write queue.
- Schema changes: append a migration to `src/db/migrations.ts`; never edit a released one.
- JSON output changes: follow semver in `src/analytics/dto.ts` (`JSON_SCHEMA_VERSION`) and `docs/CLI.md`.
- Fixtures in `tests/fixtures/opencode-*` are real captures; create new ones with
  `scripts/sanitize-fixture.ts` and mark synthetic data as synthetic.
- Do not report checks as passing unless they were run; update the status document with evidence.
