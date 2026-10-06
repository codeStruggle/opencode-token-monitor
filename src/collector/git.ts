import { execFile } from "node:child_process"
import type { GitSnapshotEvent } from "../core/events.ts"

function git(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : stdout.toString())
      })
    } catch {
      resolve(null)
    }
  })
}

/** Git state of the project OpenCode operates on. Non-Git directories yield available = false. */
export async function captureGitSnapshot(
  sessionId: string,
  directory: string | null,
  now: () => number = Date.now,
  timeoutMs = 3000,
): Promise<GitSnapshotEvent> {
  const base: GitSnapshotEvent = {
    kind: "git",
    sessionId,
    directory,
    available: false,
    commit: null,
    branch: null,
    dirty: null,
    capturedAt: now(),
  }
  if (!directory) return base
  const inside = await git(directory, ["rev-parse", "--is-inside-work-tree"], timeoutMs)
  if (inside?.trim() !== "true") return base
  const [commit, branch, status] = await Promise.all([
    git(directory, ["rev-parse", "HEAD"], timeoutMs),
    git(directory, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs),
    git(directory, ["status", "--porcelain", "--untracked-files=normal"], timeoutMs),
  ])
  return {
    ...base,
    available: true,
    commit: commit?.trim() || null,
    branch: branch?.trim() || null,
    dirty: status === null ? null : status.trim().length > 0,
  }
}
