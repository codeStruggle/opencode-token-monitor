import { describe, expect, test } from "bun:test"
import { Collector } from "../../src/collector/collector.ts"
import type { CommandStartEvent, ModelUsageEvent, NormalizedEvent, RequestEvent, ToolEvent } from "../../src/core/events.ts"
import { readHooks, replay } from "../helpers.ts"

const of = <K extends NormalizedEvent["kind"]>(events: NormalizedEvent[], kind: K) =>
  events.filter((e): e is Extract<NormalizedEvent, { kind: K }> => e.kind === kind)

describe("replay of real OpenCode 1.18.34 runs", () => {
  test("plain prompt: one step with exact counters and host cost", () => {
    const events = replay(readHooks("plain"))
    const steps = of(events, "step") as ModelUsageEvent[]
    expect(steps).toHaveLength(1)
    const s = steps[0]!
    expect(s.provider).toBe("mock")
    expect(s.model).toBe("mock-model")
    expect(s.agent).toBe("build")
    expect(s.costSource).toBe("host_computed")
    expect(s.costCurrency).toBe("USD")
    expect(s.hostVersion).toBe("1.18.34")
    // Disjoint counters (see docs/API_SPIKE.md): total = sum of the five.
    expect(s.totalTokens).toBe(s.inputTokens! + s.outputTokens! + s.reasoningTokens! + s.cacheReadTokens! + s.cacheWriteTokens!)
    expect(s.id.startsWith("prt_")).toBe(true)
  })

  test("the title request has no step and is not linked; the build request is", () => {
    const events = replay(readHooks("plain"))
    const requests = of(events, "request") as RequestEvent[]
    expect(requests.map((r) => r.agent).sort()).toEqual(["build", "title"])
    const links = of(events, "request_step")
    expect(links).toHaveLength(1)
    const build = requests.find((r) => r.agent === "build")!
    expect(links[0]!.requestId).toBe(build.id)
    expect(build.pricingKnown).toBe(true)
    const cats = new Set(build.sources.map((s) => s.category))
    for (const c of ["system", "environment", "instructions", "skills", "tool_definitions", "conversation"]) expect(cats.has(c as never)).toBe(true)
    const title = requests.find((r) => r.agent === "title")!
    expect(title.sources.some((s) => s.category === "tool_definitions")).toBe(false)
  })

  test("subagent spawn: child session is linked to the task tool call", () => {
    const events = replay(readHooks("spawn"))
    const sessions = of(events, "session")
    const child = sessions.find((s) => s.parentId)!
    expect(child).toBeDefined()
    const task = (of(events, "tool") as ToolEvent[]).filter((t) => t.tool === "task")
    expect(task.some((t) => t.childSessionId === child.id)).toBe(true)
    expect(task.at(-1)!.status).toBe("completed")
    const steps = of(events, "step") as ModelUsageEvent[]
    expect(steps.filter((s) => s.sessionId === child.id)).toHaveLength(1)
    expect(steps.filter((s) => s.sessionId === child.parentId)).toHaveLength(2)
  })

  test("subtask command: command run keyed by its user message; synthetic follow-up is marked", () => {
    const events = replay(readHooks("command-subtask"))
    const starts = of(events, "command_start") as CommandStartEvent[]
    expect(starts).toHaveLength(1)
    expect(starts[0]!.name).toBe("sub")
    expect(starts[0]!.subtask).toBe(true)
    expect(starts[0]!.id).toBe(`cmd:${starts[0]!.userMessageId}`)
    expect(of(events, "command_end").map((e) => e.id)).toEqual([starts[0]!.id])
    expect(of(events, "synthetic_mark")).toHaveLength(1)
  })

  test("inline command runs in the current session", () => {
    const events = replay(readHooks("command-inline"))
    const starts = of(events, "command_start") as CommandStartEvent[]
    expect(starts).toHaveLength(1)
    expect(starts[0]!.subtask).toBe(false)
    expect(starts[0]!.argumentsLength).toBe("argB".length)
    expect(of(events, "command_end")).toHaveLength(1)
  })

  test("replaying the same run twice through one collector emits each step once", () => {
    const events: NormalizedEvent[] = []
    const c = new Collector({ sink: (e) => events.push(...e) })
    const records = readHooks("plain").filter((r) => r.hook === "event")
    for (const r of [...records, ...records]) c.onEvent(r.event)
    expect(of(events, "step")).toHaveLength(1)
  })
})

describe("robustness", () => {
  test("garbage input never throws and yields nothing", () => {
    const events: NormalizedEvent[] = []
    const c = new Collector({ sink: (e) => events.push(...e) })
    for (const bad of [null, undefined, 1, "x", [], { type: 5 }, { type: "message.part.updated", properties: { part: { type: "step-finish" } } }]) {
      c.onEvent(bad)
      c.onChatMessage(bad, bad)
      c.onChatParams(bad)
      c.onCommandBefore(bad, bad)
      c.onSystemTransform(bad, bad)
      c.onMessagesTransform(bad)
      c.onToolDefinition(bad, bad)
    }
    expect(events).toEqual([])
  })

  test("a step whose message was never seen still records usage without model info", () => {
    const events: NormalizedEvent[] = []
    const c = new Collector({ sink: (e) => events.push(...e) })
    c.onEvent({
      type: "message.part.updated",
      properties: { part: { id: "p1", sessionID: "s1", messageID: "m1", type: "step-finish", reason: "stop", cost: 0.1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
    })
    const step = of(events, "step")[0] as ModelUsageEvent
    expect(step.provider).toBeNull()
    expect(step.cost).toBe(0.1)
  })

  test("command.executed without a chat.message still records the run (without a turn link)", () => {
    const events: NormalizedEvent[] = []
    const c = new Collector({ sink: (e) => events.push(...e), now: () => 42 })
    c.onCommandBefore({ command: "x", sessionID: "s", arguments: "" }, { parts: [] })
    c.onEvent({ type: "command.executed", properties: { name: "x", sessionID: "s", arguments: "", messageID: "m" } })
    const start = of(events, "command_start")[0] as CommandStartEvent
    expect(start.userMessageId).toBeNull()
    expect(of(events, "command_end")[0]!.id).toBe(start.id)
  })
})
