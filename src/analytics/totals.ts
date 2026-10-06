import type { StepRow } from "./data.ts"

/** Sums of EXACT host-reported counters. Null counters are skipped and counted, never treated as zero. */
export type UsageTotals = {
  steps: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** Sum over steps whose cost is known (host-computed list price, USD). */
  cost: number
  costCurrency: "USD"
  costKnownSteps: number
  costUnavailableSteps: number
  stepsWithMissingTokens: number
}

export function emptyTotals(): UsageTotals {
  return {
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    costCurrency: "USD",
    costKnownSteps: 0,
    costUnavailableSteps: 0,
    stepsWithMissingTokens: 0,
  }
}

export function addStep(t: UsageTotals, s: StepRow): UsageTotals {
  t.steps++
  const fields = [s.inputTokens, s.outputTokens, s.reasoningTokens, s.cacheReadTokens, s.cacheWriteTokens]
  if (fields.some((v) => v === null)) t.stepsWithMissingTokens++
  t.inputTokens += s.inputTokens ?? 0
  t.outputTokens += s.outputTokens ?? 0
  t.reasoningTokens += s.reasoningTokens ?? 0
  t.cacheReadTokens += s.cacheReadTokens ?? 0
  t.cacheWriteTokens += s.cacheWriteTokens ?? 0
  t.totalTokens += s.totalTokens ?? fields.reduce<number>((a, b) => a + (b ?? 0), 0)
  if (s.cost !== null && s.costSource !== "unavailable") {
    t.cost += s.cost
    t.costKnownSteps++
  } else t.costUnavailableSteps++
  return t
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    steps: a.steps + b.steps,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
    costCurrency: "USD",
    costKnownSteps: a.costKnownSteps + b.costKnownSteps,
    costUnavailableSteps: a.costUnavailableSteps + b.costUnavailableSteps,
    stepsWithMissingTokens: a.stepsWithMissingTokens + b.stepsWithMissingTokens,
  }
}

export function sumSteps(steps: Iterable<StepRow>): UsageTotals {
  const t = emptyTotals()
  for (const s of steps) addStep(t, s)
  return t
}

/** Rounds cost to avoid floating-point noise in output (sub-micro-dollar precision is meaningless). */
export function roundCost(t: UsageTotals): UsageTotals {
  return { ...t, cost: Math.round(t.cost * 1e8) / 1e8 }
}
