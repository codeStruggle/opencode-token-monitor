import type { ContextCategory, ContextSource } from "../core/events.ts"

/** Rough, provider-independent estimate. Never presented as a billed value. */
export const ESTIMATION_METHOD = "chars/4"

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function source(category: ContextCategory, name: string, chars: number): ContextSource {
  return { category, source: name, chars, estTokens: estimateTokens(chars), method: ESTIMATION_METHOD }
}

type Segment = { start: number; end: number; category: ContextCategory; source: string }

/**
 * Splits OpenCode's system prompt into observable sources using the markers OpenCode 1.18 emits:
 * `<env>…</env>`, `Instructions from: <path>` blocks (AGENTS.md and configured instructions) and
 * the skills listing (`<available_skills>`). Everything else counts as the base system prompt.
 */
export function analyzeSystemPrompt(system: readonly string[]): ContextSource[] {
  const totals = new Map<string, ContextSource>()
  const add = (category: ContextCategory, name: string, chars: number) => {
    if (chars <= 0) return
    const key = `${category}\u0000${name}`
    const prev = totals.get(key)
    if (prev) {
      prev.chars += chars
      prev.estTokens = estimateTokens(prev.chars)
    } else totals.set(key, source(category, name, chars))
  }

  for (const text of system) {
    const segments: Segment[] = []
    const envStart = text.indexOf("<env>")
    const envEndTag = text.indexOf("</env>", Math.max(envStart, 0))
    if (envStart >= 0 && envEndTag >= 0) segments.push({ start: envStart, end: envEndTag + 6, category: "environment", source: "env" })

    let skillsStart = text.indexOf("Skills provide specialized")
    const listStart = text.indexOf("<available_skills>")
    if (skillsStart < 0 || (listStart >= 0 && listStart < skillsStart - 2000)) skillsStart = listStart
    const listEnd = text.indexOf("</available_skills>")
    if (skillsStart >= 0 && listEnd > skillsStart) {
      segments.push({ start: skillsStart, end: listEnd + "</available_skills>".length, category: "skills", source: "available_skills" })
    }

    const instr = [...text.matchAll(/^Instructions from: (.+)$/gm)]
    const boundaries = segments.map((s) => s.start)
    instr.forEach((m, i) => {
      const start = m.index ?? 0
      const nextInstr = instr[i + 1]?.index ?? text.length
      const nextBoundary = Math.min(nextInstr, ...boundaries.filter((p) => p > start), text.length)
      segments.push({ start, end: nextBoundary, category: "instructions", source: (m[1] ?? "").trim() })
    })

    segments.sort((a, b) => a.start - b.start)
    let cursor = 0
    let covered = 0
    for (const seg of segments) {
      const start = Math.max(seg.start, cursor)
      if (seg.end <= start) continue
      add(seg.category, seg.source, seg.end - start)
      covered += seg.end - start
      cursor = seg.end
    }
    add("system", "base", text.length - covered)
  }
  return [...totals.values()]
}

type LoosePart = {
  type?: string
  text?: string
  synthetic?: boolean
  tool?: string
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown }
  source?: { text?: { value?: string } }
  url?: string
  prompt?: string
}

type LooseMessage = { info?: { role?: string }; parts?: LoosePart[] }

const jsonLength = (v: unknown): number => {
  if (v === undefined || v === null) return 0
  try {
    return JSON.stringify(v).length
  } catch {
    return 0
  }
}

/** Estimates conversation, tool-result and file content from the message list sent to the model. */
export function analyzeMessages(messages: readonly LooseMessage[]): ContextSource[] {
  let conversationUser = 0
  let conversationAssistant = 0
  let toolResults = 0
  let files = 0
  for (const m of messages) {
    const role = m.info?.role
    for (const p of m.parts ?? []) {
      switch (p.type) {
        case "text":
        case "reasoning":
          if (role === "user") conversationUser += p.text?.length ?? 0
          else conversationAssistant += p.text?.length ?? 0
          break
        case "subtask":
          conversationUser += p.prompt?.length ?? 0
          break
        case "tool": {
          const out = p.state?.output
          toolResults += (typeof out === "string" ? out.length : jsonLength(out)) + jsonLength(p.state?.input)
          if (typeof p.state?.error === "string") toolResults += p.state.error.length
          break
        }
        case "file":
          files += p.source?.text?.value?.length ?? 0
          break
      }
    }
  }
  const out: ContextSource[] = []
  if (conversationUser) out.push(source("conversation", "user", conversationUser))
  if (conversationAssistant) out.push(source("conversation", "assistant", conversationAssistant))
  if (toolResults) out.push(source("tool_results", "all", toolResults))
  if (files) out.push(source("files", "attachments", files))
  return out
}

export function toolDefinitionSources(defs: ReadonlyMap<string, number>): ContextSource[] {
  return [...defs.entries()].map(([tool, chars]) => source("tool_definitions", tool, chars))
}
