import type { CostSource } from "./events.ts"

export type HostTokens = {
  input?: number
  output?: number
  reasoning?: number
  total?: number
  cache?: { read?: number; write?: number }
}

export type NormalizedTokens = {
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/**
 * OpenCode 1.18 reports five disjoint counters (verified in docs/API_SPIKE.md):
 * input excludes cache reads/writes, output excludes reasoning, and
 * total = input + output + reasoning + cache.read + cache.write.
 */
export function normalizeTokens(tokens: HostTokens | undefined | null): NormalizedTokens {
  if (!tokens) {
    return {
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    }
  }
  const t = {
    inputTokens: num(tokens.input),
    outputTokens: num(tokens.output),
    reasoningTokens: num(tokens.reasoning),
    cacheReadTokens: num(tokens.cache?.read),
    cacheWriteTokens: num(tokens.cache?.write),
  }
  const parts = Object.values(t)
  const derived = parts.every((v) => v !== null) ? parts.reduce<number>((a, b) => a + (b ?? 0), 0) : null
  return { ...t, totalTokens: num(tokens.total) ?? derived }
}

export type NormalizedCost = {
  cost: number | null
  costCurrency: string | null
  costSource: CostSource
}

/**
 * OpenCode computes cost itself from the model's configured list price (USD per million tokens);
 * it is not a provider bill. A zero cost with non-zero tokens means "no price known"
 * (subscriptions, custom providers without pricing) and must not be reported as a real zero.
 */
export function normalizeCost(cost: unknown, tokens: NormalizedTokens, pricingKnown: boolean | null = null): NormalizedCost {
  const value = num(cost)
  const anyTokens = (tokens.totalTokens ?? 0) > 0
  if (value === null) return { cost: null, costCurrency: null, costSource: "unavailable" }
  if (pricingKnown === false) return { cost: null, costCurrency: null, costSource: "unavailable" }
  if (value === 0 && anyTokens && pricingKnown !== true) {
    return { cost: null, costCurrency: null, costSource: "unavailable" }
  }
  return { cost: value, costCurrency: "USD", costSource: "host_computed" }
}

/** Prompt-side tokens the provider processed for one request. */
export function promptTokens(t: Pick<NormalizedTokens, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number | null {
  if (t.inputTokens === null) return null
  return t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)
}
