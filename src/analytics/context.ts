import type { Db, SqlValue } from "../db/driver.ts"
import type { TimeRange } from "../time/range.ts"
import { envelope, type Envelope } from "./dto.ts"

export type ContextCategoryEstimate = {
  category: string
  source: string | null
  /** ESTIMATED tokens (method below); never a billed value. */
  estimatedTokens: number
  chars: number
  /** Estimate scaled down so the total never exceeds the actual prompt; an allocation, not a measurement. */
  allocatedTokens: number
  method: string
}

export type ContextAnalysis = Envelope<
  "context",
  {
    sessionId: string | null
    requests: { linked: number; withoutStep: number }
    steps: { total: number; withContext: number; withoutContext: number }
    /** EXACT: input + cache read + cache write of the steps that have context estimates. */
    actualPromptTokens: number
    estimatedTotalTokens: number
    /** Part of the actual prompt not explained by any observed source (max(actual - estimated, 0)). */
    unknownTokens: number
    /** Estimate in excess of the actual prompt (max(estimated - actual, 0)). */
    overEstimateTokens: number
    /** min(estimated, actual) / actual; how much of the prompt observed sources can explain. Not an accuracy. */
    coverage: number | null
    categories: ContextCategoryEstimate[]
  }
>

export function queryContext(db: Db, range: TimeRange, opts: { sessionId?: string; bySource?: boolean } = {}): ContextAnalysis {
  const sessionFilter = opts.sessionId ? "AND st.session_id = ?" : ""
  const params: SqlValue[] = [range.start, range.end, ...(opts.sessionId ? [opts.sessionId] : [])]
  const linked = db
    .prepare(
      `SELECT r.id AS request_id, st.input_tokens, st.cache_read_tokens, st.cache_write_tokens
       FROM llm_requests r JOIN llm_steps st ON st.id = r.step_id
       WHERE st.ts >= ? AND st.ts < ? ${sessionFilter}`,
    )
    .all(...params)
  const totalSteps = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM llm_steps st WHERE st.ts >= ? AND st.ts < ? ${sessionFilter}`).get(...params)?.n ?? 0,
  )
  const withoutStep = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM llm_requests r WHERE r.step_id IS NULL AND r.ts >= ? AND r.ts < ? ${
          opts.sessionId ? "AND r.session_id = ?" : ""
        }`,
      )
      .get(...params)?.n ?? 0,
  )

  let actual = 0
  for (const r of linked) actual += Number(r.input_tokens ?? 0) + Number(r.cache_read_tokens ?? 0) + Number(r.cache_write_tokens ?? 0)

  const groupCols = opts.bySource ? "cs.category, cs.source" : "cs.category"
  const cats = db
    .prepare(
      `SELECT ${groupCols}, SUM(cs.est_tokens) AS est, SUM(cs.chars) AS chars, MIN(cs.method) AS method
       FROM context_sources cs
       JOIN llm_requests r ON r.id = cs.request_id
       JOIN llm_steps st ON st.id = r.step_id
       WHERE st.ts >= ? AND st.ts < ? ${sessionFilter}
       GROUP BY ${groupCols} ORDER BY est DESC`,
    )
    .all(...params)

  const estimated = cats.reduce((a, c) => a + Number(c.est ?? 0), 0)
  const scale = estimated > actual && estimated > 0 ? actual / estimated : 1
  const categories: ContextCategoryEstimate[] = cats.map((c) => ({
    category: String(c.category),
    source: opts.bySource ? String(c.source) : null,
    estimatedTokens: Number(c.est ?? 0),
    chars: Number(c.chars ?? 0),
    allocatedTokens: Math.round(Number(c.est ?? 0) * scale),
    method: String(c.method),
  }))
  const unknown = Math.max(actual - estimated, 0)
  if (actual > 0) {
    categories.push({ category: "unknown", source: null, estimatedTokens: unknown, chars: 0, allocatedTokens: unknown, method: "residual" })
  }

  const notes = [
    "Context sizes are ESTIMATES (characters / 4) of what OpenCode sent; provider input tokens cannot be split exactly.",
    "allocatedTokens scales estimates down only when they exceed the actual prompt; the raw estimate is kept in estimatedTokens.",
  ]
  if (totalSteps > linked.length) {
    notes.push(`${totalSteps - linked.length} step(s) have no context data (imported history or requests not observed by the plugin).`)
  }
  return envelope(
    "context",
    range,
    {
      sessionId: opts.sessionId ?? null,
      requests: { linked: linked.length, withoutStep },
      steps: { total: totalSteps, withContext: linked.length, withoutContext: totalSteps - linked.length },
      actualPromptTokens: actual,
      estimatedTotalTokens: estimated,
      unknownTokens: unknown,
      overEstimateTokens: Math.max(estimated - actual, 0),
      coverage: actual > 0 ? Math.min(estimated, actual) / actual : null,
      categories,
    },
    notes,
  )
}
