import type { Db } from "./driver.ts"

/**
 * Authoritative schema history. Each entry upgrades user_version from index to index + 1.
 * Never edit a released migration; append a new one instead.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    worktree TEXT,
    vcs TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    parent_id TEXT,
    directory TEXT,
    agent TEXT,
    host_version TEXT,
    plugin_version TEXT,
    config_fingerprint TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    origin TEXT NOT NULL
  );
  CREATE INDEX sessions_parent ON sessions(parent_id);
  CREATE INDEX sessions_project ON sessions(project_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    parent_message_id TEXT,
    agent TEXT,
    provider TEXT,
    model TEXT,
    synthetic INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    completed_at INTEGER,
    finish TEXT,
    error TEXT,
    origin TEXT NOT NULL
  );
  CREATE INDEX messages_session ON messages(session_id, created_at);

  CREATE TABLE llm_steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    agent TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost REAL,
    cost_currency TEXT,
    cost_source TEXT NOT NULL,
    finish_reason TEXT,
    seen_by_plugin INTEGER NOT NULL DEFAULT 0,
    seen_by_import INTEGER NOT NULL DEFAULT 0,
    import_mismatch INTEGER NOT NULL DEFAULT 0,
    plugin_version TEXT,
    host_version TEXT
  );
  CREATE INDEX llm_steps_ts ON llm_steps(ts);
  CREATE INDEX llm_steps_session ON llm_steps(session_id);
  CREATE INDEX llm_steps_message ON llm_steps(message_id);

  CREATE TABLE command_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    arguments_length INTEGER,
    user_message_id TEXT,
    subtask INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_message_id TEXT,
    origin TEXT NOT NULL
  );
  CREATE INDEX command_runs_session ON command_runs(session_id);
  CREATE INDEX command_runs_user_message ON command_runs(user_message_id);

  CREATE TABLE tool_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    call_id TEXT,
    tool TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    child_session_id TEXT,
    output_length INTEGER,
    origin TEXT NOT NULL
  );
  CREATE INDEX tool_runs_session ON tool_runs(session_id);
  CREATE INDEX tool_runs_child ON tool_runs(child_session_id);

  CREATE TABLE llm_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent TEXT,
    provider TEXT,
    model TEXT,
    ts INTEGER NOT NULL,
    step_id TEXT,
    pricing_known INTEGER
  );
  CREATE INDEX llm_requests_session ON llm_requests(session_id, ts);
  CREATE INDEX llm_requests_step ON llm_requests(step_id);

  CREATE TABLE context_sources (
    request_id TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    chars INTEGER NOT NULL,
    est_tokens INTEGER NOT NULL,
    method TEXT NOT NULL,
    PRIMARY KEY (request_id, category, source)
  );

  CREATE TABLE git_snapshots (
    session_id TEXT PRIMARY KEY,
    directory TEXT,
    available INTEGER NOT NULL,
    commit_sha TEXT,
    branch TEXT,
    dirty INTEGER,
    captured_at INTEGER NOT NULL
  );

  CREATE TABLE config_fingerprints (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    partial INTEGER NOT NULL,
    first_seen INTEGER NOT NULL
  );

  CREATE TABLE diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    plugin_version TEXT
  );
  CREATE INDEX diagnostics_ts ON diagnostics(ts);
  `,
]

export const SUPPORTED_SCHEMA_VERSION = MIGRATIONS.length

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `Database schema version ${found} is newer than this build supports (${supported}). ` +
        "Upgrade opencode-token-monitor; writes are disabled to protect the data.",
    )
    this.name = "SchemaTooNewError"
  }
}

export function readSchemaVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get()
  return Number(row?.user_version ?? 0)
}

/**
 * Applies pending migrations. BEGIN IMMEDIATE takes the write lock before user_version is read,
 * so concurrent OpenCode instances starting at the same time apply each migration exactly once.
 */
export function migrate(db: Db): { from: number; to: number } {
  const quick = readSchemaVersion(db)
  if (quick > SUPPORTED_SCHEMA_VERSION) throw new SchemaTooNewError(quick, SUPPORTED_SCHEMA_VERSION)
  if (quick === SUPPORTED_SCHEMA_VERSION) return { from: quick, to: quick }
  return db.transaction(() => {
    const from = readSchemaVersion(db)
    if (from > SUPPORTED_SCHEMA_VERSION) throw new SchemaTooNewError(from, SUPPORTED_SCHEMA_VERSION)
    for (let v = from; v < SUPPORTED_SCHEMA_VERSION; v++) {
      db.exec(MIGRATIONS[v]!)
    }
    db.exec(`PRAGMA user_version = ${SUPPORTED_SCHEMA_VERSION}`)
    return { from, to: SUPPORTED_SCHEMA_VERSION }
  })
}

/** For read-only consumers: refuse to interpret a schema this build does not know. */
export function assertReadableSchema(db: Db): number {
  const version = readSchemaVersion(db)
  if (version > SUPPORTED_SCHEMA_VERSION) throw new SchemaTooNewError(version, SUPPORTED_SCHEMA_VERSION)
  return version
}
