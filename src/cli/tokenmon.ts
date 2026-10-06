import { run } from "./main.ts"

const code = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  now: Date.now,
})
process.exitCode = code
