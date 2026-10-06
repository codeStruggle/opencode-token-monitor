import type { Db } from "../db/driver.ts"
import { describeRange, type TimeRange } from "../time/range.ts"
import { loadSessionsWithAncestors, loadSteps, rootOf, type Filters, type StepRow } from "./data.ts"
import { envelope, type Envelope } from "./dto.ts"
import { roundCost, sumSteps, type UsageTotals } from "./totals.ts"

export type CompareSide = {
  label: string
  range: ReturnType<typeof describeRange> | null
  totals: UsageTotals
  rootSessions: number
  models: string[]
  avgTokensPerStep: number | null
  avgTokensPerRootSession: number | null
  avgCostPerRootSession: number | null
}

export type ComparisonResult = Envelope<
  "compare",
  {
    by: "range" | "fingerprint" | "branch"
    sides: CompareSide[]
    delta: { totalTokens: number; totalTokensPct: number | null; avgTokensPerRootSessionPct: number | null } | null
    caveats: string[]
  }
>

function side(db: Db, label: string, steps: StepRow[], range: TimeRange | null): CompareSide {
  const totals = roundCost(sumSteps(steps))
  const sessions = loadSessionsWithAncestors(db, new Set(steps.map((s) => s.sessionId)))
  const roots = new Set(steps.map((s) => rootOf(sessions, s.sessionId)))
  return {
    label,
    range: range ? describeRange(range) : null,
    totals,
    rootSessions: roots.size,
    models: [...new Set(steps.map((s) => (s.provider ? `${s.provider}/${s.model}` : (s.model ?? "unknown"))))].sort(),
    avgTokensPerStep: totals.steps ? totals.totalTokens / totals.steps : null,
    avgTokensPerRootSession: roots.size ? totals.totalTokens / roots.size : null,
    avgCostPerRootSession: roots.size && totals.costKnownSteps ? totals.cost / roots.size : null,
  }
}

const pct = (a: number | null, b: number | null) => (a === null || b === null || a === 0 ? null : ((b - a) / a) * 100)

function caveatsFor(sides: CompareSide[]): string[] {
  const out = ["Differences are correlations; they do not prove that a configuration or period caused them."]
  if (sides.some((s) => s.rootSessions < 10)) out.push("Small sample: at least one side has fewer than 10 root sessions.")
  const modelSets = sides.map((s) => s.models.join(","))
  if (new Set(modelSets).size > 1) out.push("Model mix differs between sides; token counts are not directly comparable.")
  if (sides.some((s) => s.totals.costUnavailableSteps > 0)) out.push("Some steps have no known price; cost comparisons are partial.")
  return out
}

export function compareRanges(db: Db, a: TimeRange, b: TimeRange, filters: Filters = {}): ComparisonResult {
  const sa = side(db, a.label, loadSteps(db, a, filters), a)
  const sb = side(db, b.label, loadSteps(db, b, filters), b)
  const caveats = caveatsFor([sa, sb])
  return envelope(
    "compare",
    { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), timezone: a.timezone, label: `${a.label} vs ${b.label}` },
    {
      by: "range",
      sides: [sa, sb],
      delta: {
        totalTokens: sb.totals.totalTokens - sa.totals.totalTokens,
        totalTokensPct: pct(sa.totals.totalTokens, sb.totals.totalTokens),
        avgTokensPerRootSessionPct: pct(sa.avgTokensPerRootSession, sb.avgTokensPerRootSession),
      },
      caveats,
    },
    caveats,
  )
}

/** Groups one range by configuration fingerprint or Git branch of the root session. */
export function compareBy(db: Db, range: TimeRange, by: "fingerprint" | "branch", filters: Filters = {}): ComparisonResult {
  const steps = loadSteps(db, range, filters)
  const sessions = loadSessionsWithAncestors(db, new Set(steps.map((s) => s.sessionId)))
  const branchStmt = db.prepare(`SELECT available, branch FROM git_snapshots WHERE session_id = ?`)
  const groups = new Map<string, StepRow[]>()
  for (const s of steps) {
    const root = rootOf(sessions, s.sessionId)
    let key: string
    if (by === "fingerprint") key = sessions.get(root)?.configFingerprint ?? "(unknown)"
    else {
      const g = branchStmt.get(root)
      key = !g ? "(unknown)" : Number(g.available) === 1 ? String(g.branch ?? "(detached)") : "(not a git repo)"
    }
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const sides = [...groups.entries()].map(([k, v]) => side(db, k, v, null)).sort((x, y) => y.totals.totalTokens - x.totals.totalTokens)
  const caveats = caveatsFor(sides)
  if (by === "fingerprint") caveats.push("Fingerprints cover file-based config sources only; see `partial` in doctor output.")
  return envelope("compare", range, { by, sides, delta: null, caveats }, caveats)
}
