// Child process for concurrency.test.ts: migrate + write steps to a shared database file.
import { openDatabase } from "../../src/db/driver.ts"
import { migrate } from "../../src/db/migrations.ts"
import { Repository } from "../../src/db/repository.ts"
import { WriteQueue } from "../../src/plugin/queue.ts"
import { step } from "../helpers.ts"

const [path, worker, count] = process.argv.slice(2)
const db = await openDatabase(path!, { create: true })
migrate(db)
const repo = new Repository(db, "worker")
const failures: string[] = []
const queue = new WriteQueue(repo, { onError: (e) => failures.push(String(e)) })
for (let i = 0; i < Number(count); i++) {
  // Unique steps per worker plus one step id shared by all workers (duplicate delivery).
  queue.push([step({ id: `w${worker}-${i}`, ts: 1000 + i }), step({ id: "shared", ts: 1 })])
  if (i % 10 === 0) queue.flush()
}
queue.flush()
queue.flush()
db.close()
console.log(JSON.stringify({ worker, failures, stats: queue.stats }))
