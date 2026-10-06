import { beforeAll, describe, expect, test } from "bun:test"
import { queryCache } from "../../src/analytics/cache.ts"
import { queryCommands } from "../../src/analytics/commands.ts"
import { compareBy, compareRanges } from "../../src/analytics/compare.ts"
import { queryContext } from "../../src/analytics/context.ts"
import { listSessions } from "../../src/analytics/sessions.ts"
import { queryTools } from "../../src/analytics/tools.ts"
import { querySessionTrace } from "../../src/analytics/trace.ts"
import { queryTrend } from "../../src/analytics/trend.ts"
import { queryUsage } from "../../src/analytics/usage.ts"
import type { Repository } from "../../src/db/repository.ts"
import { customRange, naturalRange } from "../../src/time/range.ts"
import { memRepo, step } from "../helpers.ts"

const DAY = 86_400_000
const T0 = Date.parse("2026-10-05T08:00:00Z")
const ALL = naturalRange("all", T0 + 10 * DAY, "UTC")

/** Minimal scenario builder writing normalized events like the plugin would. */
class Scenario {
  private t = T0
  constructor(readonly repo: Repository) {}
  tick(ms = 1000) {
    return (this.t += ms)
  }
  session(id: string, parentId: string | null = null, agent = "build", extra: { fingerprint?: string } = {}) {
    this.repo.apply(
      { kind: "session", id, projectId: "proj", parentId, directory: "/work/proj", agent, hostVersion: "1.18.34", configFingerprint: extra.fingerprint ?? null, createdAt: this.tick(), updatedAt: this.t },
      "plugin",
    )
  }
  user(id: string, sessionId: string, synthetic = false) {
    this.repo.apply({ kind: "message", id, sessionId, role: "user", parentMessageId: null, agent: "build", provider: "p", model: "m", createdAt: this.tick(), completedAt: null, finish: null, error: null }, "plugin")
    if (synthetic) this.repo.apply({ kind: "synthetic_mark", messageId: id, sessionId }, "plugin")
  }
  assistant(id: string, sessionId: string, parent: string, total: number | null, opts: { model?: string; agent?: string; cache?: number } = {}) {
    this.repo.apply(
      { kind: "message", id, sessionId, role: "assistant", parentMessageId: parent, agent: opts.agent ?? "build", provider: "p", model: opts.model ?? "m", createdAt: this.tick(), completedAt: total === null ? null : this.t + 1, finish: total === null ? null : "stop", error: total === null ? "MessageAbortedError" : null },
      "plugin",
    )
    if (total !== null) {
      const cache = opts.cache ?? 0
      this.repo.apply(
        step({ id: `step_${id}`, sessionId, messageId: id, ts: this.tick(), model: opts.model ?? "m", agent: opts.agent ?? "build", inputTokens: total - cache, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: cache, cacheWriteTokens: 0, totalTokens: total, cost: total / 1e6 }),
        "plugin",
      )
    }
  }
  task(id: string, sessionId: string, messageId: string, child: string) {
    this.repo.apply({ kind: "tool", id, sessionId, messageId, callId: id, tool: "task", status: "completed", startedAt: this.tick(), endedAt: this.t + 500, childSessionId: child, outputLength: 10 }, "plugin")
  }
  command(name: string, sessionId: string, userMessageId: string) {
    this.repo.apply({ kind: "command_start", id: `cmd:${userMessageId}`, sessionId, name, argumentsLength: 0, subtask: true, userMessageId, startedAt: this.t }, "plugin")
  }
}

let repo: Repository

beforeAll(async () => {
  repo = await memRepo()
  const s = new Scenario(repo)
  repo.db.transaction(() => {
    // Root R: /review → child C1 (→ nested C2), synthetic follow-up, then a plain prompt.
    s.session("R", null, "build", { fingerprint: "fpA" })
    s.user("U1", "R")
    s.command("review", "R", "U1")
    s.assistant("A1", "R", "U1", 22_000)
    s.session("C1", "R", "code-reviewer")
    s.task("T1", "R", "A1", "C1")
    s.user("C1u", "C1")
    s.assistant("C1a", "C1", "C1u", 91_000, { agent: "code-reviewer" })
    s.session("C2", "C1", "general")
    s.task("T2", "C1", "C1a", "C2")
    s.user("C2u", "C2")
    s.assistant("C2a", "C2", "C2u", 5_000, { agent: "general" })
    s.user("U2", "R", true)
    s.assistant("A2", "R", "U2", 1_000)
    s.user("U3", "R")
    s.assistant("A3", "R", "U3", 2_000)
    s.assistant("A4", "R", "U3", null) // aborted: no usage recorded
    s.session("C4", "R", "general") // child without an observed spawn link
    s.user("C4u", "C4")
    s.assistant("C4a", "C4", "C4u", 3_000)
    // Concurrent root R2 with /verify, interleaved in time with R.
    s.session("R2", null, "build", { fingerprint: "fpB" })
    s.user("V1", "R2")
    s.command("verify", "R2", "V1")
    s.assistant("V1a", "R2", "V1", 4_000, { model: "other", cache: 1_000 })
    s.session("C3", "R2", "build")
    s.task("T3", "R2", "V1a", "C3")
    s.user("C3u", "C3")
    s.assistant("C3a", "C3", "C3u", 6_000, { model: "other", cache: 3_000 })
  })
})

describe("command attribution", () => {
  test("direct, descendant, inclusive and unattributed rows add up without double counting", () => {
    const r = queryCommands(repo.db, ALL)
    const review = r.byName.find((c) => c.name === "review")!
    expect(review.direct.totalTokens).toBe(22_000 + 1_000)
    expect(review.descendant.totalTokens).toBe(91_000 + 5_000)
    expect(review.inclusive.totalTokens).toBe(119_000)
    const verify = r.byName.find((c) => c.name === "verify")!
    expect(verify.direct.totalTokens).toBe(4_000)
    expect(verify.descendant.totalTokens).toBe(6_000)
    expect(r.unattributed.plainPrompts.totalTokens).toBe(2_000)
    expect(r.unattributed.unlinkedChildSessions.totalTokens).toBe(3_000)
    const sum = r.byName.reduce((a, c) => a + c.inclusive.totalTokens, 0) + r.unattributed.plainPrompts.totalTokens + r.unattributed.unlinkedChildSessions.totalTokens
    expect(sum).toBe(r.totals.totalTokens)
    expect(r.totals.totalTokens).toBe(134_000)
  })

  test("usage grouped by command matches the command breakdown", () => {
    const u = queryUsage(repo.db, { range: ALL, groupBy: ["command"] })
    const get = (k: string) => u.groups.find((g) => g.key.command === k)?.totals.totalTokens
    expect(get("/review")).toBe(119_000)
    expect(get("/verify")).toBe(10_000)
    expect(get("(no command)")).toBe(2_000)
    expect(get("(unlinked child session)")).toBe(3_000)
  })
})

describe("session trace", () => {
  test("tree inclusive equals the sum of exclusive and nested children roll up", () => {
    const t = querySessionTrace(repo.db, "C2", "UTC")
    expect(t.rootSessionId).toBe("R")
    expect(t.check.consistent).toBe(true)
    expect(t.tree.inclusive.totalTokens).toBe(22_000 + 91_000 + 5_000 + 1_000 + 2_000 + 3_000)
    const c1 = t.tree.children.find((c) => c.sessionId === "C1")!
    expect(c1.exclusive.totalTokens).toBe(91_000)
    expect(c1.inclusive.totalTokens).toBe(96_000)
    expect(c1.spawnedBy?.commandName).toBe("review")
    expect(t.tree.children.find((c) => c.sessionId === "C4")!.spawnedBy).toBeNull()
    const review = t.tree.commands.find((c) => c.name === "review")!
    expect(review.inclusive.totalTokens).toBe(119_000)
  })

  test("unknown session ids are reported", () => {
    expect(() => querySessionTrace(repo.db, "nope", "UTC")).toThrow("not found")
  })
})

describe("usage, sessions, tools", () => {
  test("totals equal the sum of deduplicated steps; aborted messages add nothing", () => {
    const u = queryUsage(repo.db, { range: ALL, groupBy: ["model"] })
    expect(u.totals.steps).toBe(8)
    expect(u.groups.reduce((a, g) => a + g.totals.totalTokens, 0)).toBe(u.totals.totalTokens)
  })

  test("filters and ranges are half-open", () => {
    const first = repo.db.prepare(`SELECT MIN(ts) AS t FROM llm_steps`).get()!.t as number
    const r = customRange(new Date(first).toISOString(), new Date(first + 1).toISOString(), Date.now(), "UTC")
    expect(queryUsage(repo.db, { range: r }).totals.steps).toBe(1)
    expect(queryUsage(repo.db, { range: ALL, filters: { model: "other" } }).totals.totalTokens).toBe(10_000)
  })

  test("sessions list reports tree usage per root", () => {
    const l = listSessions(repo.db, ALL)
    const r = l.sessions.find((s) => s.rootSessionId === "R")!
    expect(r.childSessions).toBe(3)
    expect(r.inclusive.totalTokens).toBe(124_000)
  })

  test("tools report execution metadata", () => {
    const t = queryTools(repo.db, ALL)
    expect(t.tools[0]).toMatchObject({ tool: "task", calls: 3, completed: 3, childSessions: 3 })
  })
})

describe("cache, trend, compare, context", () => {
  test("cache ratios use prompt tokens as the denominator; no cache activity is not 0%", () => {
    const c = queryCache(repo.db, ALL)
    const other = c.groups.find((g) => g.model === "other")!
    expect(other.promptTokens).toBe(10_000)
    expect(other.readRatio).toBeCloseTo(0.4)
    const m = c.groups.find((g) => g.model === "m")!
    expect(m.status).toBe("not_reported")
    expect(m.readRatio).toBeNull()
  })

  test("trend includes empty buckets", () => {
    const r = customRange("2026-10-04", "2026-10-06", Date.now(), "UTC")
    const t = queryTrend(repo.db, r, "day")
    expect(t.points.map((p) => p.label)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"])
    expect(t.points[0]!.totals.steps).toBe(0)
    expect(t.points[1]!.totals.totalTokens).toBe(134_000)
  })

  test("compare ranges and fingerprints carry caveats", () => {
    const a = customRange("2026-10-04", "2026-10-04", Date.now(), "UTC")
    const b = customRange("2026-10-05", "2026-10-05", Date.now(), "UTC")
    const c = compareRanges(repo.db, a, b)
    expect(c.sides[1]!.totals.totalTokens).toBe(134_000)
    expect(c.delta!.totalTokensPct).toBeNull()
    expect(c.caveats.join(" ")).toContain("Small sample")
    const f = compareBy(repo.db, ALL, "fingerprint")
    expect(f.sides.map((x) => x.label).sort()).toEqual(["fpA", "fpB"])
    expect(f.sides.find((x) => x.label === "fpA")!.totals.totalTokens).toBe(124_000)
  })

  test("context: coverage, unknown residual and allocation never go negative", async () => {
    const r = await memRepo()
    r.apply(step({ id: "s1", inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 1010 }), "plugin")
    r.apply({ kind: "request", id: "q1", sessionId: "ses_1", agent: "build", provider: "p", model: "m", ts: 1000, pricingKnown: true, sources: [
      { category: "system", source: "base", chars: 2000, estTokens: 500, method: "chars/4" },
      { category: "conversation", source: "user", chars: 400, estTokens: 100, method: "chars/4" },
    ] }, "plugin")
    r.apply({ kind: "request_step", requestId: "q1", stepId: "s1" }, "plugin")
    r.apply({ kind: "request", id: "q2", sessionId: "ses_1", agent: "title", provider: "p", model: "m", ts: 1000, pricingKnown: true, sources: [] }, "plugin")
    const c = queryContext(r.db, ALL)
    expect(c.actualPromptTokens).toBe(1000)
    expect(c.estimatedTotalTokens).toBe(600)
    expect(c.unknownTokens).toBe(400)
    expect(c.coverage).toBeCloseTo(0.6)
    expect(c.requests.withoutStep).toBe(1)
    expect(c.categories.find((x) => x.category === "unknown")!.estimatedTokens).toBe(400)

    r.apply({ kind: "request", id: "q3", sessionId: "ses_1", agent: "build", provider: "p", model: "m", ts: 1000, pricingKnown: true, sources: [
      { category: "system", source: "base", chars: 40000, estTokens: 10000, method: "chars/4" },
    ] }, "plugin")
    r.apply(step({ id: "s2", inputTokens: 1000, cacheReadTokens: 0, totalTokens: 1010 }), "plugin")
    r.apply({ kind: "request_step", requestId: "q3", stepId: "s2" }, "plugin")
    const over = queryContext(r.db, ALL)
    expect(over.unknownTokens).toBe(0)
    expect(over.overEstimateTokens).toBe(10_600 - 2_000)
    expect(over.coverage).toBe(1)
    expect(over.categories.reduce((a, x) => a + x.allocatedTokens, 0)).toBeLessThanOrEqual(2_001)
  })

  test("auxiliary title requests are reported as unrecorded usage", async () => {
    const r = await memRepo()
    r.apply({ kind: "request", id: "q", sessionId: "s", agent: "title", provider: "p", model: "m", ts: 5, pricingKnown: true, sources: [] }, "plugin")
    expect(queryUsage(r.db, { range: ALL }).notes.join(" ")).toContain("auxiliary request")
  })
})

describe("cost semantics in totals", () => {
  test("unavailable cost is excluded from the cost sum and counted", async () => {
    const r = await memRepo()
    r.apply(step({ id: "a", cost: 0.5 }), "plugin")
    r.apply(step({ id: "b", cost: null, costCurrency: null, costSource: "unavailable" }), "plugin")
    const u = queryUsage(r.db, { range: ALL })
    expect(u.totals.cost).toBe(0.5)
    expect(u.totals.costKnownSteps).toBe(1)
    expect(u.totals.costUnavailableSteps).toBe(1)
    expect(u.notes.join(" ")).toContain("no known price")
  })
})
