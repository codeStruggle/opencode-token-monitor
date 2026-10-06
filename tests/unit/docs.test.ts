import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string

test.each(["README.zh-CN.md", "README.de.md"])("%s declares the English README version it translates", (file) => {
  const marker = readFileSync(join(root, file), "utf8").split("\n").find((l) => l.startsWith("> "))
  expect(marker).toBeDefined()
  expect(marker!).toContain("README.md")
  expect(marker!).toContain(version)
})
