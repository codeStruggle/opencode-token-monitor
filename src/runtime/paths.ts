import { homedir } from "node:os"
import { join } from "node:path"

export const DB_ENV_VAR = "OPENCODE_TOKEN_MONITOR_DB"
export const DATA_DIR_NAME = "opencode-token-monitor"
export const DB_FILE_NAME = "token-monitor.sqlite"

export type DbPathReason = "override" | "xdg" | "default"

export type DbPathResolution = {
  path: string
  reason: DbPathReason
}

type Env = Record<string, string | undefined>

/**
 * Single source of truth for the database location, shared by the plugin and the CLI.
 * Follows the same XDG-style convention OpenCode uses for its own data directory on all platforms.
 */
export function resolveDbPath(env: Env = process.env, home: string = homedir()): DbPathResolution {
  const override = env[DB_ENV_VAR]?.trim()
  if (override) return { path: override, reason: "override" }
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg) return { path: join(xdg, DATA_DIR_NAME, DB_FILE_NAME), reason: "xdg" }
  return { path: join(home, ".local", "share", DATA_DIR_NAME, DB_FILE_NAME), reason: "default" }
}

/** OpenCode's own global config directory, as documented by OpenCode and the portable profile. */
export function resolveOpencodeConfigDir(env: Env = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg || join(home, ".config"), "opencode")
}

/** OpenCode's own SQLite database (OpenCode >= 1.x stores sessions, messages and parts there). */
export function resolveOpencodeDbPath(env: Env = process.env, home: string = homedir()): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  return join(xdg || join(home, ".local", "share"), "opencode", "opencode.db")
}
