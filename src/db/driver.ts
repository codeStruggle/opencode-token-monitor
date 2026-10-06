import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type SqlValue = string | number | null
export type Row = Record<string, unknown>

export interface Statement {
  run(...params: SqlValue[]): { changes: number }
  get(...params: SqlValue[]): Row | undefined
  all(...params: SqlValue[]): Row[]
}

/** Thin interface over bun:sqlite and node:sqlite. Repository and analytics depend only on this. */
export interface Db {
  readonly path: string
  readonly driver: "bun:sqlite" | "node:sqlite"
  exec(sql: string): void
  prepare(sql: string): Statement
  /** Runs fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on error. Not re-entrant. */
  transaction<T>(fn: () => T): T
  close(): void
}

export type OpenOptions = {
  /** Open the file read-only at the driver level (used for OpenCode's own database). */
  readonly?: boolean
  /** Open with PRAGMA query_only so the connection can never write. */
  queryOnly?: boolean
  /** Create the parent directory and file when missing. */
  create?: boolean
  busyTimeoutMs?: number
}

export class DatabaseMissingError extends Error {
  constructor(readonly path: string) {
    super(`Database does not exist: ${path}`)
    this.name = "DatabaseMissingError"
  }
}

type RawStatement = {
  run(...params: SqlValue[]): { changes: number | bigint }
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

type RawDb = {
  exec(sql: string): void
  prepare(sql: string): RawStatement
  close(): void
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

async function openRaw(path: string, readonly: boolean): Promise<{ raw: RawDb; driver: Db["driver"] }> {
  if (isBun) {
    const specifier = "bun:sqlite"
    const mod = (await import(specifier)) as { Database: new (path: string, opts?: object) => RawDb & { run(sql: string): void } }
    const db = new mod.Database(path, readonly ? { readonly: true } : { create: true })
    return {
      driver: "bun:sqlite",
      raw: {
        exec: (sql) => db.run(sql),
        prepare: (sql) => {
          const stmt = (db as unknown as { query(sql: string): RawStatement & { get(...p: SqlValue[]): unknown } }).query(sql)
          return {
            run: (...p) => (stmt as unknown as { run(...p: SqlValue[]): { changes: number } }).run(...p),
            get: (...p) => stmt.get(...p) ?? undefined,
            all: (...p) => stmt.all(...p),
          }
        },
        close: () => db.close(),
      },
    }
  }
  const specifier = "node:sqlite"
  const mod = (await withoutSqliteWarning(() => import(specifier))) as {
    DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => RawDb
  }
  const db = new mod.DatabaseSync(path, readonly ? { readOnly: true } : {})
  return { driver: "node:sqlite", raw: db }
}

/** node:sqlite prints an ExperimentalWarning on Node 22; it is noise for CLI users. */
async function withoutSqliteWarning<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message
    if (/SQLite/i.test(text)) return
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return await fn()
  } finally {
    process.emitWarning = original
  }
}

export async function openDatabase(path: string, options: OpenOptions = {}): Promise<Db> {
  if (path !== ":memory:") {
    if (!existsSync(path)) {
      if (!options.create) throw new DatabaseMissingError(path)
      mkdirSync(dirname(path), { recursive: true })
    }
  }
  const { raw, driver } = await openRaw(path, options.readonly ?? false)
  raw.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
  if (path !== ":memory:" && !options.queryOnly && !options.readonly) raw.exec("PRAGMA journal_mode = WAL")
  raw.exec("PRAGMA foreign_keys = OFF")
  if (options.queryOnly || options.readonly) raw.exec("PRAGMA query_only = ON")

  let inTransaction = false
  return {
    path,
    driver,
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        run: (...p) => ({ changes: Number(stmt.run(...p).changes) }),
        get: (...p) => (stmt.get(...p) as Row | undefined) ?? undefined,
        all: (...p) => stmt.all(...p) as Row[],
      }
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error("Nested transactions are not supported")
      inTransaction = true
      raw.exec("BEGIN IMMEDIATE")
      try {
        const result = fn()
        raw.exec("COMMIT")
        return result
      } catch (error) {
        try {
          raw.exec("ROLLBACK")
        } catch {
          // The original error is more useful than a failed rollback.
        }
        throw error
      } finally {
        inTransaction = false
      }
    },
    close: () => raw.close(),
  }
}
