import {
  addDays,
  addMonths,
  assertTimeZone,
  formatInZone,
  fromCivil,
  isoWeekday,
  toCivil,
  type CivilDate,
} from "./zone.ts"

/** Half-open interval [start, end) in UTC epoch milliseconds. */
export type TimeRange = {
  start: number
  end: number
  timezone: string
  label: string
}

export const NATURAL_RANGES = ["today", "yesterday", "week", "last-week", "month", "last-month", "year", "all"] as const
export type NaturalRange = (typeof NATURAL_RANGES)[number]

export function isNaturalRange(v: string): v is NaturalRange {
  return (NATURAL_RANGES as readonly string[]).includes(v)
}

const civilToday = (now: number, tz: string): CivilDate => {
  const c = toCivil(now, tz)
  return { year: c.year, month: c.month, day: c.day }
}

const dayStart = (d: CivilDate, tz: string) => fromCivil(d, tz)

/** Calendar ranges use timezone-aware day boundaries (23h/25h days around DST), never fixed 24h. */
export function naturalRange(name: NaturalRange, now: number, tz: string): TimeRange {
  assertTimeZone(tz)
  const today = civilToday(now, tz)
  const mk = (from: CivilDate, to: CivilDate): TimeRange => ({ start: dayStart(from, tz), end: dayStart(to, tz), timezone: tz, label: name })
  switch (name) {
    case "today":
      return mk(today, addDays(today, 1))
    case "yesterday":
      return mk(addDays(today, -1), today)
    case "week": {
      const monday = addDays(today, 1 - isoWeekday(today))
      return mk(monday, addDays(monday, 7))
    }
    case "last-week": {
      const monday = addDays(today, 1 - isoWeekday(today))
      return mk(addDays(monday, -7), monday)
    }
    case "month": {
      const first = { ...today, day: 1 }
      return mk(first, addMonths(first, 1))
    }
    case "last-month": {
      const first = { ...today, day: 1 }
      return mk(addMonths(first, -1), first)
    }
    case "year":
      return mk({ year: today.year, month: 1, day: 1 }, { year: today.year + 1, month: 1, day: 1 })
    case "all":
      return { start: 0, end: Number.MAX_SAFE_INTEGER, timezone: tz, label: "all" }
  }
}

const DURATION_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }

/** Rolling window: an absolute duration ending now, e.g. 1h, 24h, 7d, 30d. */
export function rollingRange(spec: string, now: number, tz: string): TimeRange {
  assertTimeZone(tz)
  const m = /^(\d+)([mhdw])$/.exec(spec.trim())
  if (!m) throw new Error(`Invalid --last value "${spec}". Use e.g. 30m, 1h, 24h, 7d, 4w.`)
  const ms = Number(m[1]) * DURATION_UNITS[m[2]!]!
  if (ms <= 0) throw new Error(`--last must be positive`)
  return { start: now - ms, end: now, timezone: tz, label: `last ${spec}` }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

export type ParsedBoundary = { instant: number; dateOnly: boolean; civil?: CivilDate }

/**
 * Accepts YYYY-MM-DD, YYYY-MM-DDTHH:mm[:ss] (interpreted in tz) or a full ISO 8601 timestamp
 * with Z / ±hh:mm (interpreted with its own offset).
 */
export function parseBoundary(text: string, tz: string): ParsedBoundary {
  const t = text.trim()
  const d = DATE_ONLY.exec(t)
  if (d) {
    const civil = { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) }
    validateCivil(civil, t)
    return { instant: fromCivil(civil, tz), dateOnly: true, civil }
  }
  const l = LOCAL_DATETIME.exec(t)
  if (l) {
    const civil = { year: Number(l[1]), month: Number(l[2]), day: Number(l[3]) }
    validateCivil(civil, t)
    return {
      instant: fromCivil({ ...civil, hour: Number(l[4]), minute: Number(l[5]), second: Number(l[6] ?? 0) }, tz),
      dateOnly: false,
    }
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    const v = Date.parse(t)
    if (!Number.isNaN(v)) return { instant: v, dateOnly: false }
  }
  throw new Error(`Invalid date/time "${text}". Use YYYY-MM-DD, YYYY-MM-DDTHH:mm or an ISO timestamp with offset.`)
}

function validateCivil(c: CivilDate, text: string): void {
  const t = new Date(Date.UTC(c.year, c.month - 1, c.day))
  if (t.getUTCFullYear() !== c.year || t.getUTCMonth() + 1 !== c.month || t.getUTCDate() !== c.day) {
    throw new Error(`Invalid calendar date "${text}"`)
  }
}

/**
 * --from: date-only means 00:00 of that day in tz.
 * --to: date-only INCLUDES that whole day (resolved to the next day's 00:00, exclusive);
 *       a date-time is the exclusive end itself.
 */
export function customRange(from: string | undefined, to: string | undefined, now: number, tz: string): TimeRange {
  assertTimeZone(tz)
  const start = from ? parseBoundary(from, tz).instant : 0
  let end = now
  if (to) {
    const b = parseBoundary(to, tz)
    end = b.dateOnly && b.civil ? fromCivil(addDays(b.civil, 1), tz) : b.instant
  }
  if (end <= start) throw new Error("Empty range: --to must be after --from")
  return { start, end, timezone: tz, label: `${from ?? "beginning"} .. ${to ?? "now"}` }
}

export type RangeOptions = { range?: string; last?: string; from?: string; to?: string }

export function resolveRange(opts: RangeOptions, now: number, tz: string, fallback: NaturalRange = "all"): TimeRange {
  const chosen = [opts.range ? 1 : 0, opts.last ? 1 : 0, opts.from || opts.to ? 1 : 0].reduce((a, b) => a + b, 0)
  if (chosen > 1) throw new Error("Use only one of: a named range, --last, or --from/--to")
  if (opts.last) return rollingRange(opts.last, now, tz)
  if (opts.from || opts.to) return customRange(opts.from, opts.to, now, tz)
  const name = opts.range ?? fallback
  if (!isNaturalRange(name)) throw new Error(`Unknown range "${name}". Use one of: ${NATURAL_RANGES.join(", ")}`)
  return naturalRange(name, now, tz)
}

/** Parses "A..B" range expressions used by compare: a natural name, a duration (7d) or from..to. */
export function parseRangeExpression(expr: string, now: number, tz: string): TimeRange {
  if (isNaturalRange(expr)) return naturalRange(expr, now, tz)
  if (/^\d+[mhdw]$/.test(expr)) return rollingRange(expr, now, tz)
  const [from, to] = expr.split("..")
  if (from !== undefined && to !== undefined) return customRange(from || undefined, to || undefined, now, tz)
  throw new Error(`Invalid range expression "${expr}". Use a name (week), a duration (7d) or FROM..TO`)
}

export function describeRange(r: TimeRange): { start: number; end: number; startIso: string; endIso: string; timezone: string; label: string } {
  const endIso = r.end >= Number.MAX_SAFE_INTEGER ? "∞" : formatInZone(r.end, r.timezone)
  return { start: r.start, end: r.end, startIso: formatInZone(r.start, r.timezone), endIso, timezone: r.timezone, label: r.label }
}
