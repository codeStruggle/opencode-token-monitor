/**
 * The only place that understands OpenCode's message / part / session shapes (verified against
 * OpenCode 1.18.34, see docs/API_SPIKE.md). Shared by the live plugin and the importer.
 * Inputs are treated as untrusted `unknown` so host changes degrade to missing data, not crashes.
 */
import type {
  CommandStartEvent,
  MessageEvent,
  ModelUsageEvent,
  ProjectEvent,
  SessionEvent,
  ToolEvent,
} from "../core/events.ts"
import { normalizeCost, normalizeTokens, type HostTokens } from "../core/usage.ts"

type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
export const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
export const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Obj => (isObj(v) ? v : {})

export function mapSession(info: unknown, configFingerprint: string | null = null): SessionEvent | null {
  const i = obj(info)
  const id = str(i.id)
  if (!id) return null
  const time = obj(i.time)
  return {
    kind: "session",
    id,
    projectId: str(i.projectID),
    parentId: str(i.parentID),
    directory: str(i.directory),
    agent: str(i.agent),
    hostVersion: str(i.version),
    configFingerprint,
    createdAt: numOrNull(time.created),
    updatedAt: numOrNull(time.updated),
  }
}

export function mapProject(id: string | null, worktree: string | null, vcs: string | null, ts: number): ProjectEvent | null {
  if (!id) return null
  return { kind: "project", id, worktree, vcs, ts }
}

export type MessageInfo = {
  id: string
  sessionId: string
  role: "user" | "assistant"
  agent: string | null
  provider: string | null
  model: string | null
}

export function mapMessage(info: unknown): { event: MessageEvent; info: MessageInfo } | null {
  const i = obj(info)
  const id = str(i.id)
  const sessionId = str(i.sessionID)
  const role = i.role === "user" || i.role === "assistant" ? i.role : null
  if (!id || !sessionId || !role) return null
  const time = obj(i.time)
  const userModel = obj(i.model)
  const provider = role === "assistant" ? str(i.providerID) : str(userModel.providerID)
  const model = role === "assistant" ? str(i.modelID) : str(userModel.modelID)
  const agent = str(i.agent) ?? str(i.mode)
  const error = isObj(i.error) ? (str(i.error.name) ?? "error") : null
  return {
    info: { id, sessionId, role, agent, provider, model },
    event: {
      kind: "message",
      id,
      sessionId,
      role,
      parentMessageId: str(i.parentID),
      agent,
      provider,
      model,
      createdAt: numOrNull(time.created),
      completedAt: numOrNull(time.completed),
      finish: str(i.finish),
      error,
    },
  }
}

export function partType(part: unknown): string | null {
  return str(obj(part).type)
}

/** Maps a step-finish part. Returns null for any other part type. */
export function mapStepFinish(
  part: unknown,
  message: MessageInfo | undefined,
  ts: number,
  hostVersion: string | null,
  pricingKnown: boolean | null,
): ModelUsageEvent | null {
  const p = obj(part)
  if (p.type !== "step-finish") return null
  const id = str(p.id)
  const sessionId = str(p.sessionID)
  const messageId = str(p.messageID)
  if (!id || !sessionId || !messageId) return null
  const tokens = normalizeTokens(isObj(p.tokens) ? (p.tokens as HostTokens) : null)
  const cost = normalizeCost(p.cost, tokens, pricingKnown)
  return {
    kind: "step",
    id,
    sessionId,
    messageId,
    ts,
    provider: message?.provider ?? null,
    model: message?.model ?? null,
    agent: message?.agent ?? null,
    ...tokens,
    ...cost,
    finishReason: str(p.reason),
    hostVersion,
  }
}

export function mapToolPart(part: unknown): ToolEvent | null {
  const p = obj(part)
  if (p.type !== "tool") return null
  const id = str(p.id)
  const sessionId = str(p.sessionID)
  const messageId = str(p.messageID)
  const tool = str(p.tool)
  if (!id || !sessionId || !messageId || !tool) return null
  const state = obj(p.state)
  const time = obj(state.time)
  const metadata = obj(state.metadata)
  const output = state.output
  return {
    kind: "tool",
    id,
    sessionId,
    messageId,
    callId: str(p.callID),
    tool,
    status: str(state.status) ?? "unknown",
    startedAt: numOrNull(time.start),
    endedAt: numOrNull(time.end),
    // The task tool links the spawned child session explicitly (verified in OpenCode 1.18.34).
    childSessionId: str(metadata.sessionId),
    outputLength: typeof output === "string" ? output.length : null,
  }
}

export function isSyntheticTextPart(part: unknown): boolean {
  const p = obj(part)
  return p.type === "text" && p.synthetic === true
}

/** Subtask parts produced by a `subtask: true` command carry the command name. */
export function mapSubtaskCommand(part: unknown, ts: number): CommandStartEvent | null {
  const p = obj(part)
  if (p.type !== "subtask") return null
  const name = str(p.command)
  const messageId = str(p.messageID)
  const sessionId = str(p.sessionID)
  if (!name || !messageId || !sessionId) return null
  return {
    kind: "command_start",
    id: commandRunId(messageId),
    sessionId,
    name,
    argumentsLength: null,
    subtask: true,
    userMessageId: messageId,
    startedAt: ts,
  }
}

/** Command runs are keyed by the user message that carries the command, so plugin and importer agree. */
export function commandRunId(userMessageId: string): string {
  return `cmd:${userMessageId}`
}

export function modelPricingKnown(model: unknown): boolean | null {
  const cost = obj(obj(model).cost)
  const input = numOrNull(cost.input)
  const output = numOrNull(cost.output)
  if (input === null && output === null) return null
  return (input ?? 0) > 0 || (output ?? 0) > 0
}
