import type { Db } from "../db/driver.ts"
import type { TimeRange } from "../time/range.ts"
import { loadSteps, type Filters } from "./data.ts"
import { envelope, type Envelope } from "./dto.ts"

export type CacheGroup = {
  provider: string | null
  model: string | null
  steps: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  promptTokens: number
  /** "reported" when the host recorded any cache activity for this model; otherwise ratios are unavailable. */
  status: "reported" | "not_reported"
  /** cacheRead / promptTokens, where promptTokens = input + cacheRead + cacheWrite. */
  readRatio: number | null
  /** cacheWrite / promptTokens. */
  writeRatio: number | null
}

export type CacheAnalysis = Envelope<"cache", { groups: CacheGroup[]; overall: Omit<CacheGroup, "provider" | "model"> }>

function finish(g: Omit<CacheGroup, "status" | "readRatio" | "writeRatio" | "promptTokens">): CacheGroup {
  const prompt = g.inputTokens + g.cacheReadTokens + g.cacheWriteTokens
  const reported = g.cacheReadTokens + g.cacheWriteTokens > 0
  return {
    ...g,
    promptTokens: prompt,
    status: reported ? "reported" : "not_reported",
    readRatio: reported && prompt > 0 ? g.cacheReadTokens / prompt : null,
    writeRatio: reported && prompt > 0 ? g.cacheWriteTokens / prompt : null,
  }
}

export function queryCache(db: Db, range: TimeRange, filters: Filters = {}): CacheAnalysis {
  const steps = loadSteps(db, range, filters)
  const groups = new Map<string, Omit<CacheGroup, "status" | "readRatio" | "writeRatio" | "promptTokens">>()
  const all = { provider: null, model: null, steps: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const s of steps) {
    const key = `${s.provider}\u0000${s.model}`
    const g = groups.get(key) ?? { provider: s.provider, model: s.model, steps: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    for (const target of [g, all]) {
      target.steps++
      target.inputTokens += s.inputTokens ?? 0
      target.cacheReadTokens += s.cacheReadTokens ?? 0
      target.cacheWriteTokens += s.cacheWriteTokens ?? 0
    }
    groups.set(key, g)
  }
  const { provider: _p, model: _m, ...overall } = finish(all)
  return envelope(
    "cache",
    range,
    { groups: [...groups.values()].map(finish).sort((a, b) => b.promptTokens - a.promptTokens), overall },
    [
      "Cache counters are as reported by OpenCode. A model with no cache activity shows ratios as unavailable, not 0%.",
      "No savings are computed: list prices for cached tokens are provider-specific and not a bill.",
    ],
  )
}
