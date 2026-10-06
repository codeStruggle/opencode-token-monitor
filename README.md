# OpenCode Token Monitor

[中文](README.zh-CN.md) · [Deutsch](README.de.md)

Records the token usage and cost of every [OpenCode](https://opencode.ai) LLM step into a local SQLite
database and lets you analyze it with the `tokenmon` CLI: by time range, project, session, model, agent,
command, tool and parent/child session chain, plus estimated context composition, cache use, trends,
comparisons and Git/config correlation.

- **Exact vs. estimated are kept apart.** Token counters come from OpenCode's own accounting and can be
  reconciled against OpenCode's database. Context composition is an estimate and is labelled as such.
- **Cost is OpenCode's list-price computation (USD), not a provider bill.** Steps without a known price
  are shown as unavailable, never as $0.
- **Local only.** No server, no network calls, no prompt or code content stored.

Status: 0.1.0, tested with OpenCode 1.18.34 on Linux x64. See [compatibility](docs/COMPATIBILITY.md)
and [known limitations](#limitations).

## Install the plugin

Pick **one** of the following. Loading the plugin twice is detected and ignored, but avoid it.

**Local bundle (recommended):** copy the release file `opencode-token-monitor.js` into OpenCode's
global plugins directory:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
cp opencode-token-monitor.js "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/"
# or, with the CLI installed:
tokenmon install-plugin            # refuses to overwrite a different file unless --force (keeps a backup)
```

**npm:** declare an exact version in your own `opencode.json` (not yet published to the registry):

```json
{ "plugin": ["opencode-token-monitor@0.1.0"] }
```

Restart OpenCode. Nothing else is configured; your `opencode.json` is never modified by Token Monitor.

## Install the CLI

- Standalone binary from the release (`tokenmon-linux-x64`, `tokenmon-linux-arm64`,
  `tokenmon-macos-x64`, `tokenmon-macos-arm64`, `tokenmon-windows-x64.exe`). Needs nothing else.
  macOS/Windows binaries are unsigned; Gatekeeper/SmartScreen may ask for confirmation
  (`xattr -d com.apple.quarantine tokenmon-macos-*` on macOS).
- npm: `npm install -g opencode-token-monitor` — requires **Node ≥ 22.13** (uses `node:sqlite`) or Bun.

## Use

```bash
tokenmon today                         # today's usage by model (system time zone)
tokenmon week --tz Europe/Berlin       # calendar week, Monday start
tokenmon summary --last 24h --group-by project,agent
tokenmon summary --from 2026-10-01 --to 2026-10-06    # --to date includes that whole day
tokenmon commands week                 # direct / descendant / inclusive per command
tokenmon sessions                      # root sessions with whole-tree usage
tokenmon trace ses_xxx                 # session tree, child sessions, tools, commands
tokenmon context --by-source           # estimated prompt composition vs. exact prompt tokens
tokenmon cache month
tokenmon trend --bucket week
tokenmon compare last-week week        # or: tokenmon compare --by fingerprint
tokenmon live                          # refreshing view of today
tokenmon import                        # backfill/reconcile from OpenCode's own database
tokenmon doctor                        # paths, schema, plugin loads, problems
```

Every command supports `--json` (stable contract, `schemaVersion` 1.0.0), most support `--csv`, and all
support `--redact-paths`. Full reference: [docs/CLI.md](docs/CLI.md).

## Where data lives

`$OPENCODE_TOKEN_MONITOR_DB`, else `$XDG_DATA_HOME/opencode-token-monitor/token-monitor.sqlite`, else
`~/.local/share/opencode-token-monitor/token-monitor.sqlite` (same rule on every OS, like OpenCode's
own data directory). The plugin and the CLI use the same resolver; `tokenmon doctor` shows the path in use.

Each machine has its own history. Removing the plugin never deletes data. To delete history explicitly:
`tokenmon data prune --before 2026-01-01`, `tokenmon data vacuum`, or `tokenmon data purge --yes`.

## What is measured

| Output | Precision | Source |
| --- | --- | --- |
| input / output / reasoning / cache read / cache write tokens | exact (as reported by OpenCode) | OpenCode `step-finish` events; reconcilable with OpenCode's database |
| cost | OpenCode list price, USD | OpenCode's model pricing; `n/a` when no price is known |
| commands, child sessions, tools | exact links where observed | OpenCode hooks; unlinked items are listed separately |
| context composition | estimate (characters / 4) | system prompt, AGENTS.md, skills, tool definitions, conversation, tool results |
| Git branch/commit/dirty, config fingerprint | per root session | `git` in the project; salted hash of config files |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Phase 0 findings: [docs/API_SPIKE.md](docs/API_SPIKE.md).

## Privacy

No prompt text, code, tool input/output, session titles or command arguments are stored — only counts,
sizes, ids, model names and paths. Use `--redact-paths` when sharing output.

## Limitations

- OpenCode does not record the usage of session-title generation; Token Monitor reports how many such
  requests happened but cannot count their tokens.
- Inline commands cannot be recovered from OpenCode's database by `import`; only the live plugin sees them.
- Tested only with OpenCode 1.18.34 on Linux and with an OpenAI-compatible provider; other providers,
  macOS and Windows are not yet verified.
- License: not chosen yet (`UNLICENSED`).

## Development

```bash
bun install
bun run check                     # typecheck + unit/integration tests + build
node --test tests/node/cli.test.mjs
OPENCODE_BIN=opencode bun tests/e2e/run-e2e.ts   # real OpenCode + mock provider
bun run build:binaries
```

See [AGENTS.md](AGENTS.md), [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) and the
portable-profile integration kit in [integrations/portable-profile](integrations/portable-profile/README.md).
