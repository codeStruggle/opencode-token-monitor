// Runs the built npm CLI (dist/cli/tokenmon.js) under Node with node:sqlite. Requires `bun run build` first.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const cli = join(root, "dist", "cli", "tokenmon.js")

function buildHostDb(path) {
  const fixture = JSON.parse(readFileSync(join(root, "tests", "fixtures", "opencode-1.18.34", "host-db.json"), "utf8"))
  const db = new DatabaseSync(path)
  for (const sql of Object.values(fixture.schema)) db.exec(sql)
  for (const [table, rows] of Object.entries(fixture.rows)) {
    for (const row of rows) {
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]))
    }
  }
  db.close()
}

const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

test("node CLI imports and queries with node:sqlite, without warnings on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenmon-node-"))
  const host = join(dir, "opencode.db")
  const db = join(dir, "tm.sqlite")
  buildHostDb(host)
  const imported = JSON.parse(run("import", "--opencode-db", host, "--db", db, "--json"))
  assert.equal(imported.steps.inserted, 7)
  const usage = JSON.parse(run("summary", "--db", db, "--json"))
  assert.equal(usage.totals.steps, 7)
  assert.equal(usage.schemaVersion, "1.0.0")
  const doctor = JSON.parse(run("doctor", "--db", db, "--json"))
  assert.equal(doctor.runtime.name, "node")
  assert.equal(doctor.runtime.sqliteDriver, "node:sqlite")
  const out = execFileSync(process.execPath, [cli, "summary", "--db", db], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  assert.match(out, /TOTAL/)
})
