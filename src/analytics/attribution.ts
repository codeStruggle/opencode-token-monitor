import type { Db } from "../db/driver.ts"
import type { SessionRow, StepRow } from "./data.ts"

/**
 * How a step's usage relates to a command:
 * - direct: the step belongs to the turn started by the command's user message
 * - descendant: the step runs in a child session spawned (via an explicit task-tool link) from such a turn
 * - none: the step belongs to a plain prompt turn (or a child of one)
 * - unlinked: the step runs in a child session whose spawning tool call was not observed
 */
export type CommandLink =
  | { via: "direct" | "descendant"; commandRunId: string; commandName: string }
  | { via: "none" | "unlinked"; commandRunId: null; commandName: null }

type MessageRow = { id: string; role: string; parent: string | null; synthetic: boolean; createdAt: number }

export class Attribution {
  private readonly messagesBySession = new Map<string, MessageRow[]>()
  private readonly messageIndex = new Map<string, MessageRow & { sessionId: string }>()
  private readonly commandByUserMessage = new Map<string, { id: string; name: string }>()
  private readonly spawnLink = new Map<string, { sessionId: string; messageId: string; toolRunId: string }>()
  private readonly sessionLinkCache = new Map<string, CommandLink>()

  constructor(
    private readonly db: Db,
    private readonly sessions: Map<string, SessionRow>,
  ) {
    const msgStmt = db.prepare(
      `SELECT id, role, parent_message_id, synthetic, created_at FROM messages WHERE session_id = ? ORDER BY created_at, id`,
    )
    const cmdStmt = db.prepare(`SELECT id, name, user_message_id FROM command_runs WHERE session_id = ? AND user_message_id IS NOT NULL`)
    const linkStmt = db.prepare(`SELECT id, session_id, message_id FROM tool_runs WHERE child_session_id = ? ORDER BY started_at LIMIT 1`)
    for (const id of sessions.keys()) {
      const rows = msgStmt.all(id).map((r) => ({
        id: String(r.id),
        role: String(r.role),
        parent: r.parent_message_id === null ? null : String(r.parent_message_id),
        synthetic: Number(r.synthetic) === 1,
        createdAt: Number(r.created_at ?? 0),
      }))
      this.messagesBySession.set(id, rows)
      for (const m of rows) this.messageIndex.set(m.id, { ...m, sessionId: id })
      for (const c of cmdStmt.all(id)) this.commandByUserMessage.set(String(c.user_message_id), { id: String(c.id), name: String(c.name) })
      const link = linkStmt.get(id)
      if (link) this.spawnLink.set(id, { sessionId: String(link.session_id), messageId: String(link.message_id), toolRunId: String(link.id) })
    }
  }

  spawnedBy(sessionId: string): { sessionId: string; messageId: string; toolRunId: string } | null {
    return this.spawnLink.get(sessionId) ?? null
  }

  /** The non-synthetic user message that started the turn containing messageId. */
  turnRoot(sessionId: string, messageId: string): string | null {
    const msg = this.messageIndex.get(messageId)
    const anchor = msg?.role === "user" ? msg : msg?.parent ? this.messageIndex.get(msg.parent) : undefined
    if (anchor?.role === "user" && !anchor.synthetic) return anchor.id
    const ref = anchor ?? msg
    if (!ref) return null
    // Synthetic user messages (e.g. "summarize the task output") continue the preceding turn.
    let best: MessageRow | null = null
    for (const r of this.messagesBySession.get(sessionId) ?? []) {
      if (r.role !== "user" || r.synthetic) continue
      if (r.createdAt < ref.createdAt || (r.createdAt === ref.createdAt && r.id < ref.id)) best = r
    }
    return best?.id ?? null
  }

  commandForTurn(userMessageId: string | null): { id: string; name: string } | null {
    return userMessageId ? (this.commandByUserMessage.get(userMessageId) ?? null) : null
  }

  /** Command context inherited by everything that runs in sessionId (from the turn that spawned it). */
  private inherited(sessionId: string, depth = 0): CommandLink {
    const cached = this.sessionLinkCache.get(sessionId)
    if (cached) return cached
    const session = this.sessions.get(sessionId)
    let result: CommandLink = { via: "none", commandRunId: null, commandName: null }
    if (session?.parentId && depth < 64) {
      const link = this.spawnLink.get(sessionId)
      if (!link) result = { via: "unlinked", commandRunId: null, commandName: null }
      else {
        const cmd = this.commandForTurn(this.turnRoot(link.sessionId, link.messageId))
        if (cmd) result = { via: "descendant", commandRunId: cmd.id, commandName: cmd.name }
        else {
          const up = this.inherited(link.sessionId, depth + 1)
          result = up.via === "direct" ? { ...up, via: "descendant" } : up
        }
      }
    }
    this.sessionLinkCache.set(sessionId, result)
    return result
  }

  commandOf(step: Pick<StepRow, "sessionId" | "messageId">): CommandLink {
    const cmd = this.commandForTurn(this.turnRoot(step.sessionId, step.messageId))
    if (cmd) return { via: "direct", commandRunId: cmd.id, commandName: cmd.name }
    return this.inherited(step.sessionId)
  }
}
