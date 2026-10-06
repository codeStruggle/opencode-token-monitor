import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { enableWal, openDatabase } from "../../src/db/driver.ts"
import { prune, purgeFiles, vacuum } from "../../src/db/maintenance.ts"
import { migrate, readSchemaVersion, SchemaTooNewError, SUPPORTED_SCHEMA_VERSION } from "../../src/db/migrations.ts"
import { WriteQueue } from "../../src/plugin/queue.ts"
import { existsSync } from "node:fs"
import { fileRepo, memRepo, q, step, tempDir } from "../helpers.ts"

describe("migrations", () => {
  test("fresh database migrates to the supported version", async () => {
    const repo = await memRepo()
    expect(readSchemaVersion(repo.db)).toBe(SUPPORTED_SCHEMA_VERSION)
    expect(migrate(repo.db)).toEqual({ from: SUPPORTED_SCHEMA_VERSION, to: SUPPORTED_SCHEMA_VERSION })
  })

  test("a newer schema is refused and left untouched", async () => {
    const db = await openDatabase(":memory:", { create: true })
    db.exec("PRAGMA user_version = 99")
    expect(() => migrate(db)).toThrow(SchemaTooNewError)
    expect(readSchemaVersion(db)).toBe(99)
  })

  test("a failing migration leaves no partial schema", async () => {
    const db = await openDatabase(":memory:", { create: true })
    db.exec("CREATE TABLE projects (x)") // conflicts with migration 1
    expect(() => migrate(db)).toThrow()
    expect(readSchemaVersion(db)).toBe(0)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'sessions'`).get()).toBeUndefined()
  })

  test("query_only connections cannot write", async () => {
    const dir = tempDir()
    const path = join(dir, "t.sqlite")
    ;(await fileRepo(path)).db.close()
    const ro = await openDatabase(path, { queryOnly: true })
    expect(() => ro.exec("CREATE TABLE x (y)")).toThrow()
    ro.close()
  })

  test("opening a missing database without create fails clearly", async () => {
    await expect(openDatabase(join(tempDir(), "missing.sqlite"))).rejects.toThrow("does not exist")
  })
})

describe("repository", () => {
  test("duplicate step deliveries never accumulate", async () => {
    const repo = await memRepo()
    for (let i = 0; i < 3; i++) repo.apply(step(), "plugin")
    const rows = q(repo.db, `SELECT * FROM llm_steps`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.input_tokens).toBe(100)
  })

  test("import of an identical step marks it seen without mismatch", async () => {
    const repo = await memRepo()
    repo.apply(step(), "plugin")
    repo.apply(step({ ts: 5555 }), "import")
    const r = q(repo.db, `SELECT * FROM llm_steps`)[0]!
    expect([r.seen_by_plugin, r.seen_by_import, r.import_mismatch, r.ts]).toEqual([1, 1, 0, 1000])
  })

  test("import that disagrees corrects the counters and flags the mismatch", async () => {
    const repo = await memRepo()
    repo.apply(step(), "plugin")
    repo.apply(step({ inputTokens: 120, totalTokens: 180 }), "import")
    const r = q(repo.db, `SELECT * FROM llm_steps`)[0]!
    expect([r.input_tokens, r.total_tokens, r.import_mismatch]).toEqual([120, 180, 1])
  })

  test("unknown-price import over a priced zero is not a mismatch", async () => {
    const repo = await memRepo()
    repo.apply(step({ cost: 0, costSource: "host_computed" }), "plugin")
    repo.apply(step({ cost: null, costCurrency: null, costSource: "unavailable" }), "import")
    expect(q(repo.db, `SELECT import_mismatch FROM llm_steps`)[0]!.import_mismatch).toBe(0)
  })

  test("message updates fill fields and late message info backfills step metadata", async () => {
    const repo = await memRepo()
    repo.apply(step({ provider: null, model: null, agent: null }), "plugin")
    const base = { kind: "message" as const, id: "msg_1", sessionId: "ses_1", role: "assistant" as const, parentMessageId: "u1", createdAt: 1, completedAt: null, finish: null, error: null }
    repo.apply({ ...base, agent: "build", provider: "p", model: "m" }, "plugin")
    repo.apply({ ...base, agent: null, provider: null, model: null, completedAt: 9, finish: "stop" }, "plugin")
    const m = q(repo.db, `SELECT * FROM messages`)[0]!
    expect([m.agent, m.completed_at, m.finish]).toEqual(["build", 9, "stop"])
    const s = q(repo.db, `SELECT provider, model, agent FROM llm_steps`)[0]!
    expect(s).toEqual({ provider: "p", model: "m", agent: "build" })
  })

  test("tool status never regresses from a terminal state", async () => {
    const repo = await memRepo()
    const t = { kind: "tool" as const, id: "t1", sessionId: "s", messageId: "m", callId: "c", tool: "read", startedAt: 1, endedAt: null, childSessionId: null, outputLength: null }
    repo.apply({ ...t, status: "completed", endedAt: 5 }, "plugin")
    repo.apply({ ...t, status: "running" }, "import")
    expect(q(repo.db, `SELECT status, ended_at FROM tool_runs`)[0]).toEqual({ status: "completed", ended_at: 5 })
  })

  test("hmac salt is stable per database", async () => {
    const repo = await memRepo()
    expect(repo.hmacSalt()).toBe(repo.hmacSalt())
    expect(repo.hmacSalt()).toHaveLength(64)
  })
})

describe("write queue", () => {
  test("batches are written in one transaction", async () => {
    const repo = await memRepo()
    const queue = new WriteQueue(repo)
    queue.push([step({ id: "a" }), step({ id: "b" })])
    expect(queue.pending).toBe(2)
    queue.flush()
    expect(queue.pending).toBe(0)
    expect(queue.stats).toMatchObject({ written: 2, batches: 1 })
  })

  test("a failing batch is retried once, then dropped with an error report", async () => {
    const repo = await memRepo()
    const errors: number[] = []
    const queue = new WriteQueue(repo, { onError: (_e, dropped) => errors.push(dropped) })
    repo.db.exec("DROP TABLE llm_steps")
    queue.push([step()])
    queue.flush()
    expect(queue.pending).toBe(1)
    queue.flush()
    expect(queue.pending).toBe(0)
    expect(queue.stats.dropped).toBe(1)
    expect(errors).toContain(1)
  })

  test("buffer is bounded", async () => {
    const queue = new WriteQueue(await memRepo(), { maxBuffered: 2 })
    queue.push([step({ id: "1" }), step({ id: "2" }), step({ id: "3" })])
    expect(queue.pending).toBe(2)
    expect(queue.stats.dropped).toBe(1)
  })
})

describe("maintenance", () => {
  test("prune removes only older rows and keeps sessions that still have steps", async () => {
    const repo = await memRepo()
    repo.apply({ kind: "session", id: "ses_1", projectId: null, parentId: null, directory: null, agent: null, hostVersion: null, configFingerprint: null, createdAt: 1, updatedAt: 3000 }, "plugin")
    repo.apply(step({ id: "old", ts: 1000 }), "plugin")
    repo.apply(step({ id: "new", ts: 3000 }), "plugin")
    const r = prune(repo.db, 2000)
    expect(r.llm_steps).toBe(1)
    expect(r.sessions).toBe(0)
    expect(q(repo.db, `SELECT id FROM llm_steps`).map((x) => x.id)).toEqual(["new"])
  })

  test("vacuum and purge", async () => {
    const dir = tempDir()
    const path = join(dir, "db.sqlite")
    const repo = await fileRepo(path)
    repo.apply(step(), "plugin")
    const v = vacuum(repo.db)
    expect(v.after).toBeGreaterThan(0)
    repo.db.close()
    const removed = purgeFiles(path)
    expect(removed).toContain(path)
    expect(existsSync(path)).toBe(false)
  })
})


describe("WAL switch under contention", () => {
  type Raw = Parameters<typeof enableWal>[0]
  const fakeRaw = (busyTimes: number, error = "SQLiteError: database is locked") => {
    let attempts = 0
    let mode = "delete"
    const raw = {
      exec(sql: string) {
        if (sql.includes("journal_mode = WAL")) {
          if (attempts++ < busyTimes) throw Object.assign(new Error(error), { code: error.includes("locked") ? "SQLITE_BUSY" : "SQLITE_IOERR" })
          mode = "wal"
        }
      },
      prepare: () => ({ get: () => ({ journal_mode: mode }), run: () => ({ changes: 0 }), all: () => [] }),
    } as unknown as Raw
    return { raw, attempts: () => attempts, mode: () => mode }
  }

  test("retries SQLITE_BUSY until the switch succeeds", async () => {
    const f = fakeRaw(3)
    await enableWal(f.raw, 2000)
    expect(f.attempts()).toBe(4)
    expect(f.mode()).toBe("wal")
  })

  test("an already-WAL database is not switched again", async () => {
    const f = fakeRaw(0)
    await enableWal(f.raw, 2000)
    await enableWal(f.raw, 2000)
    expect(f.attempts()).toBe(1)
  })

  test("gives up after the timeout and rethrows", async () => {
    const f = fakeRaw(Number.POSITIVE_INFINITY)
    await expect(enableWal(f.raw, 50)).rejects.toThrow("database is locked")
  })

  test("other errors are not retried", async () => {
    const f = fakeRaw(5, "SQLiteError: disk I/O error")
    await expect(enableWal(f.raw, 2000)).rejects.toThrow("disk I/O error")
    expect(f.attempts()).toBe(1)
  })
})
