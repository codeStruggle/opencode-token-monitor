import type { Db } from "../db/driver.ts"
import { naturalRange } from "../time/range.ts"
import { Attribution } from "./attribution.ts"
import { loadDescendants, loadSessionsWithAncestors, loadStepsForSessions, rootOf, type StepRow } from "./data.ts"
import { envelope, type Envelope } from "./dto.ts"
import { addTotals, roundCost, sumSteps, type UsageTotals } from "./totals.ts"

export type TraceTool = { id: string; tool: string; status: string; durationMs: number | null; childSessionId: string | null }

export type TraceCommand = { id: string; name: string; direct: UsageTotals; descendant: UsageTotals; inclusive: UsageTotals }

export type TraceNode = {
  sessionId: string
  parentId: string | null
  agent: string | null
  spawnedBy: { sessionId: string; messageId: string; toolRunId: string; commandName: string | null } | null
  exclusive: UsageTotals
  inclusive: UsageTotals
  models: string[]
  commands: TraceCommand[]
  tools: { total: number; byTool: Record<string, number>; errors: number; calls: TraceTool[] }
  children: TraceNode[]
}

export type SessionTrace = Envelope<
  "trace",
  {
    rootSessionId: string
    requestedSessionId: string
    git: { available: boolean; commit: string | null; branch: string | null; dirty: boolean | null } | null
    configFingerprint: string | null
    tree: TraceNode
    check: { sumOfExclusive: UsageTotals; rootInclusive: UsageTotals; consistent: boolean }
  }
>

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`)
  }
}

export function resolveSessionId(db: Db, idOrSuffix: string): string {
  const exact = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(idOrSuffix)
  if (exact) return idOrSuffix
  const matches = db.prepare(`SELECT id FROM sessions WHERE id LIKE ? LIMIT 2`).all(`%${idOrSuffix}`)
  if (matches.length === 1) return String(matches[0]!.id)
  if (matches.length > 1) throw new Error(`Session id "${idOrSuffix}" is ambiguous`)
  throw new SessionNotFoundError(idOrSuffix)
}

export function querySessionTrace(db: Db, sessionId: string, tz: string): SessionTrace {
  const requested = resolveSessionId(db, sessionId)
  const ancestors = loadSessionsWithAncestors(db, [requested])
  const rootId = rootOf(ancestors, requested)
  const sessions = loadDescendants(db, rootId)
  if (!sessions.size) throw new SessionNotFoundError(sessionId)
  const steps = loadStepsForSessions(db, sessions.keys())
  const attribution = new Attribution(db, sessions)
  const stepsBySession = new Map<string, StepRow[]>()
  for (const s of steps) stepsBySession.set(s.sessionId, [...(stepsBySession.get(s.sessionId) ?? []), s])

  const toolStmt = db.prepare(
    `SELECT id, tool, status, started_at, ended_at, child_session_id FROM tool_runs WHERE session_id = ? ORDER BY started_at, id`,
  )
  const cmdStmt = db.prepare(`SELECT id, name FROM command_runs WHERE session_id = ? ORDER BY started_at`)

  const build = (id: string, depth: number): TraceNode => {
    const session = sessions.get(id)
    const own = stepsBySession.get(id) ?? []
    const children = depth < 64 ? [...sessions.values()].filter((s) => s.parentId === id).map((c) => build(c.id, depth + 1)) : []
    const exclusive = sumSteps(own)
    const inclusive = children.reduce((acc, c) => addTotals(acc, c.inclusive), exclusive)
    const calls: TraceTool[] = toolStmt.all(id).map((t) => ({
      id: String(t.id),
      tool: String(t.tool),
      status: String(t.status),
      durationMs: t.started_at !== null && t.ended_at !== null ? Number(t.ended_at) - Number(t.started_at) : null,
      childSessionId: t.child_session_id === null ? null : String(t.child_session_id),
    }))
    const byTool: Record<string, number> = {}
    for (const c of calls) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1
    const link = attribution.spawnedBy(id)
    const commands: TraceCommand[] = cmdStmt.all(id).map((c) => {
      const cid = String(c.id)
      const direct = sumSteps(own.filter((s) => attribution.commandOf(s).commandRunId === cid))
      const descendant = sumSteps(steps.filter((s) => s.sessionId !== id && attribution.commandOf(s).commandRunId === cid))
      return { id: cid, name: String(c.name), direct: roundCost(direct), descendant: roundCost(descendant), inclusive: roundCost(addTotals(direct, descendant)) }
    })
    return {
      sessionId: id,
      parentId: session?.parentId ?? null,
      agent: session?.agent ?? null,
      spawnedBy: link
        ? { ...link, commandName: attribution.commandForTurn(attribution.turnRoot(link.sessionId, link.messageId))?.name ?? null }
        : null,
      exclusive: roundCost(exclusive),
      inclusive: roundCost(inclusive),
      models: [...new Set(own.map((s) => (s.provider ? `${s.provider}/${s.model}` : (s.model ?? "unknown"))))],
      commands,
      tools: { total: calls.length, byTool, errors: calls.filter((c) => c.status === "error").length, calls },
      children,
    }
  }

  const tree = build(rootId, 0)
  const sumOfExclusive = roundCost(sumSteps(steps))
  const git = db.prepare(`SELECT available, commit_sha, branch, dirty FROM git_snapshots WHERE session_id = ?`).get(rootId)
  const range = naturalRange("all", Date.now(), tz)
  return envelope("trace", range, {
    rootSessionId: rootId,
    requestedSessionId: requested,
    git: git
      ? {
          available: Number(git.available) === 1,
          commit: git.commit_sha === null ? null : String(git.commit_sha),
          branch: git.branch === null ? null : String(git.branch),
          dirty: git.dirty === null ? null : Number(git.dirty) === 1,
        }
      : null,
    configFingerprint: sessions.get(rootId)?.configFingerprint ?? null,
    tree,
    check: {
      sumOfExclusive,
      rootInclusive: tree.inclusive,
      consistent: sumOfExclusive.totalTokens === tree.inclusive.totalTokens && sumOfExclusive.steps === tree.inclusive.steps,
    },
  })
}
