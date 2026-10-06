import type { UsageTotals } from "../analytics/totals.ts"

export const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : Math.round(n).toLocaleString("en-US"))

export const fmtCost = (t: Pick<UsageTotals, "cost" | "costKnownSteps" | "costUnavailableSteps">): string => {
  if (!t.costKnownSteps) return t.costUnavailableSteps ? "n/a" : "$0.00"
  const v = t.cost < 0.01 && t.cost > 0 ? t.cost.toFixed(4) : t.cost.toFixed(2)
  return `$${v}${t.costUnavailableSteps ? "*" : ""}`
}

export const fmtPct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`)

export function table(headers: string[], rows: (string | number)[][], align: ("l" | "r")[] = []): string {
  const cells = [headers, ...rows.map((r) => r.map(String))]
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)))
  const line = (r: string[]) =>
    r
      .map((c, i) => ((align[i] ?? (i === 0 ? "l" : "r")) === "l" ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ")
      .trimEnd()
  const sep = widths.map((w) => "-".repeat(w)).join("  ")
  return [line(cells[0]!), sep, ...cells.slice(1).map(line)].join("\n")
}

export const USAGE_HEADERS = ["input", "output", "reasoning", "cache read", "cache write", "total", "steps", "cost"]

export function usageCells(t: UsageTotals): string[] {
  return [
    fmtInt(t.inputTokens),
    fmtInt(t.outputTokens),
    fmtInt(t.reasoningTokens),
    fmtInt(t.cacheReadTokens),
    fmtInt(t.cacheWriteTokens),
    fmtInt(t.totalTokens),
    fmtInt(t.steps),
    fmtCost(t),
  ]
}

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return ""
  const s = typeof v === "object" ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n"
}

export const USAGE_CSV_HEADERS = [
  "steps",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_usd",
  "cost_known_steps",
  "cost_unavailable_steps",
]

export function usageCsvCells(t: UsageTotals): unknown[] {
  return [
    t.steps,
    t.inputTokens,
    t.outputTokens,
    t.reasoningTokens,
    t.cacheReadTokens,
    t.cacheWriteTokens,
    t.totalTokens,
    t.costKnownSteps ? t.cost : null,
    t.costKnownSteps,
    t.costUnavailableSteps,
  ]
}
