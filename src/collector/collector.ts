import type { ContextSource, NormalizedEvent } from "../core/events.ts"
import { analyzeMessages, analyzeSystemPrompt, toolDefinitionSources } from "./context.ts"
import {
  commandRunId,
  isObj,
  isSyntheticTextPart,
  mapMessage,
  mapProject,
  mapSession,
  mapStepFinish,
  mapToolPart,
  modelPricingKnown,
  partType,
  str,
  type MessageInfo,
} from "./opencode-adapter.ts"

export type Sink = (events: NormalizedEvent[]) => void

export type CollectorOptions = {
  sink: Sink
  now?: () => number
  configFingerprint?: () => string | null
  /** Called for root sessions so the plugin can capture Git state asynchronously. */
  onRootSession?: (sessionId: string, directory: string | null) => void
  maxTracked?: number
}

type PendingCommand = { sessionId: string; name: string; argumentsLength: number; subtask: boolean; startedAt: number }
type PendingRequest = { id: string; agent: string | null; pricingKnown: boolean | null }

/** Bounded map: forgets the oldest entries so long-running servers do not grow without limit. */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super()
  }
  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.limit) {
      const first = this.keys().next()
      if (!first.done) this.delete(first.value)
    }
    return super.set(key, value)
  }
}

/**
 * Stateful translation of OpenCode hooks and bus events into normalized events.
 * Pure with respect to I/O: everything goes to `sink`, so it is replayable from fixtures.
 */
export class Collector {
  private readonly sink: Sink
  private readonly now: () => number
  private readonly messages: BoundedMap<string, MessageInfo>
  private readonly sessionVersions: BoundedMap<string, string>
  private readonly seenSteps: BoundedMap<string, true>
  private readonly toolStatus: BoundedMap<string, string>
  private readonly pendingCommands = new Map<string, PendingCommand>()
  private readonly activeCommands = new Map<string, string[]>()
  private readonly draftSystem = new Map<string, ContextSource[]>()
  private readonly draftMessages = new Map<string, ContextSource[]>()
  private readonly pendingRequests = new Map<string, PendingRequest[]>()
  private readonly toolDefs = new Map<string, number>()
  private readonly opts: CollectorOptions
  private requestCounter = 0

  constructor(opts: CollectorOptions) {
    this.opts = opts
    this.sink = opts.sink
    this.now = opts.now ?? Date.now
    const limit = opts.maxTracked ?? 20_000
    this.messages = new BoundedMap(limit)
    this.sessionVersions = new BoundedMap(limit)
    this.seenSteps = new BoundedMap(limit)
    this.toolStatus = new BoundedMap(limit)
  }

  project(id: string | null, worktree: string | null, vcs: string | null): void {
    const e = mapProject(id, worktree, vcs, this.now())
    if (e) this.sink([e])
  }

  /** Bus events delivered through the plugin `event` hook. */
  onEvent(event: unknown): void {
    if (!isObj(event)) return
    const type = str(event.type)
    const props = isObj(event.properties) ? event.properties : {}
    switch (type) {
      case "session.created":
      case "session.updated":
        this.onSession(props.info, type === "session.created")
        return
      case "message.updated":
        this.onMessage(props.info)
        return
      case "message.part.updated":
        this.onPart(props.part)
        return
      case "command.executed":
        this.onCommandExecuted(props)
        return
    }
  }

  private onSession(info: unknown, created: boolean): void {
    const fingerprint = this.opts.configFingerprint?.() ?? null
    const e = mapSession(info, fingerprint)
    if (!e) return
    if (e.hostVersion) this.sessionVersions.set(e.id, e.hostVersion)
    this.sink([e])
    if (created && !e.parentId) this.opts.onRootSession?.(e.id, e.directory)
  }

  private onMessage(info: unknown): void {
    const mapped = mapMessage(info)
    if (!mapped) return
    this.messages.set(mapped.info.id, mapped.info)
    this.sink([mapped.event])
  }

  private onPart(part: unknown): void {
    const type = partType(part)
    if (type === "step-finish") return this.onStepFinish(part)
    if (type === "tool") {
      const e = mapToolPart(part)
      if (!e) return
      const key = `${e.status}|${e.childSessionId ?? ""}`
      if (this.toolStatus.get(e.id) === key) return
      this.toolStatus.set(e.id, key)
      this.sink([e])
      return
    }
    if (isSyntheticTextPart(part) && isObj(part)) {
      const messageId = str(part.messageID)
      const sessionId = str(part.sessionID)
      if (messageId && sessionId && this.messages.get(messageId)?.role === "user") {
        this.sink([{ kind: "synthetic_mark", messageId, sessionId }])
      }
    }
  }

  private onStepFinish(part: unknown): void {
    if (!isObj(part)) return
    const id = str(part.id)
    const sessionId = str(part.sessionID)
    const messageId = str(part.messageID)
    if (!id || !sessionId || !messageId || this.seenSteps.has(id)) return
    this.seenSteps.set(id, true)
    const message = this.messages.get(messageId)
    const request = this.takeRequest(sessionId, message?.agent ?? null)
    const step = mapStepFinish(part, message, this.now(), this.sessionVersions.get(sessionId) ?? null, request?.pricingKnown ?? null)
    if (!step) return
    const events: NormalizedEvent[] = [step]
    if (request) events.push({ kind: "request_step", requestId: request.id, stepId: id })
    this.sink(events)
  }

  /** Requests and steps in one session are sequential; match the oldest request of the same agent. */
  private takeRequest(sessionId: string, agent: string | null): PendingRequest | undefined {
    const queue = this.pendingRequests.get(sessionId)
    if (!queue?.length) return undefined
    const index = agent ? queue.findIndex((r) => r.agent === agent) : 0
    if (index < 0) return undefined
    const [request] = queue.splice(0, index + 1).slice(-1)
    if (!queue.length) this.pendingRequests.delete(sessionId)
    return request
  }

  onCommandBefore(input: unknown, output: unknown): void {
    if (!isObj(input)) return
    const sessionId = str(input.sessionID)
    const name = str(input.command)
    if (!sessionId || !name) return
    const parts = isObj(output) && Array.isArray(output.parts) ? output.parts : []
    this.pendingCommands.set(sessionId, {
      sessionId,
      name,
      argumentsLength: typeof input.arguments === "string" ? input.arguments.length : 0,
      subtask: parts.some((p) => partType(p) === "subtask"),
      startedAt: this.now(),
    })
  }

  onChatMessage(input: unknown, output: unknown): void {
    if (!isObj(input) || !isObj(output)) return
    const sessionId = str(input.sessionID)
    const message = isObj(output.message) ? output.message : null
    const messageId = str(message?.id)
    if (!sessionId || !messageId) return
    const pending = this.pendingCommands.get(sessionId)
    if (!pending) return
    this.pendingCommands.delete(sessionId)
    const id = commandRunId(messageId)
    this.startCommand(id, pending, messageId)
  }

  private startCommand(id: string, pending: PendingCommand, userMessageId: string | null): void {
    const key = `${pending.sessionId}\u0000${pending.name}`
    this.activeCommands.set(key, [...(this.activeCommands.get(key) ?? []), id])
    this.sink([
      {
        kind: "command_start",
        id,
        sessionId: pending.sessionId,
        name: pending.name,
        argumentsLength: pending.argumentsLength,
        subtask: pending.subtask,
        userMessageId,
        startedAt: pending.startedAt,
      },
    ])
  }

  private onCommandExecuted(props: Record<string, unknown>): void {
    const sessionId = str(props.sessionID)
    const name = str(props.name)
    if (!sessionId || !name) return
    const pending = this.pendingCommands.get(sessionId)
    if (pending && pending.name === name) {
      // No chat.message was observed for this command: keep it, but without a turn link.
      this.pendingCommands.delete(sessionId)
      this.startCommand(`cmd:${sessionId}:${pending.startedAt}`, pending, null)
    }
    const key = `${sessionId}\u0000${name}`
    const ids = this.activeCommands.get(key)
    const id = ids?.shift()
    if (!ids?.length) this.activeCommands.delete(key)
    if (!id) return
    this.sink([{ kind: "command_end", id, endedAt: this.now(), endMessageId: str(props.messageID) }])
  }

  onMessagesTransform(output: unknown): void {
    if (!isObj(output) || !Array.isArray(output.messages)) return
    const messages = output.messages as { info?: { sessionID?: unknown; role?: string } }[]
    const sessionId = str(messages[messages.length - 1]?.info?.sessionID)
    if (!sessionId) return
    this.draftMessages.set(sessionId, analyzeMessages(messages as Parameters<typeof analyzeMessages>[0]))
  }

  onSystemTransform(input: unknown, output: unknown): void {
    if (!isObj(input) || !isObj(output) || !Array.isArray(output.system)) return
    const sessionId = str(input.sessionID)
    if (!sessionId) return
    this.draftSystem.set(sessionId, analyzeSystemPrompt(output.system.filter((s): s is string => typeof s === "string")))
  }

  onToolDefinition(input: unknown, output: unknown): void {
    if (!isObj(input) || !isObj(output)) return
    const toolId = str(input.toolID)
    if (!toolId) return
    const description = typeof output.description === "string" ? output.description.length : 0
    let parameters = 0
    try {
      parameters = JSON.stringify(output.parameters ?? {}).length
    } catch {
      parameters = 0
    }
    this.toolDefs.set(toolId, description + parameters)
  }

  /** chat.params fires once per LLM request; it closes the context draft for that request. */
  onChatParams(input: unknown): void {
    if (!isObj(input)) return
    const sessionId = str(input.sessionID)
    if (!sessionId) return
    const agent = str(input.agent)
    const model = isObj(input.model) ? input.model : {}
    const pricingKnown = modelPricingKnown(model)
    const id = `req_${this.now().toString(36)}_${(this.requestCounter++).toString(36)}_${sessionId.slice(-8)}`
    const system = this.draftSystem.get(sessionId) ?? []
    this.draftSystem.delete(sessionId)
    const isAuxiliary = agent === "title" || agent === "summary"
    const messages = isAuxiliary ? [] : (this.draftMessages.get(sessionId) ?? [])
    if (!isAuxiliary) this.draftMessages.delete(sessionId)
    const tools = isAuxiliary ? [] : toolDefinitionSources(this.toolDefs)
    const queue = this.pendingRequests.get(sessionId) ?? []
    queue.push({ id, agent, pricingKnown })
    if (queue.length > 50) queue.shift()
    this.pendingRequests.set(sessionId, queue)
    this.sink([
      {
        kind: "request",
        id,
        sessionId,
        agent,
        provider: str(model.providerID),
        model: str(model.id),
        ts: this.now(),
        pricingKnown,
        sources: [...system, ...messages, ...tools],
      },
    ])
  }

  /** Exposed for diagnostics and tests. */
  stats(): { trackedMessages: number; pendingRequests: number; pendingCommands: number } {
    let pending = 0
    for (const q of this.pendingRequests.values()) pending += q.length
    return { trackedMessages: this.messages.size, pendingRequests: pending, pendingCommands: this.pendingCommands.size }
  }
}

