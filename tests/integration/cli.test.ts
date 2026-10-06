import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { installPlugin, PLUGIN_FILE_NAME } from "../../src/cli/install.ts"
import { redactPaths, run } from "../../src/cli/main.ts"
import { JSON_SCHEMA_VERSION } from "../../src/analytics/dto.ts"
import { applyAll, buildHostDb, fileRepo, readHooks, replay, tempDir } from "../helpers.ts"

async function cli(...argv: string[]) {
  let out = ""
  let err = ""
  const code = await run(argv, { out: (s) => (out += s), err: (s) => (err += s), now: () => Date.parse("2026-10-06T12:00:00Z") })
  return { code, out, err }
}

let dir: string
let db: string
const savedEnv = { ...process.env }

beforeEach(async () => {
  dir = tempDir()
  db = join(dir, "tm.sqlite")
  process.env.XDG_CONFIG_HOME = join(dir, "config")
  process.env.XDG_DATA_HOME = join(dir, "data")
  delete process.env.OPENCODE_TOKEN_MONITOR_DB
})

afterEach(() => {
  process.env = { ...savedEnv }
})

async function seed() {
  const repo = await fileRepo(db)
  for (const r of ["plain", "spawn", "command-subtask", "command-inline"]) applyAll(repo, replay(readHooks(r)))
  repo.db.close()
}

describe("tokenmon CLI", () => {
  test("missing database is a normal state, reported with exit code 3", async () => {
    const r = await cli("summary", "--db", db)
    expect(r.code).toBe(3)
    expect(r.err).toContain("No Token Monitor database yet")
    const j = await cli("summary", "--db", db, "--json")
    expect(JSON.parse(j.out)).toMatchObject({ kind: "error", error: "database_missing" })
    expect(existsSync(db)).toBe(false)
  })

  test("JSON contract: schemaVersion, resolved range, totals, groups, precision; no ANSI", async () => {
    await seed()
    const r = await cli("summary", "--db", db, "--json", "--group-by", "model,agent", "--tz", "Europe/Berlin", "--from", "2026-10-01", "--to", "2026-10-06")
    expect(r.code).toBe(0)
    expect(r.out).not.toContain("\x1b[")
    const j = JSON.parse(r.out)
    expect(j.schemaVersion).toBe(JSON_SCHEMA_VERSION)
    expect(j.kind).toBe("usage")
    expect(j.range).toMatchObject({ timezone: "Europe/Berlin", startIso: "2026-10-01T00:00:00+02:00", endIso: "2026-10-07T00:00:00+02:00" })
    expect(j.precision).toEqual({ usage: "exact", cost: "host_computed_list_price" })
    expect(j.groupBy).toEqual(["model", "agent"])
    expect(Object.keys(j.totals)).toContain("costUnavailableSteps")
  })

  test("named range shortcut groups by model", async () => {
    await seed()
    const r = await cli("all", "--db", db)
    expect(r.code).toBe(0)
    expect(r.out).toContain("mock/mock-model")
    expect(r.out).toContain("TOTAL")
  })

  test("CSV output is parseable and has a header", async () => {
    await seed()
    const r = await cli("summary", "--db", db, "--csv", "--group-by", "command")
    const lines = r.out.trim().split("\n")
    expect(lines[0]).toBe("command,steps,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,cost_known_steps,cost_unavailable_steps")
    expect(lines.some((l) => l.startsWith("/sub,"))).toBe(true)
    expect(lines.some((l) => l.startsWith("/inline,"))).toBe(true)
  })

  test("every read command runs against real fixture data", async () => {
    await seed()
    for (const args of [["sessions"], ["commands"], ["tools"], ["context", "--by-source"], ["cache"], ["trend", "--bucket", "week"], ["compare", "yesterday", "today"], ["compare", "--by", "fingerprint"], ["live", "--once"]]) {
      const r = await cli(...args, "--db", db)
      expect({ args, code: r.code, err: r.err }).toEqual({ args, code: 0, err: "" })
    }
    const sessions = JSON.parse((await cli("sessions", "--db", db, "--json")).out)
    const withChild = sessions.sessions.find((s: { childSessions: number }) => s.childSessions > 0)
    const trace = await cli("trace", withChild.rootSessionId.slice(-8), "--db", db)
    expect(trace.code).toBe(0)
    expect(trace.out).toContain("consistent")
  })

  test("--redact-paths hides file system paths in JSON and text", async () => {
    await seed()
    const r = await cli("context", "--by-source", "--db", db, "--json", "--redact-paths")
    expect(r.out).not.toContain("/work/proj")
    expect(r.out).toContain("path:")
    expect(redactPaths({ a: "C:\\Users\\x", b: "plain" })).toEqual({ a: expect.stringMatching(/^path:/), b: "plain" })
  })

  test("import, doctor, prune, vacuum, purge", async () => {
    const host = join(dir, "opencode.db")
    buildHostDb(host)
    const imp = await cli("import", "--db", db, "--opencode-db", host, "--json")
    expect(imp.code).toBe(0)
    expect(JSON.parse(imp.out).steps.inserted).toBe(7)
    const doc = JSON.parse((await cli("doctor", "--db", db, "--json")).out)
    expect(doc.database).toMatchObject({ status: "ok", reason: "flag", schemaVersion: 1 })
    expect(doc.database.lastImport.hostDbPath).toBe(host)
    expect((await cli("data", "prune", "--db", db)).code).toBe(2)
    const pr = await cli("data", "prune", "--before", "2000-01-01", "--db", db, "--json")
    expect(JSON.parse(pr.out).deleted.llm_steps).toBe(0)
    expect((await cli("data", "vacuum", "--db", db)).code).toBe(0)
    const noConfirm = await cli("data", "purge", "--db", db)
    expect(noConfirm.code).toBe(2)
    expect(existsSync(db)).toBe(true)
    expect((await cli("data", "purge", "--yes", "--db", db)).code).toBe(0)
    expect(existsSync(db)).toBe(false)
  })

  test("usage errors exit with code 2", async () => {
    expect((await cli("nonsense")).code).toBe(2)
    expect((await cli("summary", "--group-by", "colour", "--db", db)).code).toBe(3) // db check happens first
    await seed()
    expect((await cli("summary", "--group-by", "colour", "--db", db)).code).toBe(1)
    expect((await cli("summary", "--last", "1h", "--from", "2026-01-01", "--db", db)).code).toBe(1)
    expect((await cli("--tz")).code).toBe(2)
  })

  test("the database override environment variable is honoured", async () => {
    await seed()
    process.env.OPENCODE_TOKEN_MONITOR_DB = db
    const doc = JSON.parse((await cli("doctor", "--json")).out)
    expect(doc.database).toMatchObject({ path: db, reason: "override", status: "ok" })
  })
})

describe("install-plugin", () => {
  test("installs, is idempotent, refuses silent replacement, keeps a backup with --force", () => {
    const dest = join(dir, "plugins")
    expect(installPlugin({ bundle: "v1", dest }).action).toBe("installed")
    expect(installPlugin({ bundle: "v1", dest }).action).toBe("unchanged")
    expect(() => installPlugin({ bundle: "v2", dest })).toThrow("--force")
    expect(installPlugin({ bundle: "v2", dest, dryRun: true, force: true }).action).toBe("would-replace")
    expect(readFileSync(join(dest, PLUGIN_FILE_NAME), "utf8")).toBe("v1")
    const r = installPlugin({ bundle: "v2", dest, force: true, now: () => 7 })
    expect(r.action).toBe("replaced")
    expect(readFileSync(r.backup!, "utf8")).toBe("v1")
    expect(readFileSync(join(dest, PLUGIN_FILE_NAME), "utf8")).toBe("v2")
  })

  test("a linked plugins directory stays a link", () => {
    const real = join(dir, "profile-plugins")
    mkdirSync(real)
    const link = join(dir, "linked-plugins")
    symlinkSync(real, link, "dir")
    const r = installPlugin({ bundle: "x", dest: link })
    expect(r.directoryIsLink).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readdirSync(real)).toEqual([PLUGIN_FILE_NAME])
  })

  test("a linked plugin file is never replaced", () => {
    const dest = join(dir, "plugins")
    mkdirSync(dest)
    const managed = join(dir, "managed.js")
    writeFileSync(managed, "profile copy")
    symlinkSync(managed, join(dest, PLUGIN_FILE_NAME))
    expect(() => installPlugin({ bundle: "other", dest, force: true })).toThrow("symlink")
    expect(readFileSync(managed, "utf8")).toBe("profile copy")
  })

  test("warns about a parallel npm declaration without touching the config", () => {
    const cfg = join(dir, "config", "opencode")
    mkdirSync(cfg, { recursive: true })
    const text = '{ "plugin": ["opencode-token-monitor@0.1.0"] }'
    writeFileSync(join(cfg, "opencode.json"), text)
    const r = installPlugin({ bundle: "x", dest: join(dir, "p") })
    expect(r.warnings.join(" ")).toContain("npm")
    expect(readFileSync(join(cfg, "opencode.json"), "utf8")).toBe(text)
  })
})
