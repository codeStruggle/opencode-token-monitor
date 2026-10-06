/**
 * Builds release artifacts from one source tree:
 *   dist/opencode-token-monitor.js   single-file OpenCode plugin (Bun runtime, bun:sqlite)
 *   dist/cli/tokenmon.js             npm CLI (Node >= 22.13 with node:sqlite, or Bun)
 *   dist/bin/tokenmon-*              standalone binaries (--binaries)
 *   dist/checksums.txt
 */
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { SUPPORTED_SCHEMA_VERSION } from "../src/db/migrations.ts"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
const withBinaries = process.argv.includes("--binaries")
const only = process.argv.find((a) => a.startsWith("--targets="))?.slice("--targets=".length).split(",")

const BINARY_TARGETS: Record<string, string> = {
  "tokenmon-linux-x64": "bun-linux-x64",
  "tokenmon-linux-arm64": "bun-linux-arm64",
  "tokenmon-macos-x64": "bun-darwin-x64",
  "tokenmon-macos-arm64": "bun-darwin-arm64",
  "tokenmon-windows-x64.exe": "bun-windows-x64",
}

const banner = `// GENERATED FILE
// Source: codeStruggle/opencode-token-monitor
// Version: ${pkg.version}
// DB schema: ${SUPPORTED_SCHEMA_VERSION}
// License: MIT
// DO NOT EDIT
`

async function bundle(entry: string, target: "bun" | "node", define: Record<string, string> = {}): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    target,
    format: "esm",
    minify: false,
    external: ["bun:sqlite", "node:sqlite"],
    define,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`build failed: ${entry}`)
  }
  return await result.outputs[0]!.text()
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(join(dist, "cli"), { recursive: true })

const pluginCode = await bundle("src/plugin/index.ts", "bun")
// Bun's "// @bun" pragma must stay on the first line; the generated-file banner follows it.
const plugin = pluginCode.startsWith("// @bun\n") ? "// @bun\n" + banner + pluginCode.slice("// @bun\n".length) : banner + pluginCode
const pluginPath = join(dist, "opencode-token-monitor.js")
writeFileSync(pluginPath, plugin)

const define = { __EMBEDDED_PLUGIN__: JSON.stringify(plugin) }
const cli = await bundle("src/cli/tokenmon.ts", "node", define)
const cliPath = join(dist, "cli", "tokenmon.js")
writeFileSync(cliPath, "#!/usr/bin/env node\n" + banner + cli.replace(/^#!.*\n/, ""))
chmodSync(cliPath, 0o755)

if (withBinaries) {
  mkdirSync(join(dist, "bin"), { recursive: true })
  for (const [name, target] of Object.entries(BINARY_TARGETS)) {
    if (only && !only.includes(name)) continue
    const out = join(dist, "bin", name)
    // Compile the already bundled CLI: it carries the embedded plugin, so nothing large goes through
    // the command line (Windows limits it to 32 KiB; passing the bundle via --define failed there).
    const proc = Bun.spawnSync([process.execPath, "build", "--compile", `--target=${target}`, cliPath, "--outfile", out], {
      stdout: "inherit",
      stderr: "inherit",
    })
    if (proc.exitCode !== 0) throw new Error(`binary build failed: ${name}`)
  }
}

const files: string[] = [pluginPath, cliPath]
try {
  for (const f of readdirSync(join(dist, "bin"))) files.push(join(dist, "bin", f))
} catch {
  // no binaries
}
const lines = files.map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${f.slice(dist.length + 1)}`)
writeFileSync(join(dist, "checksums.txt"), lines.join("\n") + "\n")
for (const f of files) console.log(`${f.slice(root.length + 1)}  ${statSync(f).size} bytes`)
