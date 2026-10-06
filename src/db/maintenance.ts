import { existsSync, rmSync, statSync } from "node:fs"
import type { Db } from "./driver.ts"

export type PruneResult = Record<string, number>

/**
 * Deletes history strictly older than `before` (epoch ms). Sessions are removed only when none of
 * their steps remain, so a session that spans the cut keeps its row and its newer usage.
 */
export function prune(db: Db, before: number): PruneResult {
  return db.transaction(() => {
    const result: PruneResult = {}
    const del = (name: string, sql: string, ...params: (number | string)[]) => {
      result[name] = db.prepare(sql).run(...params).changes
    }
    del(
      "context_sources",
      `DELETE FROM context_sources WHERE request_id IN (SELECT id FROM llm_requests WHERE ts < ?)`,
      before,
    )
    del("llm_requests", `DELETE FROM llm_requests WHERE ts < ?`, before)
    del("llm_steps", `DELETE FROM llm_steps WHERE ts < ?`, before)
    del("tool_runs", `DELETE FROM tool_runs WHERE COALESCE(ended_at, started_at, 0) < ?`, before)
    del("command_runs", `DELETE FROM command_runs WHERE started_at < ?`, before)
    del("messages", `DELETE FROM messages WHERE COALESCE(completed_at, created_at, 0) < ?`, before)
    del(
      "sessions",
      `DELETE FROM sessions WHERE COALESCE(updated_at, created_at, 0) < ?
         AND NOT EXISTS (SELECT 1 FROM llm_steps st WHERE st.session_id = sessions.id)`,
      before,
    )
    del("git_snapshots", `DELETE FROM git_snapshots WHERE session_id NOT IN (SELECT id FROM sessions)`)
    del("diagnostics", `DELETE FROM diagnostics WHERE ts < ?`, before)
    return result
  })
}

export function vacuum(db: Db): { before: number; after: number } {
  const size = () => (existsSync(db.path) ? statSync(db.path).size : 0)
  const before = size()
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.exec("VACUUM")
  return { before, after: size() }
}

/** Removes the database and its WAL/SHM files. Only ever called on explicit user request. */
export function purgeFiles(path: string): string[] {
  const removed: string[] = []
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(p)) {
      rmSync(p)
      removed.push(p)
    }
  }
  return removed
}
