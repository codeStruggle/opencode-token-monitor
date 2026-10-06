/**
 * Measures plugin overhead on the host's hot path by replaying captured OpenCode hooks:
 * time spent inside hooks (collector + enqueue) and time per batched SQLite flush.
 *   bun scripts/bench.ts [iterations]
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readHooks } from "../tests/helpers.ts"
import { Collector } from "../src/collector/collector.ts"
import { openDatabase } from "../src/db/driver.ts"
import { migrate } from "../src/db/migrations.ts"
import { Repository } from "../src/db/repository.ts"
import { WriteQueue } from "../src/plugin/queue.ts"

const iterations = Number(process.argv[2] ?? 200)
const db = await openDatabase(join(mkdtempSync(join(tmpdir(), "tokenmon-bench-")), "b.sqlite"), { create: true })
migrate(db)
const queue = new WriteQueue(new Repository(db, "bench"))
const records = ["plain", "spawn", "command-subtask", "command-inline"].flatMap((r) => readHooks(r))
let hookCalls = 0
let hookNs = 0
let flushes = 0
let flushNs = 0
for (let i = 0; i < iterations; i++) {
  // Fresh ids per iteration so every step is new.
  const suffix = `_${i}`
  const collector = new Collector({ sink: (e) => queue.push(e) })
  for (const r of records) {
    const rec = JSON.parse(JSON.stringify(r).replace(/"(ses_|msg_|prt_)([A-Za-z0-9]+)"/g, `"$1$2${suffix}"`))
    const t = Bun.nanoseconds()
    switch (rec.hook) {
      case "event": collector.onEvent(rec.event); break
      case "chat.message": collector.onChatMessage(rec.input, rec.output); break
      case "chat.params": collector.onChatParams(rec.input); break
      case "command.execute.before": collector.onCommandBefore(rec.input, rec.output); break
      case "experimental.chat.system.transform": collector.onSystemTransform(rec.input, rec.output); break
      case "experimental.chat.messages.transform": collector.onMessagesTransform(rec.output); break
      case "tool.definition": collector.onToolDefinition(rec.input, rec.output); break
    }
    hookNs += Bun.nanoseconds() - t
    hookCalls++
  }
  const t = Bun.nanoseconds()
  queue.flush()
  flushNs += Bun.nanoseconds() - t
  flushes++
}
const steps = Number(db.prepare(`SELECT COUNT(*) AS n FROM llm_steps`).get()!.n)
const { size } = Bun.file(db.path)
console.log(JSON.stringify({
  iterations,
  hookCalls,
  meanHookMicros: +(hookNs / hookCalls / 1000).toFixed(2),
  meanFlushMillis: +(flushNs / flushes / 1e6).toFixed(3),
  eventsPerFlush: Math.round(queue.stats.written / flushes),
  steps,
  dbBytes: size,
  bytesPerStep: Math.round(size / steps),
}, null, 2))
