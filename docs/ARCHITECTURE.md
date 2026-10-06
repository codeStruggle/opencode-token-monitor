# Architecture

```text
OpenCode (Bun) ──hooks/events──▶ plugin/index.ts ──▶ collector/ (Collector + opencode-adapter)
                                        │                       │ NormalizedEvent[]
                                        ▼                       ▼
                                 plugin/queue.ts ──batch──▶ db/repository.ts ──▶ SQLite (WAL)
OpenCode's opencode.db ──read-only──▶ importer/opencode-db.ts ──┘                  │
                                                                                   ▼
                       cli/ (tokenmon) ◀── analytics/ (usage, commands, trace, …) ◀┘
```

- **Adapter boundary.** Only `src/collector/opencode-adapter.ts` (and the hook wiring in
  `collector.ts`) understands OpenCode shapes. Everything else uses `src/core/events.ts`.
  Inputs are `unknown`; malformed data yields nothing rather than an exception.
- **One write path.** Plugin and importer both call `Repository.apply(event, origin)`.
- **One query path.** CLI renderers only format DTOs from `src/analytics/`; no SQL in the CLI.
  A future HTTP server would call the same functions.

## Plugin behaviour

- Hooks used: `event`, `chat.message`, `chat.params`, `command.execute.before`,
  `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `tool.definition`.
  The plugin never modifies hook outputs.
- Every hook is wrapped: an exception becomes a rate-limited `hook.failed` diagnostic.
- Hooks only enqueue. `WriteQueue` flushes every second, on `session.idle`, `command.executed`,
  `dispose` and process exit, in one `BEGIN IMMEDIATE` transaction per batch. A failing batch is
  retried once, then dropped with a `write.failed` diagnostic. The buffer is bounded (10 000 events).
- Single instance per project directory per process (`globalThis[Symbol.for(...)]`). Later loads
  return no hooks and record `plugin.duplicate` through the active instance.
- Database errors at start-up (unwritable path, schema newer than supported) disable the plugin for
  that process and log through `client.app.log`; OpenCode keeps working.
- Measured overhead (`scripts/bench.ts`, replaying real hook payloads, Linux x64):
  ~3 µs per hook call; ~3 ms per flush of ~110 events.

## Database

Location: `$OPENCODE_TOKEN_MONITOR_DB` → `$XDG_DATA_HOME/opencode-token-monitor/token-monitor.sqlite` →
`~/.local/share/opencode-token-monitor/token-monitor.sqlite`. Same resolver for plugin and CLI
(`src/runtime/paths.ts`); `tokenmon doctor` prints the path and why it was chosen.

Schema (version 1, `src/db/migrations.ts`):

| Table | Key | Content |
| --- | --- | --- |
| `llm_steps` | step-finish part id | the five token counters, total, cost + `cost_source`, provider/model/agent, `seen_by_plugin`, `seen_by_import`, `import_mismatch` |
| `sessions` | session id | project, parent, directory, agent, host/plugin version, config fingerprint |
| `messages` | message id | role, parent message, agent, model, `synthetic`, times, finish, error name |
| `command_runs` | `cmd:<user message id>` | name, argument length, subtask flag, start/end |
| `tool_runs` | tool part id | tool, status, times, `child_session_id`, output length |
| `llm_requests` / `context_sources` | request id | per-request context estimates; `step_id` links to the step |
| `git_snapshots` | root session id | commit, branch, dirty, availability |
| `config_fingerprints` | HMAC id | scopes, file count, partial flag |
| `projects`, `diagnostics`, `meta` | | metadata, plugin diagnostics, HMAC salt, last import |

Times are UTC epoch milliseconds. Missing counters are `NULL`, never 0.

Migrations: `PRAGMA user_version`; each migration runs inside `BEGIN IMMEDIATE`, re-checking the version
after taking the write lock, so concurrent start-ups migrate once. Switching a fresh database to WAL
needs an exclusive lock that SQLite does not wait for, so the switch is retried with back-off within the
busy timeout (several OpenCode instances may create the database at the same moment). A database whose version is newer
than the build supports is never written; read commands refuse to interpret it.

Storage cost: ~4 KB per LLM step including messages, tool rows and context estimates (bench).
`tokenmon data prune --before DATE` and `tokenmon data vacuum` keep it bounded.

## Usage semantics (EXACT)

- Totals are sums over deduplicated steps. `totalTokens` = OpenCode's `tokens.total`
  (= input + output + reasoning + cache read + cache write).
- `cost` sums only steps with a known price; `costUnavailableSteps` counts the rest.
- Cost is OpenCode's list-price computation in USD (`precision.cost = "host_computed_list_price"`).
- Title-generation requests are not recorded by OpenCode; their count is reported as a note.

## Attribution (commands, agents, sessions)

- **Turn**: a non-synthetic user message plus every assistant message answering it or answering a
  synthetic user message that follows it in the same session.
- **direct**: steps in the turn whose user message started a command.
- **descendant**: steps in child sessions whose spawning `task` tool call (explicit
  `metadata.sessionId` link) belongs to such a turn, recursively.
- **inclusive** = direct + descendant.
- **(no command)**: steps of plain prompt turns (and their linked descendants).
- **(unlinked child session)**: steps in child sessions whose spawning tool call was not observed.
  Never attached to the nearest command by time.
- Session trees: `exclusive` = own steps, `inclusive` = own + descendants; `trace` checks that the
  root inclusive equals the sum of all exclusive values.

## Context estimation (ESTIMATED)

Per request (`chat.params`), the plugin stores character counts of observable sources:
`system` (base prompt), `environment`, `instructions` (per `Instructions from:` path), `skills`,
`tool_definitions` (per tool), `conversation` (user / assistant), `tool_results`, `files`.
Estimate = ceil(chars / 4). The request is linked to the next step of the same session and agent.

- `actualPromptTokens` (EXACT) = Σ(input + cache read + cache write) of linked steps.
- `unknownTokens` = max(actual − estimated, 0); `overEstimateTokens` = max(estimated − actual, 0).
- `coverage` = min(estimated, actual) / actual — how much of the prompt observed sources can explain;
  not an accuracy measure.
- `allocatedTokens` scales estimates down only when they exceed the actual prompt; raw estimates are
  kept. Imported history has no context data and is counted as `withoutContext`.

## Cache

Per model: `readRatio = cacheRead / (input + cacheRead + cacheWrite)`, `writeRatio` likewise. A model
with no cache activity at all is `not_reported` with ratios `null`, not 0%. No savings are computed.

## Git and configuration fingerprint

- Captured once per root session, asynchronously, in the session directory: `git rev-parse HEAD`,
  `--abbrev-ref HEAD`, `status --porcelain`. Non-Git directories are `available = false`.
- Fingerprint: HMAC-SHA256 (per-database random salt) over sorted `scope:relative-path:sha256(content)`
  lines of `AGENTS.md`, `opencode.json(c)`, `agent(s)/`, `skill(s)/`, `command(s)/` in the global config
  dir, `$OPENCODE_CONFIG_DIR`, `<worktree>/.opencode`, and `AGENTS.md`/`opencode.json(c)` in the
  worktree. Links are followed (content is hashed, not link targets). `partial = true` when config also
  comes from `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT`, which are not observed.

## Privacy

- No prompt text, source code, tool input/output, session titles or command arguments are stored —
  only lengths, counts, ids, model names and paths.
- Paths (project directory, instruction file paths) are stored; `--redact-paths` replaces them with
  stable hashes in all outputs.
- The importer opens OpenCode's database read-only and only reads `project`, `session`, `message`,
  `part`.
