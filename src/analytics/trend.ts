import type { Db } from "../db/driver.ts"
import type { TimeRange } from "../time/range.ts"
import { addDays, addMonths, formatDate, fromCivil, isoWeekday, toCivil, type CivilDate } from "../time/zone.ts"
import { loadSteps, type Filters } from "./data.ts"
import { envelope, type Envelope } from "./dto.ts"
import { addStep, emptyTotals, roundCost, type UsageTotals } from "./totals.ts"

export type Bucket = "day" | "week" | "month"

export type TrendPoint = { label: string; start: number; end: number; totals: UsageTotals }

export type TrendSeries = Envelope<"trend", { bucket: Bucket; points: TrendPoint[] }>

function bucketStart(epoch: number, bucket: Bucket, tz: string): CivilDate {
  const c = toCivil(epoch, tz)
  const d = { year: c.year, month: c.month, day: c.day }
  if (bucket === "day") return d
  if (bucket === "week") return addDays(d, 1 - isoWeekday(d))
  return { ...d, day: 1 }
}

const next = (d: CivilDate, bucket: Bucket): CivilDate => (bucket === "day" ? addDays(d, 1) : bucket === "week" ? addDays(d, 7) : addMonths(d, 1))

export function queryTrend(db: Db, range: TimeRange, bucket: Bucket, filters: Filters = {}): TrendSeries {
  const tz = range.timezone
  const steps = loadSteps(db, range, filters)
  const first = range.start > 0 ? range.start : (steps[0]?.ts ?? Date.now())
  const last = range.end < Number.MAX_SAFE_INTEGER ? range.end - 1 : Math.max(steps[steps.length - 1]?.ts ?? first, first)
  const points: TrendPoint[] = []
  const index = new Map<string, TrendPoint>()
  let cursor = bucketStart(first, bucket, tz)
  let guard = 0
  while (fromCivil(cursor, tz) <= last && guard++ < 5000) {
    const end = next(cursor, bucket)
    const p: TrendPoint = { label: formatDate(cursor), start: fromCivil(cursor, tz), end: fromCivil(end, tz), totals: emptyTotals() }
    points.push(p)
    index.set(p.label, p)
    cursor = end
  }
  for (const s of steps) {
    const p = index.get(formatDate(bucketStart(s.ts, bucket, tz)))
    if (p) addStep(p.totals, s)
  }
  return envelope("trend", range, { bucket, points: points.map((p) => ({ ...p, totals: roundCost(p.totals) })) }, [
    `Buckets are calendar ${bucket}s in ${tz}${bucket === "week" ? " starting Monday" : ""}; empty buckets are included.`,
  ])
}
