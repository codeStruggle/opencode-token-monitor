# Implementation status

Plan: `docs/opencode-token-monitor-plan-A.md` (v1.1). Last update: 2026-10-06.
Legend: **done** = implemented and verified with the evidence listed; **partial** = implemented, some
verification missing; **blocked** = cannot proceed from this environment; **open** = not started.

## Milestones

| Milestone | Status |
| --- | --- |
| M1 — v0.1 (Phases 0, 1, 2, 3, 8a, 9) | code complete; Phase 9 blocked (profile repository not accessible); release not published |
| M2 — v0.2+ (Phases 4–7) | implemented in 0.1.0; verification limited to the mock provider |
| M3 — v1.0 (Phases 8b, 10) | partial: binaries build for all targets, only linux-x64 executed |

## Phases

| Phase | Status | Evidence | Gaps |
| --- | --- | --- | --- |
| 0 API spike | done | `docs/API_SPIKE.md`; fixtures `tests/fixtures/opencode-1.18.34/` captured from OpenCode 1.18.34 | real providers, macOS/Windows paths unverified |
| 1 Core + SQLite | done | `tests/unit/db.test.ts`, `tests/integration/concurrency.test.ts` (4 processes × 200 steps + reader), `tests/integration/plugin.test.ts` | |
| 2 Exact usage | done | `tests/integration/import.test.ts` (plugin vs OpenCode storage: 7/7 steps, 0 mismatches); E2E reconciliation | subscription-provider cost behaviour unverified |
| 3 Time analytics | done | `tests/unit/time.test.ts` (Europe/Berlin DST start/end, weeks, month end, leap year, year boundary, half-open) | |
| 4 Command/tool/agent | done | `tests/unit/analytics.test.ts` (nested child, concurrent roots, unlinked child, abort, synthetic turn); E2E `/sub` and `/inline` | real profile commands (`/review`, `/security-review`, …) not run — needs profile repo |
| 5 Context + cache | done | `tests/unit/context.test.ts` (real system prompt fully attributed), analytics tests (coverage, residual, over-estimate, cache `not_reported`) | estimates compared only against mock usage, not a real tokenizer |
| 6 History/compare/Git | done | analytics tests (trend empty buckets, compare caveats, fingerprint grouping); plugin tests (git clean/dirty/non-git, fingerprint stability/salt/partial) | |
| 7 Full CLI | done | `tests/integration/cli.test.ts` (JSON contract, CSV, every command, redaction, exit codes, data maintenance, install-plugin link semantics); `tests/node/cli.test.mjs` | |
| 8a Minimal release | partial | `scripts/build.ts`; `.github/workflows/release.yml`; npm pack verified; npm-style plugin load verified from a packed tarball | no release tag pushed, npm not published, LICENSE not chosen |
| 9 Profile integration | blocked | integration kit in `integrations/portable-profile/` with bash scripts tested (`tests/integration/profile-scripts.test.ts`) | profile repository not accessible from this session; PowerShell scripts not executed |
| 8b Full release | partial | all five binaries cross-compile (sizes: linux 81 MB, macOS 62–69 MB, Windows 86 MB); linux-x64 runs without Bun | arm64/macOS/Windows binaries not executed; unsigned |
| 10 Final E2E | partial | `tests/e2e/run-e2e.ts` against OpenCode 1.18.34: 20/20 checks (install, collection, duplicate load, abort, reconciliation, commands, traces, context, restart) | real providers, real profile commands, multiple models, Windows/macOS |

## Verification log (2026-10-06, Linux x64)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | pass |
| Unit + integration | `bun run test` | 106 pass, 0 fail (12 files) |
| Node CLI (`node:sqlite`) | `node --test tests/node/cli.test.mjs` | pass |
| Real OpenCode E2E | `OPENCODE_BIN=… bun tests/e2e/run-e2e.ts` | 20/20 checks |
| npm-form plugin | config `plugin: ["opencode-token-monitor@file:…tgz"]` | loaded from `~/.cache/opencode/packages/…`, 1 step recorded |
| Standalone binary | `env -i PATH=/usr/bin:/bin dist/bin/tokenmon-linux-x64 …` | version, summary, doctor OK; embedded bundle SHA-256 = release bundle |
| Overhead | `bun scripts/bench.ts 300` | ~3.1 µs per hook, ~3.2 ms per flush (~108 events), ~4 KB per step |

## Known limitations

- Title-generation requests are not recorded by OpenCode; their usage cannot be captured.
- Cost is OpenCode's list-price computation, not a bill; unknown prices are reported as unavailable.
- Inline (non-subtask) commands cannot be recovered from OpenCode storage by `import`; only the live
  plugin sees them.
- Context composition is an estimate (chars/4).
- Not yet observed with real providers; field mapping for providers other than the
  OpenAI-compatible adapter is unverified.

## Decisions needed from the owner

1. License (package.json is `UNLICENSED`; npm publish and redistribution in the profile need a license).
2. Whether to publish to npm, and under which account.
3. Access to `codeStruggle/opencode-portable-profile` to apply Phase 9.
4. Code signing for macOS/Windows binaries (optional).
