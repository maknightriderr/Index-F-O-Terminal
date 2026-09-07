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
// ============================================================

interface QueueItem {
  resolve: () => void;
}

export class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private tokens: number;
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ratePerSecond: number) {
    this.maxTokens = ratePerSecond;
    this.tokens = ratePerSecond;
    this.refillIntervalMs = 1000 / ratePerSecond;
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

  private drain(): void {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens--;
      this.queue.shift()!.resolve();
    }
  }

  /** Resolves once a slot is free. Await this immediately before making the actual call it's guarding. */
  async acquire(): Promise<void> {
    this.ensureTimer();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push({ resolve });
    });
  }
}
