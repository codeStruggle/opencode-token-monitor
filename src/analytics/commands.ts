import type { Db } from "../db/driver.ts"
import type { TimeRange } from "../time/range.ts"
import { Attribution } from "./attribution.ts"
import { loadSessionsWithAncestors, loadSteps, type Filters } from "./data.ts"
import { envelope, type Envelope } from "./dto.ts"
import { addStep, addTotals, emptyTotals, roundCost, sumSteps, type UsageTotals } from "./totals.ts"

export type CommandRunUsage = {
  id: string
  name: string
  sessionId: string
  startedAt: number | null
  /** Usage of the turn the command started, in its own session. */
  direct: UsageTotals
  /** Usage of child sessions explicitly spawned from that turn (recursively). */
  descendant: UsageTotals
  inclusive: UsageTotals
}

export type CommandNameUsage = { name: string; runs: number; direct: UsageTotals; descendant: UsageTotals; inclusive: UsageTotals }

export type CommandBreakdown = Envelope<
  "commands",
  {
    totals: UsageTotals
    byName: CommandNameUsage[]
    runs: CommandRunUsage[]
    /** Usage not attributable to any command; listed separately, never folded into a command. */
    unattributed: { plainPrompts: UsageTotals; unlinkedChildSessions: UsageTotals }
    /** Commands observed without a linked turn (e.g. failed before a message was created). */
    unlinkedRuns: number
  }
>

export function queryCommands(db: Db, range: TimeRange, filters: Filters = {}): CommandBreakdown {
  const steps = loadSteps(db, range, filters)
  const sessions = loadSessionsWithAncestors(db, new Set(steps.map((s) => s.sessionId)))
  const attribution = new Attribution(db, sessions)
  const runs = new Map<string, CommandRunUsage>()
  const plain = emptyTotals()
  const unlinked = emptyTotals()
  const runInfo = db.prepare(`SELECT id, name, session_id, started_at FROM command_runs WHERE id = ?`)

  for (const s of steps) {
    const link = attribution.commandOf(s)
    if (link.commandRunId === null) {
      addStep(link.via === "unlinked" ? unlinked : plain, s)
      continue
    }
    let run = runs.get(link.commandRunId)
    if (!run) {
      const info = runInfo.get(link.commandRunId)
      run = {
        id: link.commandRunId,
        name: link.commandName,
        sessionId: String(info?.session_id ?? ""),
        startedAt: info?.started_at === undefined || info?.started_at === null ? null : Number(info.started_at),
        direct: emptyTotals(),
        descendant: emptyTotals(),
        inclusive: emptyTotals(),
      }
      runs.set(link.commandRunId, run)
    }
    const target: CommandRunUsage = run
    addStep(link.via === "direct" ? target.direct : target.descendant, s)
    addStep(target.inclusive, s)
  }

  const byName = new Map<string, CommandNameUsage>()
  for (const r of runs.values()) {
    const g = byName.get(r.name) ?? { name: r.name, runs: 0, direct: emptyTotals(), descendant: emptyTotals(), inclusive: emptyTotals() }
    g.runs++
    g.direct = addTotals(g.direct, r.direct)
    g.descendant = addTotals(g.descendant, r.descendant)
    g.inclusive = addTotals(g.inclusive, r.inclusive)
    byName.set(r.name, g)
  }

  const unlinkedRuns = Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM command_runs WHERE user_message_id IS NULL AND started_at >= ? AND started_at < ?`)
      .get(range.start, range.end)?.n ?? 0,
  )
  const notes = [
    "inclusive = direct + descendant. Rows are per command; do not add inclusive rows to the unattributed rows' parents.",
    "Descendant usage is counted only for child sessions with an observed task-tool link to the command's turn.",
  ]
  return envelope(
    "commands",
    range,
    {
      totals: roundCost(sumSteps(steps)),
      byName: [...byName.values()]
        .sort((a, b) => b.inclusive.totalTokens - a.inclusive.totalTokens)
        .map((g) => ({ ...g, direct: roundCost(g.direct), descendant: roundCost(g.descendant), inclusive: roundCost(g.inclusive) })),
      runs: [...runs.values()]
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
        .map((r) => ({ ...r, direct: roundCost(r.direct), descendant: roundCost(r.descendant), inclusive: roundCost(r.inclusive) })),
      unattributed: { plainPrompts: roundCost(plain), unlinkedChildSessions: roundCost(unlinked) },
      unlinkedRuns,
    },
    notes,
  )
}
