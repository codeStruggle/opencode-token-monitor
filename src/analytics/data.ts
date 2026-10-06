import type { Db, Row, SqlValue } from "../db/driver.ts"
import type { TimeRange } from "../time/range.ts"

export type StepRow = {
  id: string
  sessionId: string
  messageId: string
  ts: number
  provider: string | null
  model: string | null
  agent: string | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
  cost: number | null
  costSource: string
  seenByPlugin: boolean
  seenByImport: boolean
  importMismatch: boolean
}

export type SessionRow = {
  id: string
  projectId: string | null
  parentId: string | null
  directory: string | null
  agent: string | null
  configFingerprint: string | null
  createdAt: number | null
}

export type Filters = {
  project?: string
  session?: string
  provider?: string
  model?: string
  agent?: string
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function toStep(r: Row): StepRow {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    messageId: String(r.message_id),
    ts: Number(r.ts),
    provider: s(r.provider),
    model: s(r.model),
    agent: s(r.agent),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    reasoningTokens: n(r.reasoning_tokens),
    cacheReadTokens: n(r.cache_read_tokens),
    cacheWriteTokens: n(r.cache_write_tokens),
    totalTokens: n(r.total_tokens),
    cost: n(r.cost),
    costSource: String(r.cost_source),
    seenByPlugin: Number(r.seen_by_plugin) === 1,
    seenByImport: Number(r.seen_by_import) === 1,
    importMismatch: Number(r.import_mismatch) === 1,
  }
}

function toSession(r: Row): SessionRow {
  return {
    id: String(r.id),
    projectId: s(r.project_id),
    parentId: s(r.parent_id),
    directory: s(r.directory),
    agent: s(r.agent),
    configFingerprint: s(r.config_fingerprint),
    createdAt: n(r.created_at),
  }
}

export function loadSteps(db: Db, range: TimeRange, filters: Filters = {}): StepRow[] {
  const where = ["st.ts >= ?", "st.ts < ?"]
  const params: SqlValue[] = [range.start, range.end]
  if (filters.provider) {
    where.push("st.provider = ?")
    params.push(filters.provider)
  }
  if (filters.model) {
    where.push("st.model = ?")
    params.push(filters.model)
  }
  if (filters.agent) {
    where.push("st.agent = ?")
    params.push(filters.agent)
  }
  if (filters.session) {
    where.push("st.session_id = ?")
    params.push(filters.session)
  }
  if (filters.project) {
    where.push("st.session_id IN (SELECT id FROM sessions WHERE project_id = ? OR directory = ?)")
    params.push(filters.project, filters.project)
  }
  return db
    .prepare(`SELECT st.* FROM llm_steps st WHERE ${where.join(" AND ")} ORDER BY st.ts, st.id`)
    .all(...params)
    .map(toStep)
}

export function loadStepsForSessions(db: Db, sessionIds: Iterable<string>): StepRow[] {
  const out: StepRow[] = []
  const stmt = db.prepare(`SELECT * FROM llm_steps WHERE session_id = ? ORDER BY ts, id`)
  for (const id of sessionIds) out.push(...stmt.all(id).map(toStep))
  return out
}

/** Loads the given sessions plus all their ancestors. */
export function loadSessionsWithAncestors(db: Db, ids: Iterable<string>): Map<string, SessionRow> {
  const out = new Map<string, SessionRow>()
  const stmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`)
  const queue = [...new Set(ids)]
  while (queue.length) {
    const id = queue.pop()!
    if (out.has(id)) continue
    const row = stmt.get(id)
    if (!row) continue
    const session = toSession(row)
    out.set(id, session)
    if (session.parentId && !out.has(session.parentId)) queue.push(session.parentId)
  }
  return out
}

export function loadDescendants(db: Db, rootId: string): Map<string, SessionRow> {
  const out = new Map<string, SessionRow>()
  const self = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(rootId)
  if (self) out.set(rootId, toSession(self))
  const children = db.prepare(`SELECT * FROM sessions WHERE parent_id = ?`)
  const queue = [rootId]
  while (queue.length) {
    const id = queue.pop()!
    for (const row of children.all(id)) {
      const child = toSession(row)
      if (out.has(child.id)) continue
      out.set(child.id, child)
      queue.push(child.id)
    }
  }
  return out
}

/** Topmost known ancestor; if a parent row is missing, the parent id itself is the root. */
export function rootOf(sessions: Map<string, SessionRow>, id: string): string {
  let current = id
  const seen = new Set([id])
  while (true) {
    const parent = sessions.get(current)?.parentId
    if (!parent || seen.has(parent)) return current
    if (!sessions.has(parent)) return parent
    seen.add(parent)
    current = parent
  }
}
