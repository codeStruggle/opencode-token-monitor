/**
 * Turns raw captures from a real OpenCode run into committed fixtures:
 *   bun scripts/sanitize-fixture.ts hooks <capture.jsonl> <out.jsonl> <homeDir> <projectDir>
 *   bun scripts/sanitize-fixture.ts hostdb <opencode.db> <out.json> <homeDir> <projectDir>
 * Paths are rewritten to /home/user and /work/proj; noisy bus events are dropped.
 */
import { Database } from "bun:sqlite"
import { readFileSync, writeFileSync } from "node:fs"

const [mode, input, output, home, project] = process.argv.slice(2)
if (!mode || !input || !output || !home || !project) throw new Error("usage: sanitize-fixture.ts hooks|hostdb <in> <out> <home> <project>")

const redact = (text: string) => text.split(project).join("/work/proj").split(home).join("/home/user")
const NOISE = new Set(["plugin.added", "catalog.updated", "reference.updated", "integration.updated", "lsp.updated", "file.watcher.updated"])

if (mode === "hooks") {
  const lines = readFileSync(input, "utf8").split("\n").filter(Boolean)
  const kept = lines.filter((l) => {
    const r = JSON.parse(l)
    return !(r.hook === "event" && NOISE.has(r.event?.type))
  })
  writeFileSync(output, kept.map(redact).join("\n") + "\n")
} else if (mode === "hostdb") {
  const db = new Database(input, { readonly: true })
  const tables = ["project", "session", "message", "part"]
  const schema: Record<string, string> = {}
  const rows: Record<string, unknown[]> = {}
  for (const t of tables) {
    schema[t] = String((db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) as { sql: string }).sql)
    rows[t] = db.query(`SELECT * FROM ${t}`).all()
  }
  writeFileSync(output, redact(JSON.stringify({ source: "OpenCode 1.18.34 opencode.db (mock provider run)", schema, rows }, null, 1)) + "\n")
} else throw new Error(`unknown mode ${mode}`)
