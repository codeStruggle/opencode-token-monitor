import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { openDatabase } from "../db/driver.ts"
import { readSchemaVersion, SUPPORTED_SCHEMA_VERSION } from "../db/migrations.ts"
import { resolveOpencodeConfigDir, resolveOpencodeDbPath, type DbPathResolution } from "../runtime/paths.ts"
import { PLUGIN_VERSION } from "../version.ts"
import { findNpmDeclaration, PLUGIN_FILE_NAME } from "./install.ts"

export type DoctorReport = {
  schemaVersion: string
  kind: "doctor"
  cliVersion: string
  runtime: { name: "bun" | "node"; version: string; sqliteDriver: string | null }
  database: {
    path: string
    reason: DbPathResolution["reason"] | "flag"
    exists: boolean
    sizeBytes: number | null
    walBytes: number | null
    schemaVersion: number | null
    supportedSchemaVersion: number
    status: "missing" | "ok" | "needs-upgrade-of-this-cli" | "will-migrate-on-next-plugin-start" | "error"
    error: string | null
    counts: Record<string, number> | null
    lastStepAt: string | null
    lastImport: unknown
  }
  plugin: {
    localBundle: { path: string; exists: boolean }
    npmDeclaration: string | null
    recentLoads: { at: string; info: unknown }[]
    duplicateLoadsObserved: number
  }
  opencode: { dbPath: string; exists: boolean }
  fingerprints: { id: string; scope: string[]; fileCount: number; partial: boolean }[]
  recentProblems: { at: string; level: string; code: string; message: string }[]
}

export async function doctor(db: { path: string; reason: DoctorReport["database"]["reason"] }): Promise<DoctorReport> {
  const isBun = typeof (globalThis as { Bun?: { version: string } }).Bun !== "undefined"
  const configDir = resolveOpencodeConfigDir()
  const bundlePath = join(configDir, "plugins", PLUGIN_FILE_NAME)
  const hostDb = resolveOpencodeDbPath()
  const exists = existsSync(db.path)
  const report: DoctorReport = {
    schemaVersion: "1.0.0",
    kind: "doctor",
    cliVersion: PLUGIN_VERSION,
    runtime: {
      name: isBun ? "bun" : "node",
      version: isBun ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : process.version,
      sqliteDriver: null,
    },
    database: {
      path: db.path,
      reason: db.reason,
      exists,
      sizeBytes: exists ? statSync(db.path).size : null,
      walBytes: existsSync(`${db.path}-wal`) ? statSync(`${db.path}-wal`).size : null,
      schemaVersion: null,
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      status: exists ? "ok" : "missing",
      error: null,
      counts: null,
      lastStepAt: null,
      lastImport: null,
    },
    plugin: {
      localBundle: { path: bundlePath, exists: existsSync(bundlePath) },
      npmDeclaration: findNpmDeclaration(configDir),
      recentLoads: [],
      duplicateLoadsObserved: 0,
    },
    opencode: { dbPath: hostDb, exists: existsSync(hostDb) },
    fingerprints: [],
    recentProblems: [],
  }
  if (!exists) return report
  try {
    const conn = await openDatabase(db.path, { queryOnly: true })
    report.runtime.sqliteDriver = conn.driver
    try {
      const version = readSchemaVersion(conn)
      report.database.schemaVersion = version
      if (version > SUPPORTED_SCHEMA_VERSION) {
        report.database.status = "needs-upgrade-of-this-cli"
        return report
      }
      if (version < SUPPORTED_SCHEMA_VERSION) {
        report.database.status = "will-migrate-on-next-plugin-start"
        return report
      }
      const counts: Record<string, number> = {}
      for (const t of ["projects", "sessions", "messages", "llm_steps", "command_runs", "tool_runs", "llm_requests", "git_snapshots", "diagnostics"]) {
        counts[t] = Number(conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0)
      }
      report.database.counts = counts
      const last = conn.prepare(`SELECT MAX(ts) AS ts FROM llm_steps`).get()?.ts
      report.database.lastStepAt = last === null || last === undefined ? null : new Date(Number(last)).toISOString()
      const imp = conn.prepare(`SELECT value FROM meta WHERE key = 'last_import'`).get()?.value
      report.database.lastImport = imp ? JSON.parse(String(imp)) : null
      report.plugin.recentLoads = conn
        .prepare(`SELECT ts, message FROM diagnostics WHERE code = 'plugin.loaded' ORDER BY ts DESC LIMIT 5`)
        .all()
        .map((r) => {
          let info: unknown = r.message
          try {
            info = JSON.parse(String(r.message))
          } catch {
            // keep raw
          }
          return { at: new Date(Number(r.ts)).toISOString(), info }
        })
      report.plugin.duplicateLoadsObserved = Number(
        conn.prepare(`SELECT COUNT(*) AS n FROM diagnostics WHERE code = 'plugin.duplicate'`).get()?.n ?? 0,
      )
      report.fingerprints = conn
        .prepare(`SELECT id, scope, file_count, partial FROM config_fingerprints ORDER BY first_seen DESC LIMIT 5`)
        .all()
        .map((r) => ({ id: String(r.id), scope: JSON.parse(String(r.scope)), fileCount: Number(r.file_count), partial: Number(r.partial) === 1 }))
      report.recentProblems = conn
        .prepare(`SELECT ts, level, code, message FROM diagnostics WHERE level IN ('warn', 'error') ORDER BY ts DESC LIMIT 10`)
        .all()
        .map((r) => ({ at: new Date(Number(r.ts)).toISOString(), level: String(r.level), code: String(r.code), message: String(r.message) }))
    } finally {
      conn.close()
    }
  } catch (error) {
    report.database.status = "error"
    report.database.error = String(error)
  }
  return report
}
