// ============================================================
// TOKEN-BUCKET RATE LIMITER
// ============================================================
// Paces a category of calls to at most `ratePerSecond`, queuing
// anything over that instead of letting it fire immediately. Exists
// because Angel One's SmartAPI enforces its own per-endpoint rate
// limits server-side (a 403 "Access denied because of exceeding
// access rate" when tripped) — with this app now running several
// independent background jobs (Market Scanner, alerts, institutional-
// flow scanner, trade-setup monitor, pattern scanner) plus normal
// browser polling, nothing previously coordinated how often any of
// them actually hit the broker. Confirmed live: their combined load
// was tripping this on roughly half of all requests (quotes,
// historical candles, and Greeks simultaneously) — this queue is the
// single choke point every outgoing request passes through now,
// regardless of which feature initiated it.
//
// A per-second pace alone still let historical candles draw 1,756
// rate-limit rejections in one session (16 Sep): 2/s sustained is 120
// requests a minute, and the broker's window is evidently tighter than
// that over a minute. So a limiter can also cap requests per rolling
// minute, and callers pause it after a rejection so queued requests back
// off together instead of each retry immediately tripping the limit again.
// ============================================================

interface QueueItem {
  resolve: () => void;
}

const MINUTE_MS = 60_000;

export class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private readonly perMinute: number | null;
  private tokens: number;
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private grantedAt: number[] = []; // grant times within the last minute (only tracked when perMinute is set)
  private pausedUntil = 0;

  constructor(ratePerSecond: number, perMinute?: number) {
    this.maxTokens = ratePerSecond;
    this.tokens = ratePerSecond;
    this.refillIntervalMs = 1000 / ratePerSecond;
    this.perMinute = perMinute ?? null;
  }

  /** Hold every request in this category for at least `ms` — call after the broker rejects one for rate. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tokens = Math.min(this.maxTokens, this.tokens + 1);
      this.drain();
    }, this.refillIntervalMs);
    // Deliberately NOT unref'd: confirmed live (a synthetic test) that
    // unref'ing this timer lets Node consider the event loop empty and
    // exit early whenever nothing else happens to be keeping it alive —
    // abandoning any still-queued acquire() callers permanently instead
    // of ever draining them. In the real server other handles (the HTTP
    // listener, DB/Redis connections) always keep the process alive
    // anyway, so this timer being ref'd costs nothing in practice.
  }

  private canGrant(now: number): boolean {
    if (now < this.pausedUntil || this.tokens <= 0) return false;
    if (this.perMinute != null) {
      while (this.grantedAt.length > 0 && now - this.grantedAt[0] >= MINUTE_MS) this.grantedAt.shift();
      if (this.grantedAt.length >= this.perMinute) return false;
    }
    return true;
  }

  private grant(now: number): void {
    this.tokens--;
    if (this.perMinute != null) this.grantedAt.push(now);
  }

  private drain(): void {
    const now = Date.now();
    while (this.queue.length > 0 && this.canGrant(now)) {
      this.grant(now);
      this.queue.shift()!.resolve();
    }
  }

  /** Resolves once a slot is free. Await this immediately before making the actual call it's guarding. */
  async acquire(): Promise<void> {
    this.ensureTimer();
    const now = Date.now();
    // Only skip the queue when nobody is already waiting — otherwise a new
    // caller could jump ahead of requests queued during a pause.
    if (this.queue.length === 0 && this.canGrant(now)) {
      this.grant(now);
      return;
    }
    return new Promise((resolve) => {
      this.queue.push({ resolve });
    });
  }
}
