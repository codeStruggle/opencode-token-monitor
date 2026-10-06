import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "../helpers.ts"

// Each test starts several bash/pwsh processes; pwsh start-up alone can take seconds under load.
setDefaultTimeout(60_000)

const root = join(import.meta.dir, "..", "..")
const scripts = join(root, "integrations", "portable-profile", "scripts")
const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string
const bundleText = `// @bun\n// GENERATED FILE\n// Source: codeStruggle/opencode-token-monitor\n// Version: ${VERSION}\n// DB schema: 1\n// DO NOT EDIT\nexport {}\n`
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

function release(content = bundleText, listed = content): string {
  const dir = tempDir("tokenmon-release-")
  writeFileSync(join(dir, "opencode-token-monitor.js"), content)
  writeFileSync(join(dir, "checksums.txt"), `${sha(listed)}  opencode-token-monitor.js\n`)
  return dir
}

function profile(): string {
  const dir = tempDir("tokenmon-profile-")
  mkdirSync(join(dir, "scripts"))
  for (const f of ["update-token-monitor.sh", "verify-token-monitor.sh"]) copyFileSync(join(scripts, f), join(dir, "scripts", f))
  return dir
}

function sh(cwdProfile: string, script: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bash", join(cwdProfile, "scripts", script), ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const files = (p: string) => [join(p, "profile/plugins/opencode-token-monitor.js"), join(p, "integrations/token-monitor/manifest.json")]

let hasCurl = true
beforeAll(() => {
  hasCurl = Bun.spawnSync(["sh", "-c", "command -v curl"]).exitCode === 0
})

describe("portable profile scripts (bash)", () => {
  test("refuses implicit latest", () => {
    const p = profile()
    expect(sh(p, "update-token-monitor.sh", ["latest"]).code).toBe(2)
  })

  test("installs a verified bundle and writes a pinned manifest", () => {
    if (!hasCurl) return
    const p = profile()
    const r = sh(p, "update-token-monitor.sh", [VERSION, "--tested-with", "1.18.34"], { TOKEN_MONITOR_BASE_URL: `file://${release()}` })
    expect(r.code).toBe(0)
    const manifest = JSON.parse(readFileSync(files(p)[1]!, "utf8"))
    expect(manifest).toMatchObject({ version: VERSION, sha256: sha(bundleText), dbSchemaVersion: 1, testedWith: { opencode: ["1.18.34"] } })
    expect(sh(p, "verify-token-monitor.sh", []).code).toBe(0)
  })

  test("checksum mismatch, wrong version and failed profile verify keep the previous state", () => {
    if (!hasCurl) return
    const p = profile()
    expect(sh(p, "update-token-monitor.sh", [VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release()}` }).code).toBe(0)
    const before = files(p).map((f) => readFileSync(f, "utf8"))
    expect(sh(p, "update-token-monitor.sh", [VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release(bundleText + "// evil\n", bundleText)}` }).code).toBe(1)
    expect(sh(p, "update-token-monitor.sh", ["9.9.9"], { TOKEN_MONITOR_BASE_URL: `file://${release()}` }).code).toBe(1)
    writeFileSync(join(p, "verify.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    expect(sh(p, "update-token-monitor.sh", [VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release(bundleText.replace("export {}", "export {} // v2"))}` }).code).toBe(1)
    expect(files(p).map((f) => readFileSync(f, "utf8"))).toEqual(before)
  })

  test("a schema downgrade is announced", () => {
    if (!hasCurl) return
    const p = profile()
    sh(p, "update-token-monitor.sh", [VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release()}` })
    const manifestPath = files(p)[1]!
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('"dbSchemaVersion": 1', '"dbSchemaVersion": 2'))
    const r = sh(p, "update-token-monitor.sh", [VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release()}` })
    expect(r.code).toBe(0)
    expect(r.out).toContain("database schema: 2 -> 1")
    expect(r.err).toContain("schema downgrade")
  })

  test("verify detects a hand-edited bundle and a missing manifest", () => {
    if (!hasCurl) return
    const p = profile()
    sh(p, "update-token-monitor.sh", [VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release()}` })
    writeFileSync(files(p)[0]!, bundleText + "// edit\n")
    expect(sh(p, "verify-token-monitor.sh", []).code).toBe(1)
    const empty = profile()
    expect(existsSync(files(empty)[1]!)).toBe(false)
    expect(sh(empty, "verify-token-monitor.sh", []).code).toBe(1)
  })
})

const pwsh = process.env.PWSH ?? (Bun.which("pwsh") || "")

function ps(cwdProfile: string, script: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync([pwsh, "-NoProfile", "-NonInteractive", "-File", join(cwdProfile, "scripts", script), ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

function psProfile(): string {
  const dir = tempDir("tokenmon-profile-ps-")
  mkdirSync(join(dir, "scripts"))
  for (const f of ["update-token-monitor.ps1", "verify-token-monitor.ps1"]) copyFileSync(join(scripts, f), join(dir, "scripts", f))
  return dir
}

describe.skipIf(!pwsh)("portable profile scripts (PowerShell)", () => {
  test("refuses implicit latest", () => {
    expect(ps(psProfile(), "update-token-monitor.ps1", ["-Version", "latest"]).code).not.toBe(0)
  })

  test("installs, verifies, and keeps the previous state on checksum mismatch or failed profile verify", () => {
    const p = psProfile()
    const r = ps(p, "update-token-monitor.ps1", ["-Version", VERSION, "-TestedWith", "1.18.34"], { TOKEN_MONITOR_BASE_URL: `file://${release()}` })
    expect(r.code).toBe(0)
    const manifest = JSON.parse(readFileSync(files(p)[1]!, "utf8").replace(/^﻿/, ""))
    expect(manifest).toMatchObject({ version: VERSION, sha256: sha(bundleText), dbSchemaVersion: 1, testedWith: { opencode: ["1.18.34"] } })
    expect(ps(p, "verify-token-monitor.ps1", []).code).toBe(0)
    // The bash verifier must accept what PowerShell wrote (shared repository, either shell).
    copyFileSync(join(scripts, "verify-token-monitor.sh"), join(p, "scripts", "verify-token-monitor.sh"))
    expect(sh(p, "verify-token-monitor.sh", []).code).toBe(0)

    const before = files(p).map((f) => readFileSync(f, "utf8"))
    expect(ps(p, "update-token-monitor.ps1", ["-Version", VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release(bundleText + "// evil\n", bundleText)}` }).code).toBe(1)
    writeFileSync(join(p, "verify.ps1"), "exit 1\n")
    expect(ps(p, "update-token-monitor.ps1", ["-Version", VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release(bundleText.replace("export {}", "export {} // v2"))}` }).code).toBe(1)
    expect(files(p).map((f) => readFileSync(f, "utf8"))).toEqual(before)
  })

  test("verify detects a hand-edited bundle", () => {
    const p = psProfile()
    ps(p, "update-token-monitor.ps1", ["-Version", VERSION], { TOKEN_MONITOR_BASE_URL: `file://${release()}` })
    writeFileSync(files(p)[0]!, bundleText + "// edit\n")
    expect(ps(p, "verify-token-monitor.ps1", []).code).toBe(1)
  })
})
