import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { queryCache, type CacheAnalysis } from "../analytics/cache.ts"
import { queryCommands, type CommandBreakdown } from "../analytics/commands.ts"
import { compareBy, compareRanges, type ComparisonResult } from "../analytics/compare.ts"
import { queryContext, type ContextAnalysis } from "../analytics/context.ts"
import type { Filters } from "../analytics/data.ts"
import type { UsageSummary } from "../analytics/dto.ts"
import { listSessions, type SessionList } from "../analytics/sessions.ts"
import { queryTools, type ToolBreakdown } from "../analytics/tools.ts"
import { querySessionTrace, type SessionTrace, type TraceNode } from "../analytics/trace.ts"
import { queryTrend, type Bucket, type TrendSeries } from "../analytics/trend.ts"
import { parseGroupBy, queryUsage } from "../analytics/usage.ts"
import { DatabaseMissingError, openDatabase, type Db } from "../db/driver.ts"
import { prune, purgeFiles, vacuum } from "../db/maintenance.ts"
import { assertReadableSchema, migrate } from "../db/migrations.ts"
import { Repository } from "../db/repository.ts"
import { importFromOpencode } from "../importer/opencode-db.ts"
import { resolveDbPath, resolveOpencodeDbPath } from "../runtime/paths.ts"
import { isNaturalRange, parseBoundary, parseRangeExpression, resolveRange, type TimeRange } from "../time/range.ts"
import { assertTimeZone, formatInZone, systemTimeZone } from "../time/zone.ts"
import { PLUGIN_VERSION } from "../version.ts"
import { flag, has, parseArgs, type ParsedArgs } from "./args.ts"
import { doctor } from "./doctor.ts"
import { installPlugin } from "./install.ts"
import { csv, fmtCost, fmtInt, fmtPct, table, USAGE_CSV_HEADERS, USAGE_HEADERS, usageCells, usageCsvCells } from "./render.ts"

declare const __EMBEDDED_PLUGIN__: string | undefined

export type Io = { out: (s: string) => void; err: (s: string) => void; now: () => number }

const HELP = `tokenmon ${PLUGIN_VERSION} — token usage analytics for OpenCode

Usage: tokenmon <command> [range] [options]

Commands:
  summary [range]          Usage totals (default command). Group with --group-by.
  today | yesterday | week | last-week | month | last-month | year
                           Shortcut for: summary <range> --group-by model
  sessions [range]         Root sessions with inclusive (tree) usage
  trace <session>          Session tree: exclusive/inclusive usage, commands, tools (alias: inspect)
  commands [range]         Usage per command: direct, descendant, inclusive, unattributed
  tools [range]            Tool execution metadata (not billed tokens)
  context [range]          Estimated context composition vs exact prompt tokens
  cache [range]            Cache read/write per model
  trend [range]            Usage per calendar bucket (--bucket day|week|month)
  compare <A> <B>          Compare two ranges (names, 7d, or FROM..TO); or --by fingerprint|branch [range]
  live                     Refreshing view of today's usage (read-only)
  import                   Backfill/reconcile from OpenCode's own database
  doctor                   Diagnose paths, schema, plugin loads and recent errors
  install-plugin           Install the plugin bundle into OpenCode's global plugins directory
  data prune --before DATE | data vacuum | data purge --yes

Range (one of):
  today, yesterday, week, last-week, month, last-month, year, all (default: all)
  --last 1h|24h|7d|30d     Rolling window ending now
  --from DATE --to DATE    DATE = YYYY-MM-DD | YYYY-MM-DDTHH:mm | ISO with offset.
                           A date-only --to includes that whole day.

Options:
  --tz <IANA zone>         Calendar time zone (default: system, ${systemTimeZone()})
  --group-by a,b           project, session, root-session, provider, model, agent, command,
                           command-link, day, branch, commit, dirty, fingerprint, cost-source
  --project/--provider/--model/--agent/--session <value>   Filters
  --json | --csv           Machine-readable output (JSON schemaVersion 1.0.0)
  --redact-paths           Replace file system paths with stable hashes in output
  --db <path>              Database path (else ${"$"}OPENCODE_TOKEN_MONITOR_DB, else XDG data dir)
  --limit <n>              Limit rows
Weeks start on Monday. Ranges are half-open [start, end).
Cost is OpenCode's list-price computation in USD, not a provider bill. "n/a" = no known price.
`

class UsageError extends Error {}

function tzOf(args: ParsedArgs): string {
  return assertTimeZone(flag(args, "tz") ?? systemTimeZone())
}

function filtersOf(args: ParsedArgs): Filters {
  return {
    project: flag(args, "project"),
    provider: flag(args, "provider"),
    model: flag(args, "model"),
    agent: flag(args, "agent"),
    session: flag(args, "session"),
  }
}

function rangeOf(args: ParsedArgs, positional: string | undefined, io: Io, fallback: "all" | "today" = "all"): TimeRange {
  return resolveRange({ range: positional, last: flag(args, "last"), from: flag(args, "from"), to: flag(args, "to") }, io.now(), tzOf(args), fallback)
}

function dbPathOf(args: ParsedArgs) {
  const explicit = flag(args, "db")
  if (explicit) return { path: explicit, reason: "flag" as const }
  return resolveDbPath()
}

async function openForRead(args: ParsedArgs): Promise<Db | null> {
  const { path } = dbPathOf(args)
  try {
    const db = await openDatabase(path, { queryOnly: true })
    assertReadableSchema(db)
    return db
  } catch (error) {
    if (error instanceof DatabaseMissingError) return null
    throw error
  }
}

async function openForWrite(args: ParsedArgs): Promise<Repository> {
  const { path } = dbPathOf(args)
  const db = await openDatabase(path, { create: true })
  migrate(db)
  return new Repository(db, PLUGIN_VERSION)
}

/** Replaces path-like strings with stable hashes; keys are kept so the JSON shape is unchanged. */
export function redactPaths<T>(value: T): T {
  const looksLikePath = (s: string) => /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(s)
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return looksLikePath(v) ? `path:${createHash("sha256").update(v).digest("hex").slice(0, 12)}` : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

type Output = { json: unknown; text: () => string; csv?: () => string }

function emit(args: ParsedArgs, io: Io, output: Output): void {
  const redact = has(args, "redact-paths")
  if (has(args, "json")) {
    io.out(JSON.stringify(redact ? redactPaths(output.json) : output.json, null, 2) + "\n")
    return
  }
  if (has(args, "csv")) {
    if (!output.csv) throw new UsageError("CSV output is not available for this command")
    io.out(redact ? redactCsv(output.csv()) : output.csv())
    return
  }
  const text = output.text()
  io.out((redact ? redactText(text) : text) + "\n")
}

const redactText = (s: string) =>
  s.replace(/(?<![\w])(\/[^\s,"]+|[A-Za-z]:\\[^\s,"]+)/g, (m) => `path:${createHash("sha256").update(m).digest("hex").slice(0, 12)}`)
const redactCsv = redactText

function header(r: { range: { label: string; startIso: string; endIso: string; timezone: string } }): string {
  if (r.range.label === "all") return `Range: all time  (${r.range.timezone})`
  return `Range: ${r.range.label}  [${r.range.startIso} .. ${r.range.endIso})  ${r.range.timezone}`
}

function notesText(notes: string[]): string {
  return notes.length ? "\n" + notes.map((n) => `note: ${n}`).join("\n") : ""
}

function renderUsage(r: UsageSummary): Output {
  return {
    json: r,
    text: () => {
      const lines = [header(r)]
      if (r.groupBy.length && r.groups.length) {
        lines.push(
          table(
            [...r.groupBy, ...USAGE_HEADERS],
            r.groups.map((g) => [...r.groupBy.map((d) => g.key[d] ?? "(unknown)"), ...usageCells(g.totals)]),
            [...r.groupBy.map(() => "l" as const)],
          ),
        )
      }
      lines.push(table(["", ...USAGE_HEADERS], [["TOTAL", ...usageCells(r.totals)]]))
      if (r.reconciliation.importMismatches) lines.push(`reconciliation: ${r.reconciliation.importMismatches} step(s) differed from OpenCode's storage and were corrected`)
      return lines.join("\n\n") + notesText(r.notes)
    },
    csv: () =>
      csv(
        [...r.groupBy, ...USAGE_CSV_HEADERS],
        (r.groupBy.length ? r.groups : [{ key: {}, totals: r.totals }]).map((g) => [...r.groupBy.map((d) => g.key[d]), ...usageCsvCells(g.totals)]),
      ),
  }
}

function renderSessions(r: SessionList, tz: string): Output {
  return {
    json: r,
    text: () =>
      [
        header(r),
        table(
          ["root session", "created", "agent", "children", "tree total", "tree cost", "in range"],
          r.sessions.map((s) => [
            s.rootSessionId,
            s.createdAt ? formatInZone(s.createdAt, tz).slice(0, 16) : "-",
            s.agent ?? "-",
            s.childSessions,
            fmtInt(s.inclusive.totalTokens),
            fmtCost(s.inclusive),
            fmtInt(s.inRange.totalTokens),
          ]),
          ["l", "l", "l"],
        ),
      ].join("\n\n") + notesText(r.notes),
    csv: () =>
      csv(
        ["root_session_id", "created_at", "agent", "child_sessions", "tree_total_tokens", "tree_cost_usd", "in_range_total_tokens", "directory"],
        r.sessions.map((s) => [s.rootSessionId, s.createdAt, s.agent, s.childSessions, s.inclusive.totalTokens, s.inclusive.costKnownSteps ? s.inclusive.cost : null, s.inRange.totalTokens, s.directory]),
      ),
  }
}

function renderTrace(r: SessionTrace): Output {
  return {
    json: r,
    text: () => {
      const lines: string[] = [`Trace of ${r.rootSessionId}${r.requestedSessionId !== r.rootSessionId ? ` (requested ${r.requestedSessionId})` : ""}`]
      if (r.git) lines.push(`git: ${r.git.available ? `${r.git.branch ?? "?"} @ ${r.git.commit?.slice(0, 12) ?? "?"}${r.git.dirty ? " (dirty)" : ""}` : "not a git repository"}`)
      if (r.configFingerprint) lines.push(`config fingerprint: ${r.configFingerprint}`)
      const walk = (n: TraceNode, depth: number) => {
        const pad = "  ".repeat(depth)
        const via = n.spawnedBy ? ` ← task tool${n.spawnedBy.commandName ? ` in /${n.spawnedBy.commandName}` : ""}` : n.parentId ? " ← (spawn link not observed)" : ""
        lines.push(
          `${pad}${depth ? "└─ " : ""}${n.sessionId} [${n.agent ?? "?"}]${via}\n` +
            `${pad}   exclusive ${fmtInt(n.exclusive.totalTokens)} tok ${fmtCost(n.exclusive)} | inclusive ${fmtInt(n.inclusive.totalTokens)} tok ${fmtCost(n.inclusive)} | ` +
            `${n.exclusive.steps} steps | models ${n.models.join(", ") || "-"}`,
        )
        for (const c of n.commands) {
          lines.push(`${pad}   /${c.name}: direct ${fmtInt(c.direct.totalTokens)}, descendant ${fmtInt(c.descendant.totalTokens)}, inclusive ${fmtInt(c.inclusive.totalTokens)}`)
        }
        if (n.tools.total) {
          lines.push(`${pad}   tools: ${Object.entries(n.tools.byTool).map(([t, c]) => `${t}×${c}`).join(", ")}${n.tools.errors ? ` (${n.tools.errors} errors)` : ""}`)
        }
        for (const c of n.children) walk(c, depth + 1)
      }
      walk(r.tree, 0)
      lines.push(`\ncheck: sum of exclusive = ${fmtInt(r.check.sumOfExclusive.totalTokens)}, root inclusive = ${fmtInt(r.check.rootInclusive.totalTokens)} → ${r.check.consistent ? "consistent" : "INCONSISTENT"}`)
      return lines.join("\n")
    },
  }
}

function renderCommands(r: CommandBreakdown): Output {
  return {
    json: r,
    text: () =>
      [
        header(r),
        table(
          ["command", "runs", "direct", "descendant", "inclusive", "inclusive cost"],
          [
            ...r.byName.map((c) => [`/${c.name}`, c.runs, fmtInt(c.direct.totalTokens), fmtInt(c.descendant.totalTokens), fmtInt(c.inclusive.totalTokens), fmtCost(c.inclusive)]),
            ["(no command)", "-", fmtInt(r.unattributed.plainPrompts.totalTokens), "-", fmtInt(r.unattributed.plainPrompts.totalTokens), fmtCost(r.unattributed.plainPrompts)],
            ["(unlinked child sessions)", "-", "-", "-", fmtInt(r.unattributed.unlinkedChildSessions.totalTokens), fmtCost(r.unattributed.unlinkedChildSessions)],
          ],
        ),
        `TOTAL ${fmtInt(r.totals.totalTokens)} tokens, ${fmtCost(r.totals)}${r.unlinkedRuns ? `; ${r.unlinkedRuns} command run(s) without a linked turn` : ""}`,
      ].join("\n\n") + notesText(r.notes),
    csv: () =>
      csv(
        ["command", "runs", "direct_total_tokens", "descendant_total_tokens", "inclusive_total_tokens", "inclusive_cost_usd"],
        [
          ...r.byName.map((c) => [c.name, c.runs, c.direct.totalTokens, c.descendant.totalTokens, c.inclusive.totalTokens, c.inclusive.costKnownSteps ? c.inclusive.cost : null]),
          ["(no command)", null, r.unattributed.plainPrompts.totalTokens, null, r.unattributed.plainPrompts.totalTokens, r.unattributed.plainPrompts.costKnownSteps ? r.unattributed.plainPrompts.cost : null],
          ["(unlinked child sessions)", null, null, null, r.unattributed.unlinkedChildSessions.totalTokens, null],
        ],
      ),
  }
}

function renderTools(r: ToolBreakdown): Output {
  return {
    json: r,
    text: () =>
      [header(r), table(["tool", "calls", "completed", "errors", "avg ms", "output chars", "child sessions"], r.tools.map((t) => [t.tool, t.calls, t.completed, t.errors, fmtInt(t.avgDurationMs), fmtInt(t.totalOutputChars), t.childSessions]))].join("\n\n") +
      notesText(r.notes),
    csv: () => csv(["tool", "calls", "completed", "errors", "other", "avg_duration_ms", "total_output_chars", "child_sessions"], r.tools.map((t) => [t.tool, t.calls, t.completed, t.errors, t.other, t.avgDurationMs, t.totalOutputChars, t.childSessions])),
  }
}

function renderContext(r: ContextAnalysis): Output {
  return {
    json: r,
    text: () =>
      [
        header(r),
        `actual prompt tokens (EXACT): ${fmtInt(r.actualPromptTokens)}   estimated (ESTIMATED): ${fmtInt(r.estimatedTotalTokens)}   coverage: ${fmtPct(r.coverage)}` +
          (r.overEstimateTokens ? `\nestimates exceed the actual prompt by ${fmtInt(r.overEstimateTokens)} tokens; "allocated" scales them down` : ""),
        table(
          ["category", ...(r.categories.some((c) => c.source) ? ["source"] : []), "est. tokens", "allocated", "share of actual"],
          r.categories.map((c) => [
            c.category,
            ...(r.categories.some((x) => x.source) ? [c.source ?? ""] : []),
            fmtInt(c.estimatedTokens),
            fmtInt(c.allocatedTokens),
            r.actualPromptTokens ? fmtPct(c.allocatedTokens / r.actualPromptTokens) : "n/a",
          ]),
          ["l", "l"],
        ),
        `steps with context data: ${r.steps.withContext}/${r.steps.total}`,
      ].join("\n\n") + notesText(r.notes),
    csv: () => csv(["category", "source", "estimated_tokens", "allocated_tokens", "chars", "method"], r.categories.map((c) => [c.category, c.source, c.estimatedTokens, c.allocatedTokens, c.chars, c.method])),
  }
}

function renderCache(r: CacheAnalysis): Output {
  const row = (label: string, g: CacheAnalysis["overall"]) => [label, fmtInt(g.promptTokens), fmtInt(g.inputTokens), fmtInt(g.cacheReadTokens), fmtInt(g.cacheWriteTokens), fmtPct(g.readRatio), fmtPct(g.writeRatio), g.status]
  return {
    json: r,
    text: () =>
      [
        header(r),
        table(
          ["model", "prompt", "uncached input", "cache read", "cache write", "read ratio", "write ratio", "status"],
          [...r.groups.map((g) => row(g.provider ? `${g.provider}/${g.model}` : (g.model ?? "unknown"), g)), row("ALL", r.overall)],
          ["l"],
        ),
      ].join("\n\n") + notesText(r.notes),
    csv: () =>
      csv(
        ["provider", "model", "steps", "prompt_tokens", "input_tokens", "cache_read_tokens", "cache_write_tokens", "read_ratio", "write_ratio", "status"],
        r.groups.map((g) => [g.provider, g.model, g.steps, g.promptTokens, g.inputTokens, g.cacheReadTokens, g.cacheWriteTokens, g.readRatio, g.writeRatio, g.status]),
      ),
  }
}

function renderTrend(r: TrendSeries): Output {
  const max = Math.max(1, ...r.points.map((p) => p.totals.totalTokens))
  return {
    json: r,
    text: () =>
      [
        header(r),
        table(
          [r.bucket, "total", "cost", "steps", ""],
          r.points.map((p) => [p.label, fmtInt(p.totals.totalTokens), fmtCost(p.totals), p.totals.steps, "█".repeat(Math.round((p.totals.totalTokens / max) * 30))]),
          ["l", "r", "r", "r", "l"],
        ),
      ].join("\n\n") + notesText(r.notes),
    csv: () => csv(["bucket_start", "start_ms", "end_ms", ...USAGE_CSV_HEADERS], r.points.map((p) => [p.label, p.start, p.end, ...usageCsvCells(p.totals)])),
  }
}

function renderCompare(r: ComparisonResult): Output {
  return {
    json: r,
    text: () =>
      [
        `Compare by ${r.by}: ${r.range.label}`,
        table(
          ["side", "root sessions", "steps", "total", "cost", "avg/step", "avg/root session", "models"],
          r.sides.map((s) => [s.label, s.rootSessions, s.totals.steps, fmtInt(s.totals.totalTokens), fmtCost(s.totals), fmtInt(s.avgTokensPerStep), fmtInt(s.avgTokensPerRootSession), s.models.join(" ")]),
          ["l", "r", "r", "r", "r", "r", "r", "l"],
        ),
        r.delta
          ? `delta (B - A): ${fmtInt(r.delta.totalTokens)} tokens (${r.delta.totalTokensPct === null ? "n/a" : r.delta.totalTokensPct.toFixed(1) + "%"}); per root session ${r.delta.avgTokensPerRootSessionPct === null ? "n/a" : r.delta.avgTokensPerRootSessionPct.toFixed(1) + "%"}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n") + notesText(r.caveats),
    csv: () => csv(["side", "root_sessions", ...USAGE_CSV_HEADERS, "avg_tokens_per_step", "avg_tokens_per_root_session"], r.sides.map((s) => [s.label, s.rootSessions, ...usageCsvCells(s.totals), s.avgTokensPerStep, s.avgTokensPerRootSession])),
  }
}

const NO_DATA = (path: string) =>
  `No Token Monitor database yet at ${path}.\nThis is normal before the plugin has recorded anything. Run \`tokenmon doctor\` for details or \`tokenmon import\` to backfill from OpenCode.`

async function withReadDb(args: ParsedArgs, io: Io, fn: (db: Db) => Output | Promise<Output>): Promise<number> {
  const db = await openForRead(args)
  if (!db) {
    if (has(args, "json")) io.out(JSON.stringify({ schemaVersion: "1.0.0", kind: "error", error: "database_missing", path: dbPathOf(args).path }, null, 2) + "\n")
    else io.err(NO_DATA(dbPathOf(args).path) + "\n")
    return 3
  }
  try {
    emit(args, io, await fn(db))
    return 0
  } finally {
    db.close()
  }
}

function firstRangePositional(args: ParsedArgs): string | undefined {
  const p = args.positionals[1]
  return p !== undefined && isNaturalRange(p) ? p : p === undefined ? undefined : (() => {
    throw new UsageError(`Unknown range "${p}"`)
  })()
}

function parseLimit(args: ParsedArgs): number | undefined {
  const v = flag(args, "limit")
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new UsageError("--limit must be a positive integer")
  return n
}

async function live(args: ParsedArgs, io: Io): Promise<number> {
  const interval = Math.max(1, Number(flag(args, "interval") ?? 2)) * 1000
  const once = has(args, "once")
  while (true) {
    const db = await openForRead(args)
    const now = io.now()
    let text: string
    if (!db) text = NO_DATA(dbPathOf(args).path)
    else {
      try {
        const tz = tzOf(args)
        const range = resolveRange({ range: "today" }, now, tz)
        const usage = queryUsage(db, { range, groupBy: ["model"] })
        const recent = db.prepare(`SELECT * FROM llm_steps ORDER BY ts DESC LIMIT 8`).all()
        text = [
          `tokenmon live — ${formatInZone(now, tz)} (refresh ${interval / 1000}s, Ctrl+C to exit)`,
          renderUsage(usage).text(),
          table(
            ["time", "model", "agent", "input", "output", "cache read", "cost"],
            recent.map((s) => [
              formatInZone(Number(s.ts), tz).slice(11, 19),
              String(s.model ?? "?"),
              String(s.agent ?? "?"),
              fmtInt(Number(s.input_tokens ?? 0)),
              fmtInt(Number(s.output_tokens ?? 0)),
              fmtInt(Number(s.cache_read_tokens ?? 0)),
              s.cost === null ? "n/a" : `$${Number(s.cost).toFixed(4)}`,
            ]),
            ["l", "l", "l"],
          ),
        ].join("\n\n")
      } finally {
        db.close()
      }
    }
    io.out((once ? "" : "\x1b[2J\x1b[H") + text + "\n")
    if (once) return 0
    await new Promise((r) => setTimeout(r, interval))
  }
}

function embeddedBundle(): string | null {
  return typeof __EMBEDDED_PLUGIN__ === "string" ? __EMBEDDED_PLUGIN__ : null
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return 2
  }
  if (has(args, "version")) {
    io.out(`${PLUGIN_VERSION}\n`)
    return 0
  }
  let command = args.positionals[0] ?? "summary"
  if (has(args, "help") || command === "help") {
    io.out(HELP)
    return 0
  }
  try {
    if (isNaturalRange(command)) {
      args.positionals.splice(1, 0, command)
      command = "summary"
      if (!args.flags.has("group-by")) args.flags.set("group-by", "model")
    }
    const tz = () => tzOf(args)
    switch (command) {
      case "summary":
      case "usage":
        return await withReadDb(args, io, (db) =>
          renderUsage(queryUsage(db, { range: rangeOf(args, firstRangePositional(args), io), groupBy: parseGroupBy(flag(args, "group-by")), filters: filtersOf(args), limit: parseLimit(args) })),
        )
      case "sessions":
        return await withReadDb(args, io, (db) => renderSessions(listSessions(db, rangeOf(args, firstRangePositional(args), io), filtersOf(args), parseLimit(args) ?? 20), tz()))
      case "trace":
      case "inspect": {
        const id = args.positionals[1]
        if (!id) throw new UsageError("Usage: tokenmon trace <session-id>")
        return await withReadDb(args, io, (db) => renderTrace(querySessionTrace(db, id, tz())))
      }
      case "commands":
        return await withReadDb(args, io, (db) => renderCommands(queryCommands(db, rangeOf(args, firstRangePositional(args), io), filtersOf(args))))
      case "tools":
        return await withReadDb(args, io, (db) => renderTools(queryTools(db, rangeOf(args, firstRangePositional(args), io), flag(args, "session"))))
      case "context":
        return await withReadDb(args, io, (db) => renderContext(queryContext(db, rangeOf(args, firstRangePositional(args), io), { sessionId: flag(args, "session"), bySource: has(args, "by-source") })))
      case "cache":
        return await withReadDb(args, io, (db) => renderCache(queryCache(db, rangeOf(args, firstRangePositional(args), io), filtersOf(args))))
      case "trend": {
        const bucket = (flag(args, "bucket") ?? "day") as Bucket
        if (!["day", "week", "month"].includes(bucket)) throw new UsageError("--bucket must be day, week or month")
        return await withReadDb(args, io, (db) => renderTrend(queryTrend(db, rangeOf(args, firstRangePositional(args), io, "all"), bucket, filtersOf(args))))
      }
      case "compare": {
        const by = flag(args, "by")
        if (by) {
          if (by !== "fingerprint" && by !== "branch") throw new UsageError("--by must be fingerprint or branch")
          return await withReadDb(args, io, (db) => renderCompare(compareBy(db, rangeOf(args, firstRangePositional(args), io), by, filtersOf(args))))
        }
        const [a, b] = args.positionals.slice(1)
        if (!a || !b) throw new UsageError("Usage: tokenmon compare <A> <B>   e.g. tokenmon compare last-week week")
        return await withReadDb(args, io, (db) => renderCompare(compareRanges(db, parseRangeExpression(a, io.now(), tz()), parseRangeExpression(b, io.now(), tz()), filtersOf(args))))
      }
      case "live":
        return await live(args, io)
      case "import": {
        const hostDbPath = flag(args, "opencode-db") ?? resolveOpencodeDbPath()
        if (!existsSync(hostDbPath)) throw new UsageError(`OpenCode database not found at ${hostDbPath}. Pass --opencode-db (see \`opencode db path\`).`)
        const since = flag(args, "since") ? parseBoundary(flag(args, "since")!, tz()).instant : undefined
        const repo = await openForWrite(args)
        try {
          const result = await importFromOpencode(repo, { hostDbPath, since })
          emit(args, io, {
            json: { schemaVersion: "1.0.0", kind: "import", ...result },
            text: () =>
              `Imported from ${result.hostDbPath}\n` +
              `sessions: ${result.sessions}, messages: ${result.messages}, tools: ${result.tools}, commands: ${result.commands}\n` +
              `steps: ${result.steps.inserted} new, ${result.steps.alreadyPresent} already recorded by the plugin or a previous import` +
              (result.steps.mismatched ? `, ${result.steps.mismatched} differed and were corrected from OpenCode's storage` : ""),
          })
          return 0
        } finally {
          repo.db.close()
        }
      }
      case "doctor": {
        const report = await doctor(dbPathOf(args))
        emit(args, io, {
          json: report,
          text: () => {
            const d = report.database
            return [
              `tokenmon ${report.cliVersion} on ${report.runtime.name} ${report.runtime.version}${report.runtime.sqliteDriver ? ` (${report.runtime.sqliteDriver})` : ""}`,
              `database: ${d.path} (${d.reason})`,
              `  status: ${d.status}${d.error ? ` — ${d.error}` : ""}; schema ${d.schemaVersion ?? "-"} (supported ${d.supportedSchemaVersion}); size ${fmtInt(d.sizeBytes)} B; wal ${fmtInt(d.walBytes)} B`,
              d.counts ? `  rows: ${Object.entries(d.counts).map(([k, v]) => `${k}=${v}`).join(", ")}` : "",
              `  last step: ${d.lastStepAt ?? "-"}; last import: ${d.lastImport ? JSON.stringify(d.lastImport) : "-"}`,
              `plugin bundle: ${report.plugin.localBundle.path} (${report.plugin.localBundle.exists ? "present" : "absent"})`,
              report.plugin.npmDeclaration ? `npm declaration: ${report.plugin.npmDeclaration}` : "npm declaration: none",
              `recent plugin loads: ${report.plugin.recentLoads.length ? report.plugin.recentLoads.map((l) => `${l.at} ${JSON.stringify(l.info)}`).join("\n  ") : "none recorded"}`,
              `duplicate loads observed: ${report.plugin.duplicateLoadsObserved}`,
              `OpenCode database: ${report.opencode.dbPath} (${report.opencode.exists ? "present" : "absent"})`,
              report.fingerprints.length ? `config fingerprints: ${report.fingerprints.map((f) => `${f.id} [${f.scope.join(",")}] files=${f.fileCount}${f.partial ? " partial" : ""}`).join("; ")}` : "",
              report.recentProblems.length ? `recent problems:\n  ${report.recentProblems.map((p) => `${p.at} ${p.level} ${p.code}: ${p.message}`).join("\n  ")}` : "recent problems: none",
            ]
              .filter(Boolean)
              .join("\n")
          },
        })
        return 0
      }
      case "install-plugin": {
        const from = flag(args, "from")
        const bundle = from ? readFileSync(from, "utf8") : embeddedBundle()
        if (!bundle) throw new UsageError("This build has no embedded plugin bundle; pass --from <opencode-token-monitor.js>")
        const result = installPlugin({ bundle, dest: flag(args, "dest"), force: has(args, "force"), dryRun: has(args, "dry-run") })
        emit(args, io, {
          json: { schemaVersion: "1.0.0", kind: "install-plugin", ...result },
          text: () => [`${result.action}: ${result.target}`, `sha256: ${result.sha256}`, result.backup ? `backup: ${result.backup}` : "", ...result.warnings.map((w) => `warning: ${w}`)].filter(Boolean).join("\n"),
        })
        return 0
      }
      case "data":
        return await dataCommand(args, io)
      default:
        throw new UsageError(`Unknown command "${command}". Run tokenmon --help.`)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`)
      return 2
    }
    io.err(`error: ${(error as Error).message}\n`)
    return 1
  }
}

async function dataCommand(args: ParsedArgs, io: Io): Promise<number> {
  const sub = args.positionals[1]
  const { path } = dbPathOf(args)
  if (sub === "purge") {
    if (!has(args, "yes")) throw new UsageError(`This permanently deletes ${path} and its WAL/SHM files. Re-run with --yes to confirm.`)
    const removed = purgeFiles(path)
    io.out(removed.length ? `removed:\n${removed.join("\n")}\n` : `nothing to remove at ${path}\n`)
    return 0
  }
  if (sub !== "prune" && sub !== "vacuum") throw new UsageError("Usage: tokenmon data prune --before DATE | data vacuum | data purge --yes")
  if (!existsSync(path)) {
    io.err(NO_DATA(path) + "\n")
    return 3
  }
  const repo = await openForWrite(args)
  try {
    if (sub === "prune") {
      const before = flag(args, "before")
      if (!before) throw new UsageError("data prune requires --before DATE")
      const instant = parseBoundary(before, tzOf(args)).instant
      const result = prune(repo.db, instant)
      emit(args, io, { json: { schemaVersion: "1.0.0", kind: "prune", before: new Date(instant).toISOString(), deleted: result }, text: () => `deleted rows before ${new Date(instant).toISOString()}:\n${Object.entries(result).map(([k, v]) => `  ${k}: ${v}`).join("\n")}` })
    } else {
      const r = vacuum(repo.db)
      emit(args, io, { json: { schemaVersion: "1.0.0", kind: "vacuum", ...r }, text: () => `size: ${fmtInt(r.before)} B → ${fmtInt(r.after)} B` })
    }
    return 0
  } finally {
    repo.db.close()
  }
}
