import { randomBytes } from "node:crypto"
import type { Db, Row, SqlValue } from "./driver.ts"
import type { ModelUsageEvent, NormalizedEvent, Origin } from "../core/events.ts"

const b = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0)

/** Single write path for both the plugin and the importer. Callers wrap batches in db.transaction(). */
export class Repository {
  constructor(
    readonly db: Db,
    readonly pluginVersion: string,
  ) {}

  apply(event: NormalizedEvent, origin: Origin): void {
    switch (event.kind) {
      case "project":
        this.db
          .prepare(
            `INSERT INTO projects (id, worktree, vcs, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               worktree = COALESCE(excluded.worktree, worktree),
               vcs = COALESCE(excluded.vcs, vcs),
               first_seen = MIN(first_seen, excluded.first_seen),
               last_seen = MAX(last_seen, excluded.last_seen)`,
          )
          .run(event.id, event.worktree, event.vcs, event.ts, event.ts)
        return
      case "session":
        this.db
          .prepare(
            `INSERT INTO sessions (id, project_id, parent_id, directory, agent, host_version, plugin_version,
               config_fingerprint, created_at, updated_at, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               project_id = COALESCE(excluded.project_id, project_id),
               parent_id = COALESCE(excluded.parent_id, parent_id),
               directory = COALESCE(excluded.directory, directory),
               agent = COALESCE(excluded.agent, agent),
               host_version = COALESCE(excluded.host_version, host_version),
               plugin_version = COALESCE(plugin_version, excluded.plugin_version),
               config_fingerprint = COALESCE(config_fingerprint, excluded.config_fingerprint),
               created_at = COALESCE(created_at, excluded.created_at),
               updated_at = MAX(COALESCE(updated_at, 0), COALESCE(excluded.updated_at, 0))`,
          )
          .run(
            event.id,
            event.projectId,
            event.parentId,
            event.directory,
            event.agent,
            event.hostVersion,
            origin === "plugin" ? this.pluginVersion : null,
            event.configFingerprint,
            event.createdAt,
            event.updatedAt,
            origin,
          )
        return
      case "message":
        this.db
          .prepare(
            `INSERT INTO messages (id, session_id, role, parent_message_id, agent, provider, model,
               created_at, completed_at, finish, error, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               parent_message_id = COALESCE(excluded.parent_message_id, parent_message_id),
               agent = COALESCE(excluded.agent, agent),
               provider = COALESCE(excluded.provider, provider),
               model = COALESCE(excluded.model, model),
               created_at = COALESCE(created_at, excluded.created_at),
               completed_at = COALESCE(excluded.completed_at, completed_at),
               finish = COALESCE(excluded.finish, finish),
               error = COALESCE(excluded.error, error)`,
          )
          .run(
            event.id,
            event.sessionId,
            event.role,
            event.parentMessageId,
            event.agent,
            event.provider,
            event.model,
            event.createdAt,
            event.completedAt,
            event.finish,
            event.error,
            origin,
          )
        if (event.role === "assistant") {
          // Steps can arrive before their message when the plugin starts mid-session.
          this.db
            .prepare(
              `UPDATE llm_steps SET provider = COALESCE(provider, ?), model = COALESCE(model, ?), agent = COALESCE(agent, ?)
               WHERE message_id = ? AND (provider IS NULL OR model IS NULL OR agent IS NULL)`,
            )
            .run(event.provider, event.model, event.agent, event.id)
        }
        return
      case "synthetic_mark":
        this.db
          .prepare(
            `INSERT INTO messages (id, session_id, role, synthetic, origin) VALUES (?, ?, 'user', 1, ?)
             ON CONFLICT(id) DO UPDATE SET synthetic = 1`,
          )
          .run(event.messageId, event.sessionId, origin)
        return
      case "step":
        this.applyStep(event, origin)
        return
      case "tool":
        this.db
          .prepare(
            `INSERT INTO tool_runs (id, session_id, message_id, call_id, tool, status, started_at, ended_at,
               child_session_id, output_length, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               call_id = COALESCE(excluded.call_id, call_id),
               status = CASE WHEN status IN ('completed', 'error') AND excluded.status IN ('pending', 'running')
                             THEN status ELSE excluded.status END,
               started_at = COALESCE(started_at, excluded.started_at),
               ended_at = COALESCE(excluded.ended_at, ended_at),
               child_session_id = COALESCE(excluded.child_session_id, child_session_id),
               output_length = COALESCE(excluded.output_length, output_length)`,
          )
          .run(
            event.id,
            event.sessionId,
            event.messageId,
            event.callId,
            event.tool,
            event.status,
            event.startedAt,
            event.endedAt,
            event.childSessionId,
            event.outputLength,
            origin,
          )
        return
      case "command_start":
        this.db
          .prepare(
            `INSERT INTO command_runs (id, session_id, name, arguments_length, user_message_id, subtask, started_at, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               user_message_id = COALESCE(excluded.user_message_id, user_message_id),
               arguments_length = COALESCE(excluded.arguments_length, arguments_length),
               subtask = COALESCE(excluded.subtask, subtask)`,
          )
          .run(
            event.id,
            event.sessionId,
            event.name,
            event.argumentsLength,
            event.userMessageId,
            b(event.subtask),
            event.startedAt,
            origin,
          )
        return
      case "command_end":
        this.db
          .prepare(`UPDATE command_runs SET ended_at = ?, end_message_id = COALESCE(?, end_message_id) WHERE id = ?`)
          .run(event.endedAt, event.endMessageId, event.id)
        return
      case "request": {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO llm_requests (id, session_id, agent, provider, model, ts, pricing_known)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(event.id, event.sessionId, event.agent, event.provider, event.model, event.ts, b(event.pricingKnown))
        const insert = this.db.prepare(
          `INSERT OR REPLACE INTO context_sources (request_id, category, source, chars, est_tokens, method)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        for (const s of event.sources) insert.run(event.id, s.category, s.source, s.chars, s.estTokens, s.method)
        return
      }
      case "request_step":
        this.db.prepare(`UPDATE llm_requests SET step_id = ? WHERE id = ?`).run(event.stepId, event.requestId)
        return
      case "git":
        this.db
          .prepare(
            `INSERT OR REPLACE INTO git_snapshots (session_id, directory, available, commit_sha, branch, dirty, captured_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.sessionId,
            event.directory,
            event.available ? 1 : 0,
            event.commit,
            event.branch,
            b(event.dirty),
            event.capturedAt,
          )
        return
      case "fingerprint":
        this.db
          .prepare(
            `INSERT OR IGNORE INTO config_fingerprints (id, scope, file_count, partial, first_seen) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(event.id, JSON.stringify(event.scope), event.fileCount, event.partial ? 1 : 0, event.ts)
        return
      case "diagnostic":
        this.diagnostic(event.level, event.code, event.message, event.ts)
        return
    }
  }

  private applyStep(e: ModelUsageEvent, origin: Origin): void {
    const existing = this.db.prepare(`SELECT * FROM llm_steps WHERE id = ?`).get(e.id)
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO llm_steps (id, session_id, message_id, ts, provider, model, agent, input_tokens, output_tokens,
             reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, cost_currency, cost_source,
             finish_reason, seen_by_plugin, seen_by_import, plugin_version, host_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.id,
          e.sessionId,
          e.messageId,
          e.ts,
          e.provider,
          e.model,
          e.agent,
          e.inputTokens,
          e.outputTokens,
          e.reasoningTokens,
          e.cacheReadTokens,
          e.cacheWriteTokens,
          e.totalTokens,
          e.cost,
          e.costCurrency,
          e.costSource,
          e.finishReason,
          origin === "plugin" ? 1 : 0,
          origin === "import" ? 1 : 0,
          origin === "plugin" ? this.pluginVersion : null,
          e.hostVersion,
        )
      return
    }
    if (origin === "plugin") {
      // Duplicate delivery of the same step-finish part: idempotent, never accumulates.
      this.db
        .prepare(
          `UPDATE llm_steps SET seen_by_plugin = 1, plugin_version = COALESCE(plugin_version, ?),
             agent = COALESCE(agent, ?), host_version = COALESCE(host_version, ?) WHERE id = ?`,
        )
        .run(this.pluginVersion, e.agent, e.hostVersion, e.id)
      return
    }
    // Import over an existing row: OpenCode's own storage is the reconciliation baseline.
    const tokenCols: [string, number | null][] = [
      ["input_tokens", e.inputTokens],
      ["output_tokens", e.outputTokens],
      ["reasoning_tokens", e.reasoningTokens],
      ["cache_read_tokens", e.cacheReadTokens],
      ["cache_write_tokens", e.cacheWriteTokens],
    ]
    const tokenMismatch = tokenCols.some(([col, v]) => (existing[col] ?? null) !== v)
    const existingCost = existing.cost === null ? null : Number(existing.cost)
    const importCost = e.cost
    const costAgrees =
      existingCost === importCost ||
      (importCost === null && e.costSource === "unavailable" && (existingCost === 0 || existingCost === null)) ||
      (existingCost !== null && importCost !== null && Math.abs(existingCost - importCost) < 1e-12)
    const mismatch = tokenMismatch || !costAgrees
    const sets: string[] = ["seen_by_import = 1"]
    const params: SqlValue[] = []
    if (mismatch) {
      sets.push("import_mismatch = 1")
      for (const [col, v] of tokenCols) {
        sets.push(`${col} = ?`)
        params.push(v)
      }
      sets.push("total_tokens = ?", "cost = ?", "cost_currency = ?", "cost_source = ?")
      params.push(e.totalTokens, e.cost, e.costCurrency, e.costSource)
    }
    sets.push("host_version = COALESCE(host_version, ?)")
    params.push(e.hostVersion)
    this.db.prepare(`UPDATE llm_steps SET ${sets.join(", ")} WHERE id = ?`).run(...params, e.id)
  }

  diagnostic(level: string, code: string, message: string, ts = Date.now()): void {
    this.db
      .prepare(`INSERT INTO diagnostics (ts, level, code, message, plugin_version) VALUES (?, ?, ?, ?, ?)`)
      .run(ts, level, code, message.slice(0, 2000), this.pluginVersion)
  }

  /** Per-installation random key for HMAC content fingerprints. */
  hmacSalt(): string {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'hmac_salt'`).get()
    if (row) return String(row.value)
    const salt = randomBytes(32).toString("hex")
    this.db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('hmac_salt', ?)`).run(salt)
    return String(this.db.prepare(`SELECT value FROM meta WHERE key = 'hmac_salt'`).get()?.value ?? salt)
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value)
  }

  getMeta(key: string): string | null {
    const row: Row | undefined = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key)
    return row ? String(row.value) : null
  }
}
