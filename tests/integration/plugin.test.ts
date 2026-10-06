import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { computeConfigFingerprint } from "../../src/collector/fingerprint.ts"
import { captureGitSnapshot } from "../../src/collector/git.ts"
import { openDatabase } from "../../src/db/driver.ts"
import { TokenMonitorPlugin } from "../../src/plugin/index.ts"
import { readHooks, tempDir } from "../helpers.ts"

const savedEnv = { ...process.env }
let dir: string
let dbPath: string
const logs: string[] = []

function input(directory: string): PluginInput {
  return {
    client: { app: { log: async ({ body }: { body: { message: string } }) => logs.push(body.message) } },
    project: { id: "global", worktree: directory, vcs: "git" },
    directory,
    worktree: directory,
  } as unknown as PluginInput
}

beforeEach(() => {
  dir = tempDir()
  dbPath = join(dir, "tm.sqlite")
  process.env.OPENCODE_TOKEN_MONITOR_DB = dbPath
  process.env.XDG_CONFIG_HOME = join(dir, "config")
  logs.length = 0
})

afterEach(() => {
  process.env = { ...savedEnv }
})

async function drive(hooks: Awaited<ReturnType<typeof TokenMonitorPlugin>>, run: string) {
  for (const r of readHooks(run)) {
    switch (r.hook) {
      case "event":
        await hooks.event?.({ event: r.event as never })
        break
      case "chat.message":
        await hooks["chat.message"]?.(r.input as never, r.output as never)
        break
      case "chat.params":
        await hooks["chat.params"]?.(r.input as never, {} as never)
        break
      case "command.execute.before":
        await hooks["command.execute.before"]?.(r.input as never, r.output as never)
        break
      case "experimental.chat.system.transform":
        await hooks["experimental.chat.system.transform"]?.(r.input as never, r.output as never)
        break
      case "experimental.chat.messages.transform":
        await hooks["experimental.chat.messages.transform"]?.({} as never, r.output as never)
        break
      case "tool.definition":
        await hooks["tool.definition"]?.(r.input as never, r.output as never)
        break
    }
  }
}

describe("plugin entry", () => {
  test("collects a real run into SQLite; a second load for the same directory is ignored and diagnosed", async () => {
    const project = join(dir, "proj")
    mkdirSync(project)
    const hooks = await TokenMonitorPlugin(input(project))
    const duplicate = await TokenMonitorPlugin(input(project))
    expect(Object.keys(duplicate)).toEqual([])
    expect(logs.join(" ")).toContain("Duplicate load ignored")
    await drive(hooks, "spawn")
    await hooks.dispose?.()
    const db = await openDatabase(dbPath, { queryOnly: true })
    expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM llm_steps`).get()!.n)).toBe(3)
    expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM diagnostics WHERE code = 'plugin.duplicate'`).get()!.n)).toBe(1)
    expect(Number(db.prepare(`SELECT COUNT(*) AS n FROM llm_steps WHERE seen_by_plugin = 1`).get()!.n)).toBe(3)
    db.close()
  })

  test("hook failures never reach the host", async () => {
    const hooks = await TokenMonitorPlugin(input(join(dir, "p2")))
    const poisoned = { get type(): string { throw new Error("boom") } }
    await expect(hooks.event!({ event: poisoned as never })).resolves.toBeUndefined()
    await hooks.dispose?.()
    const db = await openDatabase(dbPath, { queryOnly: true })
    expect(String(db.prepare(`SELECT message FROM diagnostics WHERE code = 'hook.failed'`).get()?.message)).toContain("boom")
    db.close()
  })

  test("a database with a newer schema disables collection without touching it", async () => {
    const db = await openDatabase(dbPath, { create: true })
    db.exec("PRAGMA user_version = 99")
    db.close()
    const hooks = await TokenMonitorPlugin(input(join(dir, "p3")))
    expect(Object.keys(hooks)).toEqual([])
    expect(logs.join(" ")).toContain("newer than this build supports")
    const after = await openDatabase(dbPath, { queryOnly: true })
    expect(after.prepare(`SELECT name FROM sqlite_master WHERE name = 'llm_steps'`).get()).toBeUndefined()
    after.close()
  })

  test("an unwritable database location disables collection quietly", async () => {
    process.env.OPENCODE_TOKEN_MONITOR_DB = "/proc/forbidden/tm.sqlite"
    const hooks = await TokenMonitorPlugin(input(join(dir, "p4")))
    expect(Object.keys(hooks)).toEqual([])
    expect(logs.join(" ")).toContain("disabled")
  })
})

describe("git and fingerprint", () => {
  test("non-git directories are unavailable, git directories report branch, commit and dirty state", async () => {
    const plain = join(dir, "plain")
    mkdirSync(plain)
    expect((await captureGitSnapshot("s", plain)).available).toBe(false)
    const repo = join(dir, "repo")
    mkdirSync(repo)
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", ...a], { cwd: repo })
    git("init", "-q", "-b", "main")
    writeFileSync(join(repo, "f"), "1")
    git("add", "-A")
    git("commit", "-qm", "x")
    const clean = await captureGitSnapshot("s", repo)
    expect(clean).toMatchObject({ available: true, branch: "main", dirty: false })
    expect(clean.commit).toMatch(/^[0-9a-f]{40}$/)
    writeFileSync(join(repo, "f"), "2")
    expect((await captureGitSnapshot("s", repo)).dirty).toBe(true)
  })

  test("fingerprint is stable, content-sensitive, salted and follows links", async () => {
    const cfg = join(dir, "cfg")
    mkdirSync(join(cfg, "commands"), { recursive: true })
    writeFileSync(join(cfg, "AGENTS.md"), "rules")
    writeFileSync(join(cfg, "commands", "a.md"), "a")
    const scopes = [{ name: "global", dir: cfg }]
    const a = await computeConfigFingerprint(scopes, "salt", {})
    const b = await computeConfigFingerprint(scopes, "salt", {})
    expect(a.id).toBe(b.id)
    expect(a.fileCount).toBe(2)
    expect(a.partial).toBe(false)
    expect((await computeConfigFingerprint(scopes, "other-salt", {})).id).not.toBe(a.id)
    writeFileSync(join(cfg, "commands", "a.md"), "changed")
    expect((await computeConfigFingerprint(scopes, "salt", {})).id).not.toBe(a.id)
    expect((await computeConfigFingerprint(scopes, "salt", { OPENCODE_CONFIG_CONTENT: "{}" })).partial).toBe(true)
    expect((await computeConfigFingerprint([{ name: "global", dir: join(dir, "missing") }], "salt", {})).fileCount).toBe(0)
  })
})
