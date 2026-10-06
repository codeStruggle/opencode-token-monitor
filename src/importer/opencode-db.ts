/**
 * Backfill and reconciliation from OpenCode's own SQLite store (OpenCode >= 1.x, `opencode db path`).
 * Reads only the project, session, message and part tables, never account or credential tables.
 */
import {
  isSyntheticTextPart,
  mapMessage,
  mapProject,
  mapSession,
  mapStepFinish,
  mapSubtaskCommand,
  mapToolPart,
  type MessageInfo,
} from "../collector/opencode-adapter.ts"
import type { NormalizedEvent } from "../core/events.ts"
import { openDatabase, type Db } from "../db/driver.ts"
import type { Repository } from "../db/repository.ts"

export type ImportOptions = {
  hostDbPath: string
  /** Only import sessions updated at or after this epoch-ms. */
  since?: number
  batchSize?: number
}

export type ImportResult = {
  hostDbPath: string
  sessions: number
  messages: number
  steps: { inserted: number; alreadyPresent: number; mismatched: number }
  tools: number
  commands: number
}

const parseJson = (text: unknown): Record<string, unknown> => {
  if (typeof text !== "string") return {}
  try {
    const v = JSON.parse(text)
    return typeof v === "object" && v !== null ? v : {}
  } catch {
    return {}
  }
}

const REQUIRED_TABLES = ["session", "message", "part", "project"]

export async function openHostDb(path: string): Promise<Db> {
  const db = await openDatabase(path, { readonly: true })
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => String(r.name)))
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
  if (missing.length) {
    db.close()
    throw new Error(`Unsupported OpenCode storage at ${path}: missing tables ${missing.join(", ")}`)
  }
  return db
}

export async function importFromOpencode(repo: Repository, opts: ImportOptions): Promise<ImportResult> {
  const host = await openHostDb(opts.hostDbPath)
  const result: ImportResult = {
    hostDbPath: opts.hostDbPath,
    sessions: 0,
    messages: 0,
    steps: { inserted: 0, alreadyPresent: 0, mismatched: 0 },
    tools: 0,
    commands: 0,
  }
  try {
    const projects = host.prepare(`SELECT id, worktree, vcs, time_created FROM project`).all()
    const projectEvents = projects
      .map((p) => mapProject(String(p.id), (p.worktree as string) ?? null, (p.vcs as string) ?? null, Number(p.time_created)))
      .filter((e): e is NonNullable<typeof e> => e !== null)
    repo.db.transaction(() => projectEvents.forEach((e) => repo.apply(e, "import")))

    const sessions = host
      .prepare(
        `SELECT id, project_id, parent_id, directory, version, agent, time_created, time_updated
         FROM session WHERE time_updated >= ? ORDER BY time_created`,
      )
      .all(opts.since ?? 0)

    const stepExists = repo.db.prepare(`SELECT import_mismatch FROM llm_steps WHERE id = ?`)
    const messagesOf = host.prepare(`SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id`)
    const partsOf = host.prepare(
      `SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id`,
    )

    for (const s of sessions) {
      const sessionId = String(s.id)
      const hostVersion = (s.version as string) ?? null
      const events: NormalizedEvent[] = []
      const sessionEvent = mapSession({
        id: sessionId,
        projectID: s.project_id,
        parentID: s.parent_id ?? undefined,
        directory: s.directory,
        version: s.version,
        agent: s.agent,
        time: { created: s.time_created, updated: s.time_updated },
      })
      if (sessionEvent) events.push(sessionEvent)

      const infos = new Map<string, MessageInfo>()
      for (const m of messagesOf.all(sessionId)) {
        const data = parseJson(m.data)
        const mapped = mapMessage({ ...data, id: m.id, sessionID: sessionId })
        if (!mapped) continue
        infos.set(mapped.info.id, mapped.info)
        events.push(mapped.event)
        result.messages++
      }

      const preExisting = new Map<string, boolean>()
      for (const p of partsOf.all(sessionId)) {
        const part = { ...parseJson(p.data), id: p.id, messageID: p.message_id, sessionID: sessionId }
        const ts = Number(p.time_created)
        const step = mapStepFinish(part, infos.get(String(p.message_id)), ts, hostVersion, null)
        if (step) {
          preExisting.set(step.id, stepExists.get(step.id) !== undefined)
          events.push(step)
          continue
        }
        const tool = mapToolPart(part)
        if (tool) {
          events.push(tool)
          result.tools++
          continue
        }
        const command = mapSubtaskCommand(part, ts)
        if (command) {
          events.push(command)
          result.commands++
          continue
        }
        if (isSyntheticTextPart(part) && infos.get(String(p.message_id))?.role === "user") {
          events.push({ kind: "synthetic_mark", messageId: String(p.message_id), sessionId })
        }
      }

      repo.db.transaction(() => {
        for (const e of events) repo.apply(e, "import")
      })
      for (const [id, existed] of preExisting) {
        if (!existed) result.steps.inserted++
        else {
          result.steps.alreadyPresent++
          if (Number(stepExists.get(id)?.import_mismatch ?? 0) === 1) result.steps.mismatched++
        }
      }
      result.sessions++
    }
    repo.db.transaction(() => repo.setMeta("last_import", JSON.stringify({ at: Date.now(), hostDbPath: opts.hostDbPath })))
    return result
  } finally {
    host.close()
  }
}
