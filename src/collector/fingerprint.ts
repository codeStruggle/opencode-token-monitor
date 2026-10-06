import { createHash, createHmac } from "node:crypto"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { FingerprintEvent } from "../core/events.ts"

/** File-based configuration sources OpenCode reads from a config directory. */
const CONFIG_ENTRIES = [
  "AGENTS.md",
  "opencode.json",
  "opencode.jsonc",
  "agent",
  "agents",
  "skill",
  "skills",
  "command",
  "commands",
] as const

export type FingerprintScope = { name: string; dir: string; entries?: readonly string[] }

const MAX_FILES = 2000

async function collectFiles(root: string, entry: string, out: string[]): Promise<void> {
  const path = join(root, entry)
  let info
  try {
    // stat follows symlinks and Windows junctions, so linked profile directories are hashed by content.
    info = await stat(path)
  } catch {
    return
  }
  if (info.isFile()) {
    out.push(path)
    return
  }
  if (!info.isDirectory()) return
  const stack = [path]
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      const child = join(dir, name)
      try {
        const s = await stat(child)
        if (s.isDirectory()) stack.push(child)
        else if (s.isFile()) out.push(child)
      } catch {
        // Broken links are ignored consistently.
      }
    }
  }
}

/**
 * HMAC over (scope, relative path, content hash) of every observed config file, in stable order.
 * Only file-based sources are covered; env-provided config makes the fingerprint partial.
 */
export async function computeConfigFingerprint(
  scopes: readonly FingerprintScope[],
  salt: string,
  env: Record<string, string | undefined> = process.env,
  now: () => number = Date.now,
): Promise<FingerprintEvent> {
  const lines: string[] = []
  const seenReal = new Set<string>()
  const usedScopes: string[] = []
  for (const scope of scopes) {
    const files: string[] = []
    for (const entry of scope.entries ?? CONFIG_ENTRIES) await collectFiles(scope.dir, entry, files)
    if (files.length) usedScopes.push(scope.name)
    for (const file of files) {
      let real = file
      try {
        real = await realpath(file)
      } catch {
        // keep logical path
      }
      const key = `${scope.name}\u0000${real}`
      if (seenReal.has(key)) continue
      seenReal.add(key)
      let content: Buffer
      try {
        content = await readFile(file)
      } catch {
        continue
      }
      const rel = relative(scope.dir, file).split(sep).join("/")
      lines.push(`${scope.name}:${rel}:${createHash("sha256").update(content).digest("hex")}`)
    }
  }
  lines.sort()
  const partial = Boolean(env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_CONTENT)
  const id = createHmac("sha256", salt).update(lines.join("\n")).digest("hex").slice(0, 32)
  return { kind: "fingerprint", id, scope: usedScopes, fileCount: lines.length, partial, ts: now() }
}
