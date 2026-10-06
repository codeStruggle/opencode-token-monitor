import { expect, test } from "bun:test"
import { join } from "node:path"
import { openDatabase } from "../../src/db/driver.ts"
import { readSchemaVersion, SUPPORTED_SCHEMA_VERSION } from "../../src/db/migrations.ts"
import { tempDir } from "../helpers.ts"

test("several processes migrate and write one database while a reader queries", async () => {
  const path = join(tempDir(), "shared.sqlite")
  const workers = 4
  const perWorker = 200
  const procs = Array.from({ length: workers }, (_, w) =>
    Bun.spawn([process.execPath, join(import.meta.dir, "concurrency-worker.ts"), path, String(w), String(perWorker)], { stdout: "pipe", stderr: "pipe" }),
  )
  // Concurrent reader: must never see an error while writers are active.
  const readerErrors: string[] = []
  let reads = 0
  const deadline = Date.now() + 20_000
  while (procs.some((p) => p.exitCode === null) && Date.now() < deadline) {
    try {
      const db = await openDatabase(path, { queryOnly: true })
      if (readSchemaVersion(db) === SUPPORTED_SCHEMA_VERSION) db.prepare(`SELECT COUNT(*) AS n FROM llm_steps`).get()
      db.close()
      reads++
    } catch (e) {
      if (!String(e).includes("does not exist")) readerErrors.push(String(e))
    }
    await Bun.sleep(5)
  }
  const outputs = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })))
  for (const o of outputs) {
    expect(o.err).toBe("")
    expect(o.code).toBe(0)
    expect(JSON.parse(o.out).failures).toEqual([])
  }
  expect(readerErrors).toEqual([])
  expect(reads).toBeGreaterThan(0)
  const db = await openDatabase(path, { queryOnly: true })
  expect(readSchemaVersion(db)).toBe(SUPPORTED_SCHEMA_VERSION)
  expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM llm_steps`).get()!.n)).toBe(workers * perWorker + 1)
  expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM llm_steps WHERE id = 'shared'`).get()!.n)).toBe(1)
  db.close()
}, 30_000)

test("processes opening a fresh database at the same moment all succeed (WAL switch under contention)", async () => {
  const failures: string[] = []
  // The race needs a few rounds to show up reliably (about 1 in 20 openers hit it before the fix).
  for (let round = 0; round < 20; round++) {
    const path = join(tempDir(), "fresh.sqlite")
    const procs = Array.from({ length: 8 }, (_, w) =>
      Bun.spawn([process.execPath, join(import.meta.dir, "concurrency-worker.ts"), path, String(w), "5"], { stdout: "pipe", stderr: "pipe" }),
    )
    for (const p of procs) {
      const code = await p.exited
      const err = await new Response(p.stderr).text()
      if (code !== 0 || err) failures.push(err.split("\n").find((l) => l.includes("Error")) ?? `exit ${code}`)
    }
    const db = await openDatabase(path, { queryOnly: true })
    expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM llm_steps`).get()!.n)).toBe(8 * 5 + 1)
    expect(String(db.prepare(`PRAGMA journal_mode`).get()!.journal_mode)).toBe("wal")
    db.close()
  }
  expect(failures).toEqual([])
}, 60_000)
