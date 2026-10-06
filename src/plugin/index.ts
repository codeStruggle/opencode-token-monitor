import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { join } from "node:path"
import { Collector } from "../collector/collector.ts"
import { computeConfigFingerprint, type FingerprintScope } from "../collector/fingerprint.ts"
import { captureGitSnapshot } from "../collector/git.ts"
import type { NormalizedEvent } from "../core/events.ts"
import { openDatabase } from "../db/driver.ts"
import { migrate, SchemaTooNewError } from "../db/migrations.ts"
import { Repository } from "../db/repository.ts"
import { resolveDbPath, resolveOpencodeConfigDir } from "../runtime/paths.ts"
import { PACKAGE_NAME, PLUGIN_VERSION } from "../version.ts"
import { WriteQueue } from "./queue.ts"

type Registration = { version: string; source: string; loadedAt: number; onDuplicate?: (info: string) => void }
type Registry = { instances: Map<string, Registration>; duplicates: number }

const REGISTRY_KEY = Symbol.for("opencode-token-monitor.registry")

/** Process-wide guard: one collecting instance per OpenCode project directory. */
function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>
  return (g[REGISTRY_KEY] ??= { instances: new Map(), duplicates: 0 })
}

function sourceOf(): string {
  try {
    return import.meta.url
  } catch {
    return "unknown"
  }
}

function log(input: PluginInput, level: "info" | "warn" | "error", message: string): void {
  try {
    const client = input.client as unknown as {
      app?: { log?: (args: { body: { service: string; level: string; message: string } }) => Promise<unknown> }
    }
    void client.app?.log?.({ body: { service: PACKAGE_NAME, level, message } })?.catch?.(() => {})
  } catch {
    // Logging must never affect the host.
  }
}

/** Wraps a hook so it can never throw into OpenCode. */
function safe<A extends unknown[]>(onError: (e: unknown) => void, fn: (...args: A) => void) {
  return async (...args: A): Promise<void> => {
    try {
      fn(...args)
    } catch (error) {
      onError(error)
    }
  }
}

export const TokenMonitorPlugin: Plugin = async (input) => {
  const reg = registry()
  const directory = input.directory || input.worktree || "unknown"
  const source = sourceOf()
  const existing = reg.instances.get(directory)
  if (existing) {
    reg.duplicates++
    const info = JSON.stringify({ directory, active: { version: existing.version, source: existing.source }, skipped: { version: PLUGIN_VERSION, source } })
    log(input, "warn", `Duplicate load ignored: ${info}`)
    try {
      existing.onDuplicate?.(info)
    } catch {
      // ignore
    }
    return {}
  }
  const registration: Registration = { version: PLUGIN_VERSION, source, loadedAt: Date.now() }
  reg.instances.set(directory, registration)

  let repo: Repository
  try {
    const { path } = resolveDbPath()
    const db = await openDatabase(path, { create: true })
    migrate(db)
    repo = new Repository(db, PLUGIN_VERSION)
  } catch (error) {
    const reason = error instanceof SchemaTooNewError ? error.message : `database unavailable: ${String(error)}`
    log(input, "error", `Token monitor disabled: ${reason}`)
    reg.instances.delete(directory)
    return {}
  }

  let diagnosticsThisMinute = 0
  let minute = 0
  const diagnose = (level: "info" | "warn" | "error", code: string, message: string) => {
    const m = Math.floor(Date.now() / 60_000)
    if (m !== minute) {
      minute = m
      diagnosticsThisMinute = 0
    }
    if (++diagnosticsThisMinute > 20) return
    queue.push([{ kind: "diagnostic", level, code, message, ts: Date.now() }])
  }

  const queue = new WriteQueue(repo, {
    onError: (error, dropped) => {
      try {
        repo.diagnostic("error", "write.failed", `${String(error)}${dropped ? ` (dropped ${dropped} events)` : ""}`)
      } catch {
        // The database itself is failing; nothing else to do.
      }
    },
  })
  queue.start()
  const sink = (events: NormalizedEvent[]) => queue.push(events)
  registration.onDuplicate = (info) => diagnose("warn", "plugin.duplicate", info)

  let fingerprint: string | null = null
  const scopes: FingerprintScope[] = [{ name: "global", dir: resolveOpencodeConfigDir() }]
  if (process.env.OPENCODE_CONFIG_DIR) scopes.push({ name: "config-dir", dir: process.env.OPENCODE_CONFIG_DIR })
  if (input.worktree) {
    scopes.push({ name: "project", dir: join(input.worktree, ".opencode") })
    scopes.push({ name: "project-root", dir: input.worktree, entries: ["AGENTS.md", "opencode.json", "opencode.jsonc"] })
  }
  if (input.directory && input.directory !== input.worktree) {
    scopes.push({ name: "directory", dir: input.directory, entries: ["AGENTS.md"] })
  }
  const fingerprintReady = computeConfigFingerprint(scopes, repo.hmacSalt())
    .then((fp) => {
      fingerprint = fp.id
      sink([fp])
    })
    .catch((error) => diagnose("warn", "fingerprint.failed", String(error)))

  const collector = new Collector({
    sink,
    configFingerprint: () => fingerprint,
    onRootSession: (sessionId, dir) => {
      void fingerprintReady
        .then(() => captureGitSnapshot(sessionId, dir ?? input.worktree ?? null))
        .then((snapshot) => sink([snapshot]))
        .catch((error) => diagnose("warn", "git.failed", String(error)))
    },
  })

  const project = input.project as unknown as { id?: string; worktree?: string; vcs?: string }
  collector.project(project?.id ?? null, project?.worktree ?? input.worktree ?? null, project?.vcs ?? null)
  diagnose("info", "plugin.loaded", JSON.stringify({ version: PLUGIN_VERSION, source, directory, duplicates: reg.duplicates }))

  const onError = (error: unknown) => diagnose("error", "hook.failed", error instanceof Error ? error.stack ?? error.message : String(error))

  const flushOnExit = () => {
    try {
      queue.flush()
    } catch {
      // ignore
    }
  }
  process.once("beforeExit", flushOnExit)
  process.once("exit", flushOnExit)

  const hooks: Hooks = {
    event: safe(onError, ({ event }: { event: unknown }) => {
      collector.onEvent(event)
      const type = (event as { type?: string } | null)?.type
      if (type === "session.idle" || type === "command.executed") queue.flush()
    }),
    "chat.message": safe(onError, (i: unknown, o: unknown) => collector.onChatMessage(i, o)),
    "chat.params": safe(onError, (i: unknown) => collector.onChatParams(i)),
    "command.execute.before": safe(onError, (i: unknown, o: unknown) => collector.onCommandBefore(i, o)),
    "experimental.chat.system.transform": safe(onError, (i: unknown, o: unknown) => collector.onSystemTransform(i, o)),
    "experimental.chat.messages.transform": safe(onError, (_i: unknown, o: unknown) => collector.onMessagesTransform(o)),
    "tool.definition": safe(onError, (i: unknown, o: unknown) => collector.onToolDefinition(i, o)),
    dispose: async () => {
      try {
        queue.flush()
        queue.stop()
        reg.instances.delete(directory)
      } catch {
        // ignore
      }
    },
  }
  return hooks
}
