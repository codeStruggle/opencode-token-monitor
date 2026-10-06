import type { Db } from "../db/driver.ts"
import type { TimeRange } from "../time/range.ts"
import { loadDescendants, loadSteps, loadStepsForSessions, loadSessionsWithAncestors, rootOf, type Filters } from "./data.ts"
import { envelope, type Envelope } from "./dto.ts"
import { roundCost, sumSteps, type UsageTotals } from "./totals.ts"

export type SessionListItem = {
  rootSessionId: string
  projectId: string | null
  directory: string | null
  agent: string | null
  createdAt: number | null
  childSessions: number
  /** Whole tree (root + descendants), all time. */
  inclusive: UsageTotals
  /** Steps of this tree that fall inside the requested range. */
  inRange: UsageTotals
}

export type SessionList = Envelope<"sessions", { sessions: SessionListItem[] }>

export function listSessions(db: Db, range: TimeRange, filters: Filters = {}, limit = 20): SessionList {
  const steps = loadSteps(db, range, filters)
  const sessions = loadSessionsWithAncestors(db, new Set(steps.map((s) => s.sessionId)))
  const byRoot = new Map<string, typeof steps>()
  for (const s of steps) {
    const root = rootOf(sessions, s.sessionId)
    byRoot.set(root, [...(byRoot.get(root) ?? []), s])
  }
  const items: SessionListItem[] = []
  for (const [root, inRange] of byRoot) {
    const tree = loadDescendants(db, root)
    const info = tree.get(root) ?? sessions.get(root)
    items.push({
      rootSessionId: root,
      projectId: info?.projectId ?? null,
      directory: info?.directory ?? null,
      agent: info?.agent ?? null,
      createdAt: info?.createdAt ?? null,
      childSessions: Math.max(tree.size - 1, 0),
      inclusive: roundCost(sumSteps(loadStepsForSessions(db, tree.keys()))),
      inRange: roundCost(sumSteps(inRange)),
    })
  }
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return envelope("sessions", range, { sessions: items.slice(0, limit) })
}
