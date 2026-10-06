import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { queryCommands } from "../../src/analytics/commands.ts"
import { queryUsage } from "../../src/analytics/usage.ts"
import { importFromOpencode, openHostDb } from "../../src/importer/opencode-db.ts"
import { naturalRange } from "../../src/time/range.ts"
import { applyAll, buildHostDb, memRepo, q, readHooks, replay, tempDir } from "../helpers.ts"

const ALL = naturalRange("all", Date.now(), "UTC")
const RUNS = ["plain", "spawn", "command-subtask", "command-inline"]

/** The hook fixtures and the host-db fixture were captured from the same OpenCode run. */
async function setup() {
  const dir = tempDir()
  const hostDbPath = join(dir, "opencode.db")
  buildHostDb(hostDbPath)
  const repo = await memRepo()
  return { repo, hostDbPath }
}

describe("import from OpenCode storage", () => {
  test("backfill alone reproduces the usage OpenCode recorded", async () => {
    const { repo, hostDbPath } = await setup()
    const result = await importFromOpencode(repo, { hostDbPath })
    expect(result.sessions).toBe(6)
    expect(result.steps.inserted).toBe(7) // plain 1 + spawn 3 + subtask 2 + inline 1
    const host = await openHostDb(hostDbPath)
    const expected = host.prepare(`SELECT SUM(tokens_input) AS i, SUM(tokens_output) AS o, SUM(tokens_cache_read) AS c, SUM(cost) AS cost FROM session`).get()!
    host.close()
    const u = queryUsage(repo.db, { range: ALL })
    expect(u.totals.inputTokens).toBe(Number(expected.i))
    expect(u.totals.outputTokens).toBe(Number(expected.o))
    expect(u.totals.cacheReadTokens).toBe(Number(expected.c))
    expect(u.totals.cost).toBeCloseTo(Number(expected.cost), 10)
  })

  test("plugin data reconciles exactly with OpenCode storage (no new steps, no mismatches)", async () => {
    const { repo, hostDbPath } = await setup()
    for (const run of RUNS) applyAll(repo, replay(readHooks(run)))
    const before = queryUsage(repo.db, { range: ALL }).totals
    const result = await importFromOpencode(repo, { hostDbPath })
    expect(result.steps).toEqual({ inserted: 0, alreadyPresent: 7, mismatched: 0 })
    const after = queryUsage(repo.db, { range: ALL })
    expect(after.totals).toEqual(before)
    expect(after.reconciliation).toEqual({ stepsSeenByPlugin: 7, stepsSeenByImport: 7, importMismatches: 0 })
  })

  test("import is idempotent", async () => {
    const { repo, hostDbPath } = await setup()
    await importFromOpencode(repo, { hostDbPath })
    const second = await importFromOpencode(repo, { hostDbPath })
    expect(second.steps.inserted).toBe(0)
    expect(q(repo.db, `SELECT COUNT(*) AS n FROM llm_steps`)[0]!.n).toBe(7)
  })

  test("subtask commands are recovered from storage; inline commands are not observable there", async () => {
    const { repo, hostDbPath } = await setup()
    await importFromOpencode(repo, { hostDbPath })
    const c = queryCommands(repo.db, ALL)
    expect(c.byName.map((x) => x.name)).toEqual(["sub"])
    expect(c.byName[0]!.descendant.steps).toBe(1)
  })

  test("the importer never writes to OpenCode's database", async () => {
    const { hostDbPath } = await setup()
    const host = await openHostDb(hostDbPath)
    expect(() => host.exec("DELETE FROM part")).toThrow()
    host.close()
  })

  test("unsupported storage is rejected", async () => {
    const dir = tempDir()
    const repo = await memRepo()
    const { Database } = await import("bun:sqlite")
    const p = join(dir, "other.db")
    new Database(p, { create: true }).run("CREATE TABLE x (y)")
    await expect(importFromOpencode(repo, { hostDbPath: p })).rejects.toThrow("Unsupported OpenCode storage")
  })
})
