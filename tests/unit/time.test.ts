import { describe, expect, test } from "bun:test"
import { customRange, naturalRange, parseBoundary, parseRangeExpression, resolveRange, rollingRange } from "../../src/time/range.ts"
import { formatInZone, fromCivil, offsetAt } from "../../src/time/zone.ts"

const BERLIN = "Europe/Berlin"
const H = 3_600_000
const iso = (t: number) => new Date(t).toISOString()

describe("zone arithmetic", () => {
  test("Berlin offsets around DST", () => {
    expect(offsetAt(Date.parse("2026-03-29T00:59:00Z"), BERLIN)).toBe(1 * H)
    expect(offsetAt(Date.parse("2026-03-29T01:00:00Z"), BERLIN)).toBe(2 * H)
    expect(offsetAt(Date.parse("2026-10-25T00:59:00Z"), BERLIN)).toBe(2 * H)
    expect(offsetAt(Date.parse("2026-10-25T01:00:00Z"), BERLIN)).toBe(1 * H)
  })

  test("civil midnight to instant", () => {
    expect(iso(fromCivil({ year: 2026, month: 3, day: 29 }, BERLIN))).toBe("2026-03-28T23:00:00.000Z")
    expect(iso(fromCivil({ year: 2026, month: 3, day: 30 }, BERLIN))).toBe("2026-03-29T22:00:00.000Z")
  })

  test("a skipped civil time resolves to the instant after the gap", () => {
    const t = fromCivil({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN)
    expect(formatInZone(t, BERLIN)).toBe("2026-03-29T03:30:00+02:00")
  })
})

describe("natural ranges", () => {
  test("DST start day has 23 hours", () => {
    const now = Date.parse("2026-03-29T12:00:00Z")
    const r = naturalRange("today", now, BERLIN)
    expect(iso(r.start)).toBe("2026-03-28T23:00:00.000Z")
    expect(r.end - r.start).toBe(23 * H)
  })

  test("DST end day has 25 hours", () => {
    const now = Date.parse("2026-10-25T12:00:00Z")
    const r = naturalRange("today", now, BERLIN)
    expect(iso(r.start)).toBe("2026-10-24T22:00:00.000Z")
    expect(r.end - r.start).toBe(25 * H)
  })

  test("yesterday across the DST boundary", () => {
    const r = naturalRange("yesterday", Date.parse("2026-03-30T08:00:00Z"), BERLIN)
    expect(r.end - r.start).toBe(23 * H)
  })

  test("weeks start on Monday", () => {
    // Sunday 2026-10-11 23:30 Berlin is still in the week of Monday 2026-10-05.
    const now = Date.parse("2026-10-11T21:30:00Z")
    const r = naturalRange("week", now, BERLIN)
    expect(formatInZone(r.start, BERLIN)).toBe("2026-10-05T00:00:00+02:00")
    expect(formatInZone(r.end, BERLIN)).toBe("2026-10-12T00:00:00+02:00")
    const lw = naturalRange("last-week", now, BERLIN)
    expect(lw.end).toBe(r.start)
    expect(formatInZone(lw.start, BERLIN)).toBe("2026-09-28T00:00:00+02:00")
  })

  test("week containing DST end is 7 days + 1 hour", () => {
    const r = naturalRange("week", Date.parse("2026-10-21T10:00:00Z"), BERLIN)
    expect(r.end - r.start).toBe(7 * 24 * H + H)
  })

  test("month end and leap February", () => {
    const r = naturalRange("month", Date.parse("2028-02-29T22:30:00Z"), BERLIN) // 23:30 Berlin, Feb 29
    expect(formatInZone(r.start, BERLIN)).toBe("2028-02-01T00:00:00+01:00")
    expect(formatInZone(r.end, BERLIN)).toBe("2028-03-01T00:00:00+01:00")
  })

  test("last-month across the year boundary", () => {
    const r = naturalRange("last-month", Date.parse("2027-01-01T00:30:00Z"), BERLIN) // 01:30 Berlin, Jan 1
    expect(formatInZone(r.start, BERLIN)).toBe("2026-12-01T00:00:00+01:00")
    expect(formatInZone(r.end, BERLIN)).toBe("2027-01-01T00:00:00+01:00")
  })

  test("the same instant is a different day in another zone", () => {
    const now = Date.parse("2026-10-06T23:30:00Z")
    expect(formatInZone(naturalRange("today", now, BERLIN).start, BERLIN)).toBe("2026-10-07T00:00:00+02:00")
    expect(formatInZone(naturalRange("today", now, "UTC").start, "UTC")).toBe("2026-10-06T00:00:00+00:00")
  })
})

describe("rolling and custom ranges", () => {
  test("--last is an absolute duration, unaffected by DST", () => {
    const now = Date.parse("2026-03-29T12:00:00Z")
    const r = rollingRange("24h", now, BERLIN)
    expect(r.end - r.start).toBe(24 * H)
    expect(rollingRange("7d", now, BERLIN).end - rollingRange("7d", now, BERLIN).start).toBe(7 * 24 * H)
    expect(() => rollingRange("7x", now, BERLIN)).toThrow()
  })

  test("date-only --to includes that whole day", () => {
    const r = customRange("2026-10-01", "2026-10-06", Date.now(), BERLIN)
    expect(formatInZone(r.start, BERLIN)).toBe("2026-10-01T00:00:00+02:00")
    expect(formatInZone(r.end, BERLIN)).toBe("2026-10-07T00:00:00+02:00")
  })

  test("date-time --to is the exclusive end itself", () => {
    const r = customRange("2026-10-01T08:00", "2026-10-01T09:30", Date.now(), BERLIN)
    expect(r.end - r.start).toBe(1.5 * H)
  })

  test("timestamps with an offset use their own offset", () => {
    expect(parseBoundary("2026-10-01T08:00:00Z", BERLIN).instant).toBe(Date.parse("2026-10-01T08:00:00Z"))
    expect(parseBoundary("2026-10-01T08:00:00+05:00", BERLIN).instant).toBe(Date.parse("2026-10-01T03:00:00Z"))
  })

  test("invalid input is rejected", () => {
    expect(() => parseBoundary("2026-02-30", BERLIN)).toThrow()
    expect(() => parseBoundary("yesterday-ish", BERLIN)).toThrow()
    expect(() => customRange("2026-10-02", "2026-10-01T00:00", Date.now(), BERLIN)).toThrow()
    expect(() => naturalRange("today", Date.now(), "Mars/Base")).toThrow()
  })

  test("only one range form at a time", () => {
    expect(() => resolveRange({ range: "today", last: "1h" }, Date.now(), "UTC")).toThrow()
    expect(resolveRange({}, Date.now(), "UTC").label).toBe("all")
  })

  test("compare range expressions", () => {
    const now = Date.parse("2026-10-06T10:00:00Z")
    expect(parseRangeExpression("week", now, "UTC").label).toBe("week")
    expect(parseRangeExpression("7d", now, "UTC").end).toBe(now)
    const r = parseRangeExpression("2026-09-01..2026-09-07", now, "UTC")
    expect(r.end - r.start).toBe(7 * 24 * H)
  })
})

describe("half-open boundaries", () => {
  test("an event exactly at end belongs to the next range", () => {
    const today = naturalRange("today", Date.parse("2026-10-06T10:00:00Z"), BERLIN)
    const tomorrowStart = today.end
    const inToday = (t: number) => t >= today.start && t < today.end
    expect(inToday(today.start)).toBe(true)
    expect(inToday(tomorrowStart)).toBe(false)
    expect(inToday(tomorrowStart - 1)).toBe(true)
  })
})
