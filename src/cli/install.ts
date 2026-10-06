import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveOpencodeConfigDir } from "../runtime/paths.ts"

export const PLUGIN_FILE_NAME = "opencode-token-monitor.js"

export type InstallOptions = {
  bundle: string
  dest?: string
  force?: boolean
  dryRun?: boolean
  now?: () => number
}

export type InstallResult = {
  action: "installed" | "unchanged" | "replaced" | "would-install" | "would-replace"
  target: string
  directory: string
  directoryIsLink: boolean
  backup: string | null
  sha256: string
  warnings: string[]
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")

/** Detects an npm-based declaration of this plugin in the user's global config (read-only). */
export function findNpmDeclaration(configDir: string): string | null {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = join(configDir, name)
    if (!existsSync(p)) continue
    try {
      if (/["']opencode-token-monitor(@[^"']*)?["']/.test(readFileSync(p, "utf8"))) return p
    } catch {
      // unreadable config: not our concern
    }
  }
  return null
}

/**
 * Copies the release bundle into OpenCode's global plugins directory.
 * A linked plugins directory (symlink / junction) is kept: the file is written through the link.
 * A different existing file is never overwritten silently; --force keeps a timestamped backup.
 */
export function installPlugin(opts: InstallOptions): InstallResult {
  const configDir = resolveOpencodeConfigDir()
  const directory = opts.dest ?? join(configDir, "plugins")
  const target = join(directory, PLUGIN_FILE_NAME)
  const warnings: string[] = []
  let directoryIsLink = false
  if (existsSync(directory)) {
    directoryIsLink = lstatSync(directory).isSymbolicLink()
    if (directoryIsLink) warnings.push(`Plugins directory is a link to ${realpathSync(directory)}; installing through the link.`)
  }
  const npm = findNpmDeclaration(configDir)
  if (npm) {
    warnings.push(
      `${npm} also declares opencode-token-monitor via npm. Only one copy collects per project directory; remove one to avoid confusion.`,
    )
  }
  const hash = sha256(opts.bundle)
  const base = { target, directory, directoryIsLink, sha256: hash, warnings }
  if (existsSync(target)) {
    const current = readFileSync(target)
    if (sha256(current) === hash) return { ...base, action: "unchanged", backup: null }
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`${target} is a symlink (possibly managed by a profile). Refusing to replace it; update its source instead.`)
    }
    if (!opts.force) {
      throw new Error(`${target} exists with different content. Re-run with --force to replace it (a backup is kept).`)
    }
    const backup = `${target}.bak-${(opts.now ?? Date.now)()}`
    if (opts.dryRun) return { ...base, action: "would-replace", backup }
    copyFileSync(target, backup)
    writeFileSync(target, opts.bundle)
    return { ...base, action: "replaced", backup }
  }
  if (opts.dryRun) return { ...base, action: "would-install", backup: null }
  mkdirSync(directory, { recursive: true })
  writeFileSync(target, opts.bundle)
  return { ...base, action: "installed", backup: null }
}
