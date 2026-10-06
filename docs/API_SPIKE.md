# Phase 0 — OpenCode API spike

Date: 2026-10-06. All findings below were observed, not inferred, unless marked **unverified**.

## Environment

| Item | Value |
| --- | --- |
| OpenCode | 1.18.34 (`opencode-ai` npm package, `opencode-linux-x64` binary) |
| Plugin types | `@opencode-ai/plugin` 1.18.34, `@opencode-ai/sdk` 1.18.34 |
| OpenCode runtime | Bun 1.3.14 (embedded in the OpenCode binary) |
| Host OS | Linux x64 (cloud container) |
| Build tooling | Bun 1.4.2, Node 22.22.0 |
| Provider | Local OpenAI-compatible mock (`tests/e2e/mock-provider.ts`) via `@ai-sdk/openai-compatible` |

Method: an isolated `HOME`, a spike plugin in `~/.config/opencode/plugins/` that logged every hook and bus
event to JSONL, and `opencode run` scenarios: plain prompt, tool call (`read`), subagent (`task` tool),
`subtask: true` command, inline command, duplicate plugin (global + project), abort (SIGINT mid-request).
Raw captures were redacted into `tests/fixtures/opencode-1.18.34/` with `scripts/sanitize-fixture.ts`.

Note: `opencode run` reads stdin when it is not a TTY; non-interactive runs need `< /dev/null`.

## Answers to the Phase 0 questions

### Plugin loading and runtime

- A local `.js` file in `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/` is loaded automatically as an
  ES module. Every exported function is treated as a plugin factory `(input) => Promise<Hooks>`; the
  bundle therefore exports exactly one function (`TokenMonitorPlugin`).
- A project plugin in `<project>/.opencode/plugins/` is loaded **in addition** to the global one, in
  the same process. With the same file in both places both instances received every event (two
  `step-finish` deliveries). → a process-wide guard keyed by project directory is required
  (implemented; second instance returns no hooks and reports `plugin.duplicate`).
- npm declaration: `"plugin": ["opencode-token-monitor@file:/…/opencode-token-monitor-0.1.0.tgz"]`
  installed the package into `~/.cache/opencode/packages/…` and loaded its `main`
  (`dist/opencode-token-monitor.js`). Same entry, same adapter. Loading from the public npm registry is
  **unverified** (package not published).
- Plugin host is Bun: `typeof Bun !== "undefined"`, `Bun.version === "1.3.14"`, and
  `import("bun:sqlite")` works inside the plugin. No native module is needed.
- `input.directory`, `input.worktree`, `input.project` (`{id, worktree, vcs}`) are provided.
  For a Git repo without remotes the project id was `"global"`.

### Usage source and semantics

- Reliable completion source: the `message.part.updated` event whose part has `type: "step-finish"`.
  It carries `tokens` and `cost` and is emitted once per LLM step. Its `id` (`prt_…`) is the dedup key.
- `message.updated` for assistant messages is emitted several times; the first emission has all-zero
  tokens and no `finish`. Only `step-finish` parts are recorded as usage; streaming intermediate values
  are never stored. (The plan's `final` flag is therefore unnecessary: every stored step is final.)
- Counter semantics (mock reported `prompt_tokens = 1002`, `cached_tokens = 200`,
  `completion_tokens = 50`, `reasoning_tokens = 10`; OpenCode stored):

  | OpenCode field | Value | Meaning |
  | --- | --- | --- |
  | `tokens.input` | 802 | prompt tokens **excluding** cache reads |
  | `tokens.cache.read` | 200 | cached prompt tokens |
  | `tokens.cache.write` | 0 | cache creation tokens |
  | `tokens.output` | 40 | completion tokens **excluding** reasoning |
  | `tokens.reasoning` | 10 | reasoning tokens |
  | `tokens.total` | 1052 | = input + output + reasoning + cache.read + cache.write |

  The five counters are disjoint and additive for this provider adapter. `tokens.total` exists at
  runtime but not in the v1 SDK types. Other provider adapters may map fields differently
  (**unverified**); the importer reconciles against OpenCode's own numbers regardless.
- **Cost is computed by OpenCode**, not reported by the provider:
  `802×3 + 40×15 + 10×15 + 200×0.3 = 3216 → 0.003216` USD using the model's configured
  `cost` (USD per million tokens; reasoning billed at the output price). → stored with
  `costSource = "host_computed"`, presented as a list-price figure, never as a bill.
- `chat.params` exposes `input.model.cost`; when a model has no price, OpenCode stores `cost: 0`.
  Rule: `cost = 0` with non-zero tokens and no known price → `cost = null`, `costSource = "unavailable"`.
  Behaviour of real subscription providers (Claude Pro/Max OAuth, Copilot) is **unverified**.

### Identifiers and causality

- Stable ids: session `ses_…`, message `msg_…`, part `prt_…`; `session.parentID`; assistant
  `parentID` = the user message it answers; `providerID`, `modelID`, `agent`/`mode` on assistant messages.
- Child sessions: `session.created` has `parentID`. The parent's `task` tool part gets
  `state.metadata.sessionId = <child>` once running — an explicit tool→child link.
- Commands: `command.execute.before {command, sessionID, arguments}` fires before the command's user
  message; the next `chat.message` in that session carries that user message; `command.executed
  {name, sessionID, messageID}` fires at the end. `subtask: true` commands produce a `subtask` part with
  `command` and run through a `task` tool call (the child link above applies).
- After a subtask, OpenCode adds a **synthetic** user message ("Summarize the task tool output…",
  text part `synthetic: true`) whose assistant reply belongs to the same turn.
- Tools: `tool` parts with `state.status` pending → running → completed | error and `state.time`.

### Context observability

- `experimental.chat.system.transform` exposes the full system prompt. Markers observed:
  `<env>…</env>`, `Instructions from: <path>` (AGENTS.md), and the skills list
  (`Skills provide specialized…` + `<available_skills>…</available_skills>`).
- `experimental.chat.messages.transform` exposes the message list sent to the model (no session id in
  `input`; taken from `messages[].info.sessionID`).
- `tool.definition` fires per tool with description and JSON-schema parameters.
- Order per request: messages.transform → system.transform → chat.params. Title generation uses agent
  `title`, has its own system prompt, and **produces no message or step-finish**: its usage is not
  recorded by OpenCode at all (reported by `tokenmon` as "unrecorded auxiliary requests").
- Exact split of provider input tokens by source is impossible; estimates use chars/4.

### Robustness

- Abort (SIGINT during a request): the assistant message stays without `finish` and no `step-finish`
  is emitted → nothing is recorded (no fabricated usage).
- Tool error (`read` rejected by permission) → tool part status `error`; the step that issued it is
  still recorded.
- Restart: each `opencode run` is a new process; the database persists across them (E2E check).

### OpenCode's own storage (backfill / reconciliation)

- OpenCode 1.18 stores everything in SQLite: `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`
  (`opencode db path`), WAL mode. Tables used: `project`, `session` (with per-session token/cost
  totals), `message` (`data` JSON without id/sessionID), `part` (`data` JSON). The file also contains
  `account` / `credential` tables with tokens — the importer never reads them and opens the file
  read-only.
- `opencode stats` exists but rounds and mixes reasoning into output in one view; the database is the
  reconciliation baseline instead.
- Subtask commands are recoverable from storage (`subtask` part with `command`); inline commands are not.

### SQLite drivers and CLI runtime

- Plugin: `bun:sqlite` (built into OpenCode's Bun).
- npm CLI: Node ≥ 22.13 `node:sqlite` works (prints an ExperimentalWarning on 22.x, suppressed by the
  driver). The same `Db` interface wraps both drivers.
- Standalone CLI: `bun build --compile` (Bun 1.4.2) → ~81 MB (linux), runs with no Bun on `PATH`.
  Cross-compiled macOS/Windows/linux-arm64 binaries were built but not executed (**unverified**).

### Data directory convention

- OpenCode uses XDG-style paths on Linux (`opencode debug paths`). Token Monitor uses the same rule on
  every platform: `$OPENCODE_TOKEN_MONITOR_DB` → `$XDG_DATA_HOME/opencode-token-monitor/` →
  `~/.local/share/opencode-token-monitor/`. That OpenCode uses the same convention on macOS and Windows
  is **unverified** (plan §6.1: if it does not, the default must follow OpenCode before 1.0).

## Capability table

| Capability | Status | Evidence |
| --- | --- | --- |
| Per-step exact usage (5 counters) | available | step-finish part; fixtures; E2E reconciliation |
| Cost | available as host list price | cost recomputation above |
| Session parent/child | available | `session.parentID` |
| Child ↔ spawning tool call | available | task tool `metadata.sessionId` |
| Command ↔ turn | available (plugin) / partial (import: subtask only) | hooks above |
| Tool start/end/status | available | tool parts |
| System prompt composition | available (estimated sizes) | system.transform markers |
| Conversation / tool-result sizes | available (estimated) | messages.transform |
| Tool definition sizes | available (estimated) | tool.definition |
| Title-generation usage | unavailable (not recorded by host) | no step-finish |
| Provider-billed cost | unavailable | cost is computed by OpenCode |
| Exact per-source input split | unavailable | provider reports totals only |
| Git state | available (plugin runs `git`) | E2E |

## Decisions

1. **Collection strategy: hybrid (plan option c).** The plugin records everything live; OpenCode's
   database is the reconciliation baseline and backfill source (`tokenmon import`). On disagreement
   the importer corrects counters and flags `import_mismatch`.
2. **Drivers:** plugin `bun:sqlite`; CLI `bun:sqlite` in standalone binaries, `node:sqlite` for the
   npm CLI (`engines.node >= 22.13`).
3. **Dedup key:** the step-finish part id; command runs keyed by `cmd:<user message id>`, so plugin
   and importer agree.
4. **Migrations** live in `src/db/migrations.ts` (single authoritative source, embeddable in the
   single-file bundle) instead of a `migrations/` directory.

## Deviations from plan v1.1

| Plan | Implementation | Reason |
| --- | --- | --- |
| `final` flag on usage rows | not stored | only terminal step-finish parts are recorded |
| `migrations/` directory | `src/db/migrations.ts` | must be embedded in the single-file bundle |
| macOS/Windows default DB path | XDG rule everywhere | matches observed OpenCode convention on Linux; other OSes unverified |
