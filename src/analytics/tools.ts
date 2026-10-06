import type { Db } from "../db/driver.ts"
import type { TimeRange } from "../time/range.ts"
import { envelope, type Envelope } from "./dto.ts"

export type ToolStats = {
  tool: string
  calls: number
  completed: number
  errors: number
  other: number
  avgDurationMs: number | null
  totalOutputChars: number
  childSessions: number
}

export type ToolBreakdown = Envelope<"tools", { tools: ToolStats[] }>

/** Tool execution metadata. This is not provider-billed usage; see `context` for tool-result attribution. */
export function queryTools(db: Db, range: TimeRange, sessionId?: string): ToolBreakdown {
  const params = [range.start, range.end, ...(sessionId ? [sessionId] : [])]
  const rows = db
    .prepare(
      `SELECT tool,
              COUNT(*) AS calls,
              SUM(status = 'completed') AS completed,
              SUM(status = 'error') AS errors,
              AVG(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN ended_at - started_at END) AS avg_ms,
              SUM(COALESCE(output_length, 0)) AS out_chars,
              SUM(child_session_id IS NOT NULL) AS children
       FROM tool_runs
       WHERE COALESCE(started_at, ended_at, 0) >= ? AND COALESCE(started_at, ended_at, 0) < ?
       ${sessionId ? "AND session_id = ?" : ""}
       GROUP BY tool ORDER BY calls DESC, tool`,
    )
    .all(...params)
  return envelope(
    "tools",
    range,
    {
      tools: rows.map((r) => {
        const calls = Number(r.calls)
        const completed = Number(r.completed ?? 0)
        const errors = Number(r.errors ?? 0)
        return {
          tool: String(r.tool),
          calls,
          completed,
          errors,
          other: calls - completed - errors,
          avgDurationMs: r.avg_ms === null ? null : Math.round(Number(r.avg_ms)),
          totalOutputChars: Number(r.out_chars ?? 0),
          childSessions: Number(r.children ?? 0),
        }
      }),
    },
    ["Tool rows describe execution metadata only; they are not billed tokens."],
  )
}
