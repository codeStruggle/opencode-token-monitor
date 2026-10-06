import { describe, expect, test } from "bun:test"
import { analyzeMessages, analyzeSystemPrompt, estimateTokens } from "../../src/collector/context.ts"
import { readHooks } from "../helpers.ts"

describe("analyzeSystemPrompt", () => {
  test("splits env, instructions and skills; the rest is base system", () => {
    const text = [
      "You are opencode.",
      "<env>\n  cwd: /w\n</env>",
      "Instructions from: /w/AGENTS.md\n# Rules\nBe nice.",
      "Instructions from: /home/user/.config/opencode/AGENTS.md\nGlobal rule.",
      "Skills provide specialized instructions.\n<available_skills>\n<skill>x</skill>\n</available_skills>",
    ].join("\n")
    const sources = analyzeSystemPrompt([text])
    const by = (c: string, s?: string) => sources.find((x) => x.category === c && (s === undefined || x.source === s))
    expect(by("environment")?.chars).toBe("<env>\n  cwd: /w\n</env>".length)
    expect(by("instructions", "/w/AGENTS.md")).toBeDefined()
    expect(by("instructions", "/home/user/.config/opencode/AGENTS.md")).toBeDefined()
    expect(by("skills")).toBeDefined()
    const total = sources.reduce((a, s) => a + s.chars, 0)
    expect(total).toBe(text.length)
    for (const s of sources) {
      expect(s.chars).toBeGreaterThan(0)
      expect(s.estTokens).toBe(estimateTokens(s.chars))
      expect(s.method).toBe("chars/4")
    }
  })

  test("a prompt without markers is entirely base system", () => {
    expect(analyzeSystemPrompt(["abc"])).toEqual([{ category: "system", source: "base", chars: 3, estTokens: 1, method: "chars/4" }])
  })

  test("real OpenCode 1.18.34 system prompt: every character is attributed exactly once", () => {
    const record = readHooks("plain").find(
      (r) => r.hook === "experimental.chat.system.transform" && JSON.stringify(r.output).includes("Instructions from:"),
    )
    const system = (record!.output as { system: string[] }).system
    const sources = analyzeSystemPrompt(system)
    expect(sources.reduce((a, s) => a + s.chars, 0)).toBe(system.reduce((a, s) => a + s.length, 0))
    expect(sources.some((s) => s.category === "instructions" && s.source === "/work/proj/AGENTS.md")).toBe(true)
    expect(sources.some((s) => s.category === "environment")).toBe(true)
    expect(sources.some((s) => s.category === "skills")).toBe(true)
  })
})

describe("analyzeMessages", () => {
  test("separates conversation, tool results and files", () => {
    const sources = analyzeMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }, { type: "file", source: { text: { value: "12345678" } } }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "hi" },
          { type: "tool", state: { status: "completed", input: { a: 1 }, output: "result" } },
        ],
      },
    ])
    expect(sources.find((s) => s.source === "user")?.chars).toBe(5)
    expect(sources.find((s) => s.source === "assistant")?.chars).toBe(2)
    expect(sources.find((s) => s.category === "tool_results")?.chars).toBe("result".length + JSON.stringify({ a: 1 }).length)
    expect(sources.find((s) => s.category === "files")?.chars).toBe(8)
  })
})
