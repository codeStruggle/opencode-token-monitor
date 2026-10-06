/**
 * End-to-end check against a real OpenCode binary with an isolated HOME and a mock provider.
 *   OPENCODE_BIN=/path/to/opencode bun tests/e2e/run-e2e.ts
 * Requires `bun run build` (uses dist/opencode-token-monitor.js and dist/cli/tokenmon.js) and network
 * access for OpenCode to install @ai-sdk/openai-compatible on first use.
 * Prints a JSON report; exits non-zero if any check fails.
 */
import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMockProvider } from "./mock-provider.ts"

const root = join(import.meta.dir, "..", "..")
const opencode = process.env.OPENCODE_BIN ?? "opencode"
const work = mkdtempSync(join(tmpdir(), "tokenmon-e2e-"))
const home = join(work, "home")
const project = join(work, "proj")
const db = join(work, "tm.sqlite")
const configDir = join(home, ".config", "opencode")
const checks: { name: string; ok: boolean; detail?: unknown }[] = []
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail })

const mock = startMockProvider(0, join(project, "package.json"))
mkdirSync(join(configDir, "commands"), { recursive: true })
mkdirSync(project, { recursive: true })
const config = {
  $schema: "https://opencode.ai/config.json",
  model: "mock/mock-model",
  small_model: "mock/mock-model",
  autoupdate: false,
  share: "disabled",
  provider: {
    mock: {
      npm: "@ai-sdk/openai-compatible",
      name: "Mock",
      options: { baseURL: mock.url, apiKey: "x" },
      models: { "mock-model": { name: "Mock Model", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }, limit: { context: 100000, output: 4000 } } },
    },
  },
}
const configText = JSON.stringify(config, null, 2)
writeFileSync(join(configDir, "opencode.json"), configText)
writeFileSync(join(configDir, "commands", "sub.md"), "---\ndescription: Run in a child session\nagent: general\nsubtask: true\n---\nChild command body $ARGUMENTS\n")
writeFileSync(join(configDir, "commands", "inline.md"), "---\ndescription: Run in the current session\n---\nInline command body $ARGUMENTS\n")
writeFileSync(join(project, "package.json"), '{"name":"proj"}\n')
writeFileSync(join(project, "AGENTS.md"), "# Rules\nBe concise.\n")
execFileSync("git", ["init", "-q"], { cwd: project })

const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: "", XDG_DATA_HOME: "", OPENCODE_TOKEN_MONITOR_DB: db }
delete (env as Record<string, string | undefined>).XDG_CONFIG_HOME
delete (env as Record<string, string | undefined>).XDG_DATA_HOME
const tokenmon = (...args: string[]) => execFileSync(process.execPath, [join(root, "dist", "cli", "tokenmon.js"), ...args], { env, encoding: "utf8" })
const json = (...args: string[]) => JSON.parse(tokenmon(...args, "--json"))

function oc(args: string[], opts: { timeoutMs?: number; signalAfterMs?: number } = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(opencode, ["run", ...args], { cwd: project, env, stdio: ["ignore", "ignore", "ignore"] })
    const kill = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 120_000)
    if (opts.signalAfterMs) setTimeout(() => p.kill("SIGINT"), opts.signalAfterMs)
    p.on("exit", (code) => {
      clearTimeout(kill)
      resolve(code)
    })
  })
}

try {
  const version = execFileSync(opencode, ["--version"], { env, encoding: "utf8" }).trim()
  const install = json("install-plugin", "--from", join(root, "dist", "opencode-token-monitor.js"))
  check("install-plugin installs the bundle", install.action === "installed", install)
  check("existing opencode.json untouched", (await Bun.file(join(configDir, "opencode.json")).text()) === configText)

  for (const prompt of ["plain hello", "please READ the file", "please SPAWN a subagent"]) {
    check(`run: ${prompt}`, (await oc([prompt])) === 0)
  }
  check("run: --command sub", (await oc(["--command", "sub", "argA"])) === 0)
  check("run: --command inline", (await oc(["--command", "inline", "argB"])) === 0)

  // Duplicate load: same bundle also as a project plugin.
  mkdirSync(join(project, ".opencode", "plugins"), { recursive: true })
  copyFileSync(join(root, "dist", "opencode-token-monitor.js"), join(project, ".opencode", "plugins", "opencode-token-monitor.js"))
  check("run with duplicate project plugin", (await oc(["duplicate load"])) === 0)

  // Abort mid-request: no usage may be fabricated for the aborted message.
  await oc(["SLOW please"], { signalAfterMs: 6000 })

  const usage = json("summary")
  check("steps recorded", usage.totals.steps >= 8, usage.totals)
  const doctor = json("doctor")
  check("duplicate load diagnosed", doctor.plugin.duplicateLoadsObserved >= 1, doctor.plugin)
  const problems = doctor.recentProblems.filter((p: { code: string }) => p.code !== "plugin.duplicate")
  check("no hook/write errors", problems.length === 0, problems)

  // OpenCode's own storage is the baseline: every host step was seen by the plugin, none was invented
  // (this also covers the aborted request and the duplicate plugin load), and no counter differs.
  const imported = json("import")
  check(
    "reconciliation: plugin steps == OpenCode steps, no mismatches",
    imported.steps.inserted === 0 && imported.steps.mismatched === 0 && imported.steps.alreadyPresent === usage.totals.steps,
    { imported: imported.steps, pluginSteps: usage.totals.steps },
  )

  const commands = json("commands")
  const sub = commands.byName.find((c: { name: string }) => c.name === "sub")
  check("/sub has direct and descendant usage", sub?.direct.steps === 1 && sub?.descendant.steps === 1, sub)
  const inline = commands.byName.find((c: { name: string }) => c.name === "inline")
  check("/inline is direct only", inline?.direct.steps === 1 && inline?.descendant.steps === 0, inline)
  check("no unlinked child sessions", commands.unattributed.unlinkedChildSessions.steps === 0)

  const sessions = json("sessions")
  for (const s of sessions.sessions.filter((x: { childSessions: number }) => x.childSessions > 0)) {
    const trace = json("trace", s.rootSessionId)
    check(`trace ${s.rootSessionId} consistent`, trace.check.consistent === true)
  }
  const context = json("context")
  check("context estimates linked to every plugin step", context.steps.withoutContext === 0, context.steps)
  const cost = usage.totals.costKnownSteps === usage.totals.steps
  check("all steps priced (host list price)", cost, usage.totals)

  // Restart persistence: another run appends to the same database.
  await oc(["after restart"])
  check("history kept across restarts", json("summary").totals.steps === usage.totals.steps + 1)

  const report = { opencode: version, work, checks, passed: checks.every((c) => c.ok) }
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed ? 0 : 1
} finally {
  mock.stop()
}
if (!existsSync(db)) process.exitCode = 1
