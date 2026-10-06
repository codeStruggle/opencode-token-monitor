import type { NormalizedEvent } from "../core/events.ts"
import type { Repository } from "../db/repository.ts"

export type QueueOptions = {
  flushIntervalMs?: number
  maxBuffered?: number
  onError?: (error: unknown, dropped: number) => void
}

/**
 * Hooks only enqueue; batches are written in one transaction off the hot path.
 * A failing batch is retried once (e.g. SQLITE_BUSY) and then dropped with a diagnostic,
 * so a broken database can never stall or crash the host.
 */
export class WriteQueue {
  private buffer: NormalizedEvent[] = []
  private retry: NormalizedEvent[] | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  readonly stats = { written: 0, dropped: 0, batches: 0, failures: 0 }

  constructor(
    private readonly repo: Repository,
    private readonly opts: QueueOptions = {},
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.opts.flushIntervalMs ?? 1000)
    const t = this.timer as unknown as { unref?: () => void }
    t.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  push(events: NormalizedEvent[]): void {
    const max = this.opts.maxBuffered ?? 10_000
    for (const e of events) {
      if (this.buffer.length >= max) {
        this.stats.dropped++
        continue
      }
      this.buffer.push(e)
    }
  }

  get pending(): number {
    return this.buffer.length + (this.retry?.length ?? 0)
  }

  flush(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      if (this.retry) {
        const batch = this.retry
        this.retry = null
        if (!this.write(batch)) {
          this.stats.dropped += batch.length
          this.opts.onError?.(new Error("batch dropped after retry"), batch.length)
        }
      }
      if (!this.buffer.length) return
      const batch = this.buffer
      this.buffer = []
      if (!this.write(batch)) this.retry = batch
    } finally {
      this.flushing = false
    }
  }

  private write(batch: NormalizedEvent[]): boolean {
    try {
      this.repo.db.transaction(() => {
        for (const e of batch) this.repo.apply(e, "plugin")
      })
      this.stats.written += batch.length
      this.stats.batches++
      return true
    } catch (error) {
      this.stats.failures++
      this.opts.onError?.(error, 0)
      return false
    }
  }
}
