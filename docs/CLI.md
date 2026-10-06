# tokenmon CLI reference

`tokenmon` reads the Token Monitor database; OpenCode does not need to be running.
Read commands open the database with `PRAGMA query_only`.

## Commands

| Command | Purpose |
| --- | --- |
| `tokenmon [summary] [range]` | Totals; `--group-by` for breakdowns |
| `tokenmon today` / `yesterday` / `week` / `last-week` / `month` / `last-month` / `year` | `summary <range> --group-by model` |
| `tokenmon sessions [range]` | Root sessions with whole-tree (inclusive) usage |
| `tokenmon trace <session>` (`inspect`) | Session tree, exclusive/inclusive, commands, tools; accepts a unique id suffix |
| `tokenmon commands [range]` | Per command: runs, direct, descendant, inclusive; unattributed rows |
| `tokenmon tools [range] [--session ID]` | Tool calls, status, duration, output size, child sessions |
| `tokenmon context [range] [--session ID] [--by-source]` | Estimated context composition vs exact prompt tokens |
| `tokenmon cache [range]` | Cache read/write ratios per model |
| `tokenmon trend [range] [--bucket day\|week\|month]` | Calendar buckets including empty ones |
| `tokenmon compare <A> <B>` | Two ranges; A/B are names (`last-week`), durations (`7d`) or `FROM..TO` |
| `tokenmon compare --by fingerprint\|branch [range]` | Groups by root-session config fingerprint or Git branch |
| `tokenmon live [--interval S] [--once]` | Refreshing view of today (read-only polling) |
| `tokenmon import [--opencode-db PATH] [--since DATE]` | Backfill/reconcile from OpenCode's database |
| `tokenmon doctor` | Paths, schema, counts, plugin loads, duplicates, fingerprints, recent problems |
| `tokenmon install-plugin [--dest DIR] [--from FILE] [--force] [--dry-run]` | Copy the bundle into OpenCode's global plugins dir |
| `tokenmon data prune --before DATE` | Delete history older than DATE |
| `tokenmon data vacuum` | Reclaim space |
| `tokenmon data purge --yes` | Delete the database and WAL/SHM files |

## Ranges

Exactly one of:

- a name: `today`, `yesterday`, `week`, `last-week`, `month`, `last-month`, `year`, `all` (default `all`);
- `--last N{m,h,d,w}`: rolling window `[now − N, now)`, an absolute duration;
- `--from` / `--to`:
  - `YYYY-MM-DD` — `--from` is that day's 00:00; `--to` **includes that whole day**
    (resolved to the next day's 00:00, exclusive);
  - `YYYY-MM-DDTHH:mm[:ss]` — interpreted in `--tz`; as `--to` it is the exclusive end;
  - ISO 8601 with `Z` or `±hh:mm` — interpreted with its own offset.

All ranges are half-open `[start, end)`. Calendar ranges use the time zone (`--tz <IANA>`, default the
system zone) and real day lengths (23 h / 25 h around DST). Weeks start on Monday. Every output echoes
the resolved range.

## Grouping and filters

`--group-by` takes a comma list: `project, session, root-session, provider, model, agent, command,
command-link, day, branch, commit, dirty, fingerprint, cost-source`.
`command` values are `/name`, `(no command)` or `(unlinked child session)`; `command-link` is
`direct | descendant | none | unlinked`.

Filters: `--project` (project id or directory), `--provider`, `--model`, `--agent`, `--session`.

## Output formats

- Text (default): tables; `n/a` = no known price; `$x*` = some steps in the row lack a price.
- `--json`: stable contract (below). No ANSI codes, no decorative titles.
- `--csv`: one header row, RFC 4180 quoting; available for summary, sessions, commands, tools,
  context, cache, trend, compare.
- `--redact-paths`: replaces absolute paths with `path:<sha256 prefix>` in any format.

## JSON contract (schemaVersion 1.0.0)

Every analytics document:

```json
{
  "schemaVersion": "1.0.0",
  "kind": "usage | commands | trace | tools | context | cache | trend | compare | sessions",
  "generatedAt": "ISO-8601",
  "range": { "start": 0, "end": 0, "startIso": "…", "endIso": "…", "timezone": "Europe/Berlin", "label": "today" },
  "precision": { "usage": "exact", "cost": "host_computed_list_price" },
  "notes": ["…"]
}
```

plus the kind-specific body. `UsageTotals`:

| Field | Unit / meaning |
| --- | --- |
| `steps` | count of LLM steps |
| `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens` | tokens; disjoint counters |
| `totalTokens` | tokens; sum of the five |
| `cost` | USD, list price computed by OpenCode, steps with known price only |
| `costKnownSteps`, `costUnavailableSteps` | counts |
| `stepsWithMissingTokens` | count of steps with a missing counter (missing counters add 0 to sums) |

- `null` means "not available", never zero (e.g. ratios with no data, unknown cost).
- `start`/`end` are epoch ms; `end` of `all` is `9007199254740991`.
- Ordering: groups by `totalTokens` descending (ties by key), `day` groups chronologically.
- Compatibility: semver. Minor = fields added; major = fields removed/renamed or meaning changed.
  Consumers must ignore unknown fields.
- `import`, `doctor`, `install-plugin`, `prune`, `vacuum` emit `{schemaVersion, kind, …}` documents.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | error (invalid group, conflicting range options, database error, …) |
| 2 | usage error (unknown command, missing argument, missing confirmation) |
| 3 | database does not exist yet (normal before the first recorded step) |
