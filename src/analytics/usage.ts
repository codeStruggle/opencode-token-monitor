import type { Db } from "../db/driver.ts"
import { formatDate, toCivil } from "../time/zone.ts"
import type { TimeRange } from "../time/range.ts"
import { Attribution } from "./attribution.ts"
import { loadSessionsWithAncestors, loadSteps, rootOf, type Filters, type SessionRow, type StepRow } from "./data.ts"
import { envelope, type GroupKey, type UsageSummary } from "./dto.ts"
import { addStep, emptyTotals, roundCost, sumSteps, type UsageTotals } from "./totals.ts"

export const GROUP_DIMENSIONS = [
  "project",
  "session",
  "root-session",
  "provider",
  "model",
  "agent",
  "command",
  "command-link",
  "day",
  "branch",
  "commit",
  "dirty",
  "fingerprint",
  "cost-source",
] as const
export type GroupDimension = (typeof GROUP_DIMENSIONS)[number]

export function parseGroupBy(text: string | undefined): GroupDimension[] {
  if (!text) return []
  const dims = text.split(",").map((d) => d.trim()).filter(Boolean)
  for (const d of dims) {
    if (!(GROUP_DIMENSIONS as readonly string[]).includes(d)) {
      throw new Error(`Unknown group "${d}". Use: ${GROUP_DIMENSIONS.join(", ")}`)
    }
  }
  return dims as GroupDimension[]
}

type GitRow = { available: boolean; commit: string | null; branch: string | null; dirty: boolean | null }

/** Resolves dimension values per step; heavy lookups are loaded only when a dimension needs them. */
export class DimensionResolver {
  private sessions: Map<string, SessionRow> = new Map()
  private attribution: Attribution | null = null
  private git = new Map<string, GitRow | null>()

  constructor(
    private readonly db: Db,
    steps: StepRow[],
    private readonly dims: readonly GroupDimension[],
    private readonly tz: string,
  ) {
    const needsSessions = dims.some((d) =>
      ["project", "root-session", "command", "command-link", "branch", "commit", "dirty", "fingerprint"].includes(d),
    )
    if (needsSessions) this.sessions = loadSessionsWithAncestors(db, new Set(steps.map((s) => s.sessionId)))
    if (dims.includes("command") || dims.includes("command-link")) this.attribution = new Attribution(db, this.sessions)
  }

  private gitOf(sessionId: string): GitRow | null {
    const root = rootOf(this.sessions, sessionId)
    if (!this.git.has(root)) {
      const r = this.db.prepare(`SELECT available, commit_sha, branch, dirty FROM git_snapshots WHERE session_id = ?`).get(root)
      this.git.set(
        root,
        r
          ? {
              available: Number(r.available) === 1,
              commit: r.commit_sha === null ? null : String(r.commit_sha),
              branch: r.branch === null ? null : String(r.branch),
              dirty: r.dirty === null ? null : Number(r.dirty) === 1,
            }
          : null,
      )
    }
    return this.git.get(root) ?? null
  }

  value(dim: GroupDimension, s: StepRow): string | null {
    switch (dim) {
      case "project": {
        const session = this.sessions.get(s.sessionId)
        return session?.projectId ?? session?.directory ?? null
      }
      case "session":
        return s.sessionId
      case "root-session":
        return rootOf(this.sessions, s.sessionId)
      case "provider":
        return s.provider
      case "model":
        return s.provider && s.model ? `${s.provider}/${s.model}` : s.model
      case "agent":
        return s.agent
      case "command": {
        const link = this.attribution!.commandOf(s)
        return link.commandName ? `/${link.commandName}` : link.via === "unlinked" ? "(unlinked child session)" : "(no command)"
      }
      case "command-link":
        return this.attribution!.commandOf(s).via
      case "day": {
        const c = toCivil(s.ts, this.tz)
        return formatDate(c)
      }
      case "branch": {
        const g = this.gitOf(s.sessionId)
        return g === null ? null : g.available ? g.branch : "(not a git repo)"
      }
      case "commit": {
        const g = this.gitOf(s.sessionId)
        return g === null ? null : g.available ? (g.commit?.slice(0, 12) ?? null) : "(not a git repo)"
      }
      case "dirty": {
        const g = this.gitOf(s.sessionId)
        return g === null || !g.available || g.dirty === null ? null : g.dirty ? "dirty" : "clean"
      }
      case "fingerprint":
        return this.sessions.get(rootOf(this.sessions, s.sessionId))?.configFingerprint ?? this.sessions.get(s.sessionId)?.configFingerprint ?? null
      case "cost-source":
        return s.costSource
    }
  }

  key(s: StepRow): GroupKey {
    const key: GroupKey = {}
    for (const d of this.dims) key[d] = this.value(d, s)
    return key
  }
}

export type UsageQuery = { range: TimeRange; groupBy?: GroupDimension[]; filters?: Filters; limit?: number }

export function queryUsage(db: Db, q: UsageQuery): UsageSummary {
  const dims = q.groupBy ?? []
  const steps = loadSteps(db, q.range, q.filters)
  const totals = sumSteps(steps)
  const groups = new Map<string, { key: GroupKey; totals: UsageTotals }>()
  if (dims.length) {
    const resolver = new DimensionResolver(db, steps, dims, q.range.timezone)
    for (const s of steps) {
      const key = resolver.key(s)
      const id = JSON.stringify(key)
      let g = groups.get(id)
      if (!g) groups.set(id, (g = { key, totals: emptyTotals() }))
      addStep(g.totals, s)
    }
  }
  let sorted = [...groups.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)))
  if (dims.length === 1 && dims[0] === "day") sorted = sorted.sort((a, b) => String(a.key.day).localeCompare(String(b.key.day)))
  if (q.limit) sorted = sorted.slice(0, q.limit)
  const notes: string[] = []
  if (totals.costUnavailableSteps) {
    notes.push(`${totals.costUnavailableSteps} step(s) have no known price; their cost is excluded from the cost total.`)
  }
  if (totals.stepsWithMissingTokens) notes.push(`${totals.stepsWithMissingTokens} step(s) have missing token counters.`)
  const auxiliary = countUnrecordedAuxiliaryRequests(db, q.range)
  if (auxiliary) {
    notes.push(
      `${auxiliary} auxiliary request(s) (e.g. session title generation) were observed; OpenCode does not record their usage, so they are not included.`,
    )
  }
  return envelope(
    "usage",
    q.range,
    {
      groupBy: dims,
      totals: roundCost(totals),
      groups: sorted.map((g) => ({ key: g.key, totals: roundCost(g.totals) })),
      reconciliation: {
        stepsSeenByPlugin: steps.filter((s) => s.seenByPlugin).length,
        stepsSeenByImport: steps.filter((s) => s.seenByImport).length,
        importMismatches: steps.filter((s) => s.importMismatch).length,
      },
    },
    notes,
  )
}

export function countUnrecordedAuxiliaryRequests(db: Db, range: TimeRange): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM llm_requests WHERE step_id IS NULL AND agent IN ('title', 'summary') AND ts >= ? AND ts < ?`)
    .get(range.start, range.end)
  return Number(row?.n ?? 0)
}
