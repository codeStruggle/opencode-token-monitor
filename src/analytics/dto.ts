import { describeRange, type TimeRange } from "../time/range.ts"
import type { UsageTotals } from "./totals.ts"

/**
 * JSON contract version (semver). Minor: fields added. Major: fields removed/renamed or semantics changed.
 * Consumers must ignore unknown fields.
 */
export const JSON_SCHEMA_VERSION = "1.0.0"

export type RangeInfo = ReturnType<typeof describeRange>

export type Precision = {
  /** Token counters and cost come from OpenCode's own accounting (EXACT as reported by the host). */
  usage: "exact"
  /** Cost is OpenCode's list-price computation, not a provider bill. */
  cost: "host_computed_list_price"
}

export const PRECISION: Precision = { usage: "exact", cost: "host_computed_list_price" }

export type Envelope<K extends string, T> = {
  schemaVersion: string
  kind: K
  generatedAt: string
  range: RangeInfo
  precision: Precision
  notes: string[]
} & T

export function envelope<K extends string, T extends object>(kind: K, range: TimeRange, body: T, notes: string[] = []): Envelope<K, T> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    kind,
    generatedAt: new Date().toISOString(),
    range: describeRange(range),
    precision: PRECISION,
    notes,
    ...body,
  }
}

export type GroupKey = Record<string, string | null>

export type UsageGroup = { key: GroupKey; totals: UsageTotals }

export type UsageSummary = Envelope<
  "usage",
  {
    groupBy: string[]
    totals: UsageTotals
    groups: UsageGroup[]
    reconciliation: { stepsSeenByPlugin: number; stepsSeenByImport: number; importMismatches: number }
  }
>
