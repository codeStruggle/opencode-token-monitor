export type ParsedArgs = {
  positionals: string[]
  flags: Map<string, string | true>
}

/** Flags that never take a value. Everything else of the form --name consumes the next token. */
const BOOLEAN_FLAGS = new Set([
  "json",
  "csv",
  "help",
  "version",
  "redact-paths",
  "force",
  "dry-run",
  "yes",
  "by-source",
  "once",
])

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a === "-h") {
      flags.set("help", true)
      continue
    }
    if (a === "-v") {
      flags.set("version", true)
      continue
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      if (eq >= 0) flags.set(name, a.slice(eq + 1))
      else if (BOOLEAN_FLAGS.has(name)) flags.set(name, true)
      else {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith("--")) throw new Error(`Flag --${name} requires a value`)
        flags.set(name, value)
        i++
      }
      continue
    }
    positionals.push(a)
  }
  return { positionals, flags }
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name)
  return typeof v === "string" ? v : undefined
}

export function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name)
}
