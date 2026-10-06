import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { normalizeCost, normalizeTokens, promptTokens } from "../../src/core/usage.ts"
import { DB_ENV_VAR, resolveDbPath, resolveOpencodeConfigDir, resolveOpencodeDbPath } from "../../src/runtime/paths.ts"

describe("normalizeTokens", () => {
  test("keeps the five disjoint counters and the host total", () => {
    const t = normalizeTokens({ total: 1052, input: 802, output: 40, reasoning: 10, cache: { read: 200, write: 0 } })
    expect(t).toEqual({
      inputTokens: 802,
      outputTokens: 40,
      reasoningTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      totalTokens: 1052,
    })
    expect(promptTokens(t)).toBe(1002)
  })

  test("derives total only when every counter is present", () => {
    expect(normalizeTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }).totalTokens).toBe(15)
    expect(normalizeTokens({ input: 1, output: 2 }).totalTokens).toBeNull()
  })

  test("missing values stay null, never zero", () => {
    const t = normalizeTokens({ input: 5 })
    expect(t.outputTokens).toBeNull()
    expect(t.cacheReadTokens).toBeNull()
    expect(normalizeTokens(null).inputTokens).toBeNull()
  })
})

describe("normalizeCost", () => {
  const tokens = normalizeTokens({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
  const none = normalizeTokens({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

  test("positive host cost is a host-computed list price in USD", () => {
    expect(normalizeCost(0.0032, tokens)).toEqual({ cost: 0.0032, costCurrency: "USD", costSource: "host_computed" })
  })

  test("zero cost with tokens and unknown pricing is unavailable, not a real zero", () => {
    expect(normalizeCost(0, tokens)).toEqual({ cost: null, costCurrency: null, costSource: "unavailable" })
    expect(normalizeCost(0, tokens, false).costSource).toBe("unavailable")
  })

  test("zero cost is real when the model is known to be priced, or when nothing was used", () => {
    expect(normalizeCost(0, tokens, true).cost).toBe(0)
    expect(normalizeCost(0, none).costSource).toBe("host_computed")
  })

  test("missing cost is unavailable", () => {
    expect(normalizeCost(undefined, tokens).costSource).toBe("unavailable")
  })
})

describe("paths", () => {
  test("override wins, then XDG_DATA_HOME, then ~/.local/share", () => {
    expect(resolveDbPath({ [DB_ENV_VAR]: "/x/db.sqlite", XDG_DATA_HOME: "/xdg" }, "/h")).toEqual({ path: "/x/db.sqlite", reason: "override" })
    expect(resolveDbPath({ XDG_DATA_HOME: "/xdg" }, "/h")).toEqual({
      path: join("/xdg", "opencode-token-monitor", "token-monitor.sqlite"),
      reason: "xdg",
    })
    expect(resolveDbPath({}, "/h")).toEqual({
      path: join("/h", ".local", "share", "opencode-token-monitor", "token-monitor.sqlite"),
      reason: "default",
    })
  })

  test("blank values are ignored", () => {
    expect(resolveDbPath({ [DB_ENV_VAR]: "  ", XDG_DATA_HOME: "" }, "/h").reason).toBe("default")
  })

  test("OpenCode locations follow XDG", () => {
    expect(resolveOpencodeConfigDir({}, "/h")).toBe(join("/h", ".config", "opencode"))
    expect(resolveOpencodeConfigDir({ XDG_CONFIG_HOME: "/c" }, "/h")).toBe(join("/c", "opencode"))
    expect(resolveOpencodeDbPath({ XDG_DATA_HOME: "/d" }, "/h")).toBe(join("/d", "opencode", "opencode.db"))
  })
})
