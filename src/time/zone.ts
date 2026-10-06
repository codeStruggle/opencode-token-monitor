/** Timezone arithmetic on top of Intl, without dependencies. All instants are UTC epoch milliseconds. */

export type CivilDate = { year: number; month: number; day: number }
export type CivilDateTime = CivilDate & { hour: number; minute: number; second: number; millisecond: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(tz, f)
  }
  return f
}

export function assertTimeZone(tz: string): string {
  try {
    formatter(tz)
    return tz
  } catch {
    throw new Error(`Unknown time zone: ${tz}`)
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

export function toCivil(epochMs: number, tz: string): CivilDateTime {
  const parts = formatter(tz).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
    millisecond: ((epochMs % 1000) + 1000) % 1000,
  }
}

/** Offset of tz from UTC at the given instant, in milliseconds. */
export function offsetAt(epochMs: number, tz: string): number {
  const c = toCivil(epochMs, tz)
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second, c.millisecond)
  return asUtc - epochMs
}

/**
 * Instant of a civil time in tz. For times skipped by a DST gap the result is the instant
 * after the gap; for repeated times (DST end) one valid instant is returned. Day, week and month
 * boundaries are midnights, which only a few zones shift.
 */
export function fromCivil(c: Partial<CivilDateTime> & CivilDate, tz: string): number {
  const utc = Date.UTC(c.year, c.month - 1, c.day, c.hour ?? 0, c.minute ?? 0, c.second ?? 0, c.millisecond ?? 0)
  const first = utc - offsetAt(utc, tz)
  const second = utc - offsetAt(first, tz)
  if (first === second) return first
  const matches = (t: number) => {
    const back = toCivil(t, tz)
    return Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, back.second, back.millisecond) === utc
  }
  const candidates = [first, second].filter(matches)
  return candidates.length ? Math.min(...candidates) : Math.max(first, second)
}

/** Calendar arithmetic on civil dates (no timezone involved). */
export function addDays(d: CivilDate, days: number): CivilDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days))
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

export function addMonths(d: CivilDate, months: number): CivilDate {
  const t = new Date(Date.UTC(d.year, d.month - 1 + months, 1))
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: 1 }
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(d: CivilDate): number {
  const w = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()
  return w === 0 ? 7 : w
}

export function startOfDay(epochMs: number, tz: string): number {
  const c = toCivil(epochMs, tz)
  return fromCivil({ year: c.year, month: c.month, day: c.day }, tz)
}

export function formatInZone(epochMs: number, tz: string): string {
  const c = toCivil(epochMs, tz)
  const off = offsetAt(epochMs, tz)
  const sign = off >= 0 ? "+" : "-"
  const abs = Math.abs(off) / 60000
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return (
    `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export function formatDate(d: CivilDate): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
}
