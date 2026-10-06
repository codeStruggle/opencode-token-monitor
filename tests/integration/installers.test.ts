/**
 * Runs install / verify / uninstall for both shells against an isolated HOME.
 * Bash always runs; PowerShell runs when `pwsh` is on PATH or $PWSH points to it.
 * Windows-only behaviour (junctions, Windows PowerShell 5.1) is not covered here.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "../helpers.ts"

// Each test starts several bash/pwsh processes; pwsh start-up alone can take seconds under load.
setDefaultTimeout(60_000)

const root = join(import.meta.dir, "..", "..")
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const bundle = (version: string, extra = "") =>
  `// @bun\n// GENERATED FILE\n// Source: codeStruggle/opencode-token-monitor\n// Version: ${version}\n// DB schema: 1\n// License: MIT\n// DO NOT EDIT\nexport const TokenMonitorPlugin = async () => ({})${extra}\n`

const pwsh = process.env.PWSH ?? (Bun.which("pwsh") || "")
const os = process.platform === "darwin" ? "macos" : "linux"
const binName = `tokenmon-${os}-${process.arch === "arm64" ? "arm64" : "x64"}`

type Shell = { name: "bash" | "pwsh"; run: (script: string, args: string[], env: Record<string, string>, cwd?: string) => { code: number; out: string } }

const PS_FLAGS: Record<string, string> = { "--version": "-Version", "--from": "-From", "--with-cli": "-WithCli", "--force": "-Force", "--into-link": "-IntoLink" }

function spawn(cmd: string[], env: Record<string, string>, cwd: string) {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(XDG_|OPENCODE_TOKEN_MONITOR_DB|TOKENMON_BIN_DIR)/.test(k)) clean[k] = v
  const p = Bun.spawnSync(cmd, { env: { ...clean, ...env }, cwd, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() }
}

const shells: Shell[] = [
  { name: "bash", run: (s, a, e, cwd = root) => spawn(["bash", join(cwd, `${s}.sh`), ...a], e, cwd) },
]
if (pwsh) {
  shells.push({
    name: "pwsh",
    run: (s, a, e, cwd = root) => spawn([pwsh, "-NoProfile", "-NonInteractive", "-File", join(cwd, `${s}.ps1`), ...a.map((x) => PS_FLAGS[x] ?? x)], e, cwd),
  })
}

function setup() {
  const dir = tempDir("tokenmon-installer-")
  const home = join(dir, "home")
  mkdirSync(home, { recursive: true })
  const config = join(home, ".config", "opencode")
  const plugin = join(config, "plugins", "opencode-token-monitor.js")
  const marker = join(config, ".opencode-token-monitor-install")
  const src = join(dir, "src")
  mkdirSync(src)
  const write = (version: string, extra = "") => {
    const p = join(src, `bundle-${version}${extra ? "-x" : ""}.js`)
    writeFileSync(p, bundle(version, extra))
    return p
  }
  return { dir, home, config, plugin, marker, write, env: { HOME: home, PATH: `${join(home, ".local", "bin")}:${process.env.PATH}` } }
}

/** A directory laid out like a GitHub release: bundle, CLI binary, checksums.txt, plus the scripts. */
function release(version: string, opts: { tamper?: boolean; withScripts?: boolean } = {}) {
  const dir = tempDir("tokenmon-rel-")
  const text = bundle(version)
  const cli = `#!/bin/sh\necho ${version}\n`
  writeFileSync(join(dir, "opencode-token-monitor.js"), opts.tamper ? text + "// evil\n" : text)
  writeFileSync(join(dir, binName), cli, { mode: 0o755 })
  writeFileSync(join(dir, "checksums.txt"), `${sha(text)}  opencode-token-monitor.js\n${sha(cli)}  ${binName}\n`)
  if (opts.withScripts) for (const f of ["install.sh", "install.ps1", "verify.sh", "verify.ps1", "uninstall.sh", "uninstall.ps1"]) copyFileSync(join(root, f), join(dir, f))
  return dir
}

for (const sh of shells) {
  describe(`installers (${sh.name})`, () => {
    test("install → verify → uninstall; database kept; opencode.json untouched", () => {
      const t = setup()
      mkdirSync(t.config, { recursive: true })
      const cfg = '{ "$schema": "https://opencode.ai/config.json" }\n'
      writeFileSync(join(t.config, "opencode.json"), cfg)
      const r = sh.run("install", ["--from", t.write("0.1.0")], t.env)
      expect(r).toMatchObject({ code: 0 })
      expect(readFileSync(t.plugin, "utf8")).toBe(bundle("0.1.0"))
      expect(readFileSync(t.marker, "utf8")).toContain(`PLUGIN_SHA256\t${sha(bundle("0.1.0"))}`)
      const v = sh.run("verify", [], t.env)
      expect(v.code).toBe(0)
      expect(v.out).toContain("not created yet")
      expect(v.out).toContain("Verification passed.")
      const db = join(t.home, ".local", "share", "opencode-token-monitor", "token-monitor.sqlite")
      mkdirSync(join(db, ".."), { recursive: true })
      writeFileSync(db, "data")
      const u = sh.run("uninstall", [], t.env)
      expect(u.code).toBe(0)
      expect(existsSync(t.plugin)).toBe(false)
      expect(existsSync(t.marker)).toBe(false)
      expect(readFileSync(db, "utf8")).toBe("data")
      expect(u.out).toContain("tokenmon data purge --yes")
      expect(readFileSync(join(t.config, "opencode.json"), "utf8")).toBe(cfg)
      expect(readdirSync(t.config).filter((f) => f.startsWith(".opencode-token-monitor-backup"))).toEqual([])
    })

    test("reinstall is idempotent and an upgrade of our own file needs no --force", () => {
      const t = setup()
      expect(sh.run("install", ["--from", t.write("0.1.0")], t.env).code).toBe(0)
      expect(sh.run("install", ["--from", t.write("0.1.0")], t.env).out).toContain("Already installed")
      const up = sh.run("install", ["--from", t.write("0.2.0")], t.env)
      expect(up.code).toBe(0)
      expect(up.out).toContain("Updated")
      expect(readFileSync(t.plugin, "utf8")).toBe(bundle("0.2.0"))
      expect(sh.run("verify", [], t.env).code).toBe(0)
    })

    test("a foreign plugin file is never replaced silently; --force keeps a backup that uninstall restores", () => {
      const t = setup()
      mkdirSync(join(t.plugin, ".."), { recursive: true })
      writeFileSync(t.plugin, "someone else's file")
      const refused = sh.run("install", ["--from", t.write("0.1.0")], t.env)
      expect(refused.code).toBe(1)
      expect(readFileSync(t.plugin, "utf8")).toBe("someone else's file")
      expect(sh.run("install", ["--from", t.write("0.1.0"), "--force"], t.env).code).toBe(0)
      expect(readFileSync(t.plugin, "utf8")).toBe(bundle("0.1.0"))
      expect(sh.run("uninstall", [], t.env).code).toBe(0)
      expect(readFileSync(t.plugin, "utf8")).toBe("someone else's file")
    })

    test("a linked plugins directory (portable profile) is refused unless --into-link", () => {
      const t = setup()
      const profilePlugins = join(t.dir, "profile", "plugins")
      mkdirSync(profilePlugins, { recursive: true })
      mkdirSync(t.config, { recursive: true })
      symlinkSync(profilePlugins, join(t.config, "plugins"), "dir")
      const refused = sh.run("install", ["--from", t.write("0.1.0")], t.env)
      expect(refused.code).toBe(1)
      expect(refused.out).toContain("update-token-monitor")
      expect(readdirSync(profilePlugins)).toEqual([])
      expect(sh.run("install", ["--from", t.write("0.1.0"), "--into-link"], t.env).code).toBe(0)
      expect(lstatSync(join(t.config, "plugins")).isSymbolicLink()).toBe(true)
      expect(readdirSync(profilePlugins)).toEqual(["opencode-token-monitor.js"])
    })

    test("verify fails on a modified bundle; uninstall preserves it", () => {
      const t = setup()
      sh.run("install", ["--from", t.write("0.1.0")], t.env)
      writeFileSync(t.plugin, bundle("0.1.0", " // hand edit"))
      const v = sh.run("verify", [], t.env)
      expect(v.code).toBe(1)
      expect(v.out).toContain("differs from the installed")
      expect(sh.run("uninstall", [], t.env).out).toContain("Preserved modified file")
      expect(existsSync(t.plugin)).toBe(true)
    })

    test("verify fails when nothing is installed; a non-release file is rejected by install", () => {
      const t = setup()
      expect(sh.run("verify", [], t.env).code).toBe(1)
      const junk = join(t.dir, "junk.js")
      writeFileSync(junk, "export {}\n")
      expect(sh.run("install", ["--from", junk], t.env).code).toBe(1)
      expect(existsSync(t.plugin)).toBe(false)
    })

    test("--version downloads plugin and CLI from a release and requires matching checksums", () => {
      const t = setup()
      const good = release("0.3.0")
      const r = sh.run("install", ["--version", "0.3.0", "--with-cli"], { ...t.env, TOKEN_MONITOR_BASE_URL: `file://${good}` })
      expect(r).toMatchObject({ code: 0 })
      expect(readFileSync(t.plugin, "utf8")).toBe(bundle("0.3.0"))
      const cli = join(t.home, ".local", "bin", "tokenmon")
      expect(existsSync(cli)).toBe(true)
      expect(sh.run("verify", [], t.env).out).toContain("(0.3.0)")
      expect(sh.run("uninstall", [], t.env).code).toBe(0)
      expect(existsSync(cli)).toBe(false)

      const t2 = setup()
      const bad = release("0.3.0", { tamper: true })
      const r2 = sh.run("install", ["--version", "0.3.0"], { ...t2.env, TOKEN_MONITOR_BASE_URL: `file://${bad}` })
      expect(r2.code).toBe(1)
      expect(r2.out).toContain("SHA-256 mismatch")
      expect(existsSync(t2.plugin)).toBe(false)
      expect(sh.run("install", ["--version", "latest"], t2.env).code).not.toBe(0)
      expect(sh.run("install", ["--version", "0.3.1"], { ...t2.env, TOKEN_MONITOR_BASE_URL: `file://${good}` }).code).toBe(1)
    })

    test("scripts run from an unpacked release directory without arguments", () => {
      const t = setup()
      const rel = release("0.4.0", { withScripts: true })
      const r = sh.run("install", ["--with-cli"], t.env, rel)
      expect(r).toMatchObject({ code: 0 })
      expect(r.out).toContain("Checksum OK: opencode-token-monitor.js")
      expect(r.out).toContain(`Checksum OK: ${binName}`)
      expect(sh.run("verify", [], t.env, rel).code).toBe(0)
      expect(sh.run("uninstall", [], t.env, rel).code).toBe(0)
    })

    test("without an install record, uninstall leaves the bundle unless --force", () => {
      const t = setup()
      mkdirSync(join(t.plugin, ".."), { recursive: true })
      writeFileSync(t.plugin, bundle("0.1.0"))
      expect(sh.run("uninstall", [], t.env).out).toContain("Left in place")
      expect(existsSync(t.plugin)).toBe(true)
      expect(sh.run("uninstall", ["--force"], t.env).code).toBe(0)
      expect(existsSync(t.plugin)).toBe(false)
    })

    test("warns about a parallel npm declaration without changing it", () => {
      const t = setup()
      mkdirSync(t.config, { recursive: true })
      const cfg = '{ "plugin": ["opencode-token-monitor@0.1.0"] }'
      writeFileSync(join(t.config, "opencode.json"), cfg)
      const r = sh.run("install", ["--from", t.write("0.1.0")], t.env)
      expect(r.out).toContain("also declares opencode-token-monitor")
      expect(readFileSync(join(t.config, "opencode.json"), "utf8")).toBe(cfg)
    })
  })
}

describe("install record is shared between shells", () => {
  test.skipIf(!pwsh)("install.sh then uninstall.ps1, install.ps1 then uninstall.sh", () => {
    const bash = shells[0]!
    const ps = shells[1]!
    const pairs: [Shell, Shell][] = [
      [bash, ps],
      [ps, bash],
    ]
    for (const [a, b] of pairs) {
      const t = setup()
      expect(a.run("install", ["--from", t.write("0.1.0")], t.env).code).toBe(0)
      expect(b.run("verify", [], t.env).code).toBe(0)
      expect(b.run("uninstall", [], t.env).code).toBe(0)
      expect(existsSync(t.plugin)).toBe(false)
      expect(existsSync(t.marker)).toBe(false)
    }
  })
})
