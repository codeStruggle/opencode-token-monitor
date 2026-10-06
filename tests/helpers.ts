import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Collector } from "../src/collector/collector.ts"
import type { ModelUsageEvent, NormalizedEvent } from "../src/core/events.ts"
import { openDatabase, type Db } from "../src/db/driver.ts"
import { migrate } from "../src/db/migrations.ts"
import { Repository } from "../src/db/repository.ts"

export const FIXTURES = join(import.meta.dir, "fixtures", "opencode-1.18.34")

export function tempDir(prefix = "tokenmon-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function memRepo(): Promise<Repository> {
  const db = await openDatabase(":memory:", { create: true })
  migrate(db)
  return new Repository(db, "0.0.0-test")
}

export async function fileRepo(path: string): Promise<Repository> {
  const db = await openDatabase(path, { create: true })
  migrate(db)
  return new Repository(db, "0.0.0-test")
}

type HookRecord = { hook: string; event?: unknown; input?: unknown; output?: unknown }

export function readHooks(name: string): HookRecord[] {
  return readFileSync(join(FIXTURES, `hooks-${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Replays a captured OpenCode run through the collector, returning the normalized events. */
export function replay(records: HookRecord[], opts: { now?: () => number } = {}): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  let t = 1_791_000_000_000
  const collector = new Collector({ sink: (e) => events.push(...e), now: opts.now ?? (() => (t += 10)) })
  for (const r of records) {
    switch (r.hook) {
      case "event":
        collector.onEvent(r.event)
        break
      case "chat.message":
        collector.onChatMessage(r.input, r.output)
        break
      case "chat.params":
        collector.onChatParams(r.input)
        break
      case "command.execute.before":
        collector.onCommandBefore(r.input, r.output)
        break
      case "experimental.chat.system.transform":
        collector.onSystemTransform(r.input, r.output)
        break
      case "experimental.chat.messages.transform":
        collector.onMessagesTransform(r.output)
        break
      case "tool.definition":
        collector.onToolDefinition(r.input, r.output)
        break
    }
  }
  return events
}

export function applyAll(repo: Repository, events: NormalizedEvent[], origin: "plugin" | "import" = "plugin"): void {
  repo.db.transaction(() => events.forEach((e) => repo.apply(e, origin)))
}

/** Builds an OpenCode-shaped database from the committed host-db fixture. */
export function buildHostDb(path: string): void {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "host-db.json"), "utf8")) as {
    schema: Record<string, string>
    rows: Record<string, Record<string, unknown>[]>
  }
  const db = new Database(path, { create: true })
  for (const sql of Object.values(fixture.schema)) db.run(sql)
  for (const [table, rows] of Object.entries(fixture.rows)) {
    for (const row of rows) {
      const cols = Object.keys(row)
      db.query(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
        ...(cols.map((c) => row[c]) as (string | number | null)[]),
      )
    }
  }
  db.close()
}

export function q(db: Db, sql: string, ...params: (string | number | null)[]) {
  return db.prepare(sql).all(...params)
}

export function step(over: Partial<ModelUsageEvent> = {}): ModelUsageEvent {
  return {
    kind: "step",
    id: "prt_1",
    sessionId: "ses_1",
    messageId: "msg_1",
    ts: 1000,
    provider: "p",
    model: "m",
    agent: "build",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    totalTokens: 160,
    cost: 0.01,
    costCurrency: "USD",
    costSource: "host_computed",
    finishReason: "stop",
    hostVersion: "1.18.34",
    ...over,
  }
}
