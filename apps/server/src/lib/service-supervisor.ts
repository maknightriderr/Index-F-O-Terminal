// ============================================================
// SERVICE SUPERVISOR (Phase 6)
// ============================================================
// Replaces the fire-and-forget start*() calls in index.ts. Every background
// service registers {name, critical, startupTimeoutMs, heartbeatIntervalMs}
// and is started, watched and stopped here.
//
// TIMER services (the 18 start*() jobs) keep their own code: the supervisor
// captures every setTimeout / setInterval a service creates while its start
// runs — and while one of its captured callbacks runs (a delayed first tick
// that then sets its interval) — so it can
//   * heartbeat: each captured callback that completes is a sign of life
//     (lastSuccessAt); one that throws or rejects is a failure;
//   * stop: clear every captured timer at shutdown;
//   * restart: clear them and re-create the intervals (same callback, same
//     period) after a backoff — no change to the service module.
// COMPONENT services (the signal engine, the setup lifecycle) have no timers
// of their own: their code reports serviceHeartbeat / serviceFailure.
//
// States: STARTING → RUNNING ⇄ DEGRADED → FAILED → RESTARTING → RUNNING …
// STOPPED after stopAll. A critical service not RUNNING (or STARTING) makes
// /api/health DEGRADED.
// ============================================================

/** A captured callback may resolve to this after reporting its own failure (serviceFailure): no heartbeat for that run. */
export const TICK_FAILED: unique symbol = Symbol('TICK_FAILED');

export type ServiceState = 'STARTING' | 'RUNNING' | 'DEGRADED' | 'FAILED' | 'RESTARTING' | 'STOPPED';

export interface ServiceSpec {
  name: string;
  critical: boolean;
  /** start() must return (resolve) within this. */
  startupTimeoutMs: number;
  /**
   * Expected time between signs of life. 0 = derived from the service's own
   * captured intervals (the longest one); still 0 → no heartbeat check.
   */
  heartbeatIntervalMs: number;
  kind: 'TIMER' | 'COMPONENT';
  /** Awaited before start() (outside timer capture) — e.g. the schema, the Redis rehydration. */
  ready?: () => Promise<unknown>;
  start: () => unknown;
  /** Heartbeats are only expected while this holds (e.g. an exchange is in session). Default: always. */
  activeWhen?: (now: number) => boolean;
  /** Why this registration exists (extra registrations must say). */
  note?: string;
}

export interface ServiceStatus {
  name: string;
  critical: boolean;
  kind: 'TIMER' | 'COMPONENT';
  state: ServiceState;
  startedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  failureCount: number;
  consecutiveFailures: number;
  restarts: number;
  heartbeatIntervalMs: number;
  timers: number;
  note: string | null;
}

interface CapturedTimer {
  kind: 'interval' | 'timeout';
  fn: (...a: any[]) => unknown;
  ms: number;
  args: any[];
  handle: any;
}

interface Entry {
  spec: ServiceSpec;
  status: ServiceStatus;
  timers: CapturedTimer[];
  restartTimer: any;
}

export interface Clock {
  now: () => number;
  setInterval: (fn: (...a: any[]) => void, ms: number, ...args: any[]) => any;
  clearInterval: (h: any) => void;
  setTimeout: (fn: (...a: any[]) => void, ms: number, ...args: any[]) => any;
  clearTimeout: (h: any) => void;
}

const realClock = (): Clock => ({
  now: () => Date.now(),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});

export class ServiceSupervisor {
  private entries = new Map<string, Entry>();
  private evalTimer: any = null;
  private stopped = false;
  private readonly clock: Clock;
  readonly failureThreshold: number;
  readonly maxRestarts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  private log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };

  constructor(opts: {
    clock?: Clock;
    failureThreshold?: number;
    maxRestarts?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    log?: ServiceSupervisor['log'];
  } = {}) {
    this.clock = opts.clock ?? realClock();
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 5_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 5 * 60_000;
    this.log = opts.log ?? { info() {}, warn() {}, error() {} };
  }

  setLogger(log: ServiceSupervisor['log']): void {
    this.log = log;
  }

  register(spec: ServiceSpec): void {
    if (this.entries.has(spec.name)) throw new Error(`Service ${spec.name} registered twice`);
    this.entries.set(spec.name, {
      spec,
      timers: [],
      restartTimer: null,
      status: {
        name: spec.name, critical: spec.critical, kind: spec.kind, state: 'STARTING', startedAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null,
        failureCount: 0, consecutiveFailures: 0, restarts: 0, heartbeatIntervalMs: spec.heartbeatIntervalMs, timers: 0, note: spec.note ?? null,
      },
    });
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  // ---------------- timer capture ----------------

  /** Runs fn with the global timer functions recording into this service. */
  private captureInto<T>(e: Entry, fn: () => T): T {
    const g = globalThis as any;
    const prev = { setInterval: g.setInterval, setTimeout: g.setTimeout };
    g.setInterval = (cb: (...a: any[]) => unknown, ms?: number, ...args: any[]) => this.addTimer(e, 'interval', cb, ms ?? 0, args);
    g.setTimeout = (cb: (...a: any[]) => unknown, ms?: number, ...args: any[]) => this.addTimer(e, 'timeout', cb, ms ?? 0, args);
    try {
      return fn();
    } finally {
      g.setInterval = prev.setInterval;
      g.setTimeout = prev.setTimeout;
    }
  }

  private addTimer(e: Entry, kind: 'interval' | 'timeout', fn: (...a: any[]) => unknown, ms: number, args: any[]): any {
    const t: CapturedTimer = { kind, fn, ms, args, handle: null };
    const run = () => {
      if (kind === 'timeout') e.timers = e.timers.filter((x) => x !== t);
      this.invoke(e, () => fn(...args));
    };
    t.handle = kind === 'interval' ? this.clock.setInterval(run, ms) : this.clock.setTimeout(run, ms);
    e.timers.push(t);
    e.status.timers = e.timers.length;
    if (kind === 'interval' && e.spec.heartbeatIntervalMs === 0) e.status.heartbeatIntervalMs = Math.max(e.status.heartbeatIntervalMs, ms);
    return t.handle;
  }

  /** A captured callback: run (capturing any timers it creates), heartbeat on completion, failure on throw / reject. */
  private invoke(e: Entry, fn: () => unknown): void {
    if (this.stopped || e.status.state === 'STOPPED') return;
    let out: unknown;
    try {
      out = this.captureInto(e, fn);
    } catch (err) {
      this.failure(e.spec.name, err);
      return;
    }
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      (out as Promise<unknown>).then(
        (v) => {
          if (v !== TICK_FAILED) this.heartbeat(e.spec.name);
        },
        (err) => this.failure(e.spec.name, err)
      );
    } else {
      this.heartbeat(e.spec.name);
    }
  }

  private clearTimers(e: Entry): void {
    for (const t of e.timers) (t.kind === 'interval' ? this.clock.clearInterval : this.clock.clearTimeout)(t.handle);
  }

  // ---------------- lifecycle ----------------

  async start(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Unknown service ${name}`);
    e.status.state = 'STARTING';
    try {
      if (e.spec.ready) await e.spec.ready();
      if (this.stopped) return;
      const started = this.captureInto(e, () => e.spec.start());
      const timeout = new Promise<'TIMEOUT'>((r) => {
        const h = this.clock.setTimeout(() => r('TIMEOUT'), e.spec.startupTimeoutMs);
        (h as any)?.unref?.();
      });
      const res = await Promise.race([Promise.resolve(started).then(() => 'OK' as const), timeout]);
      if (res === 'TIMEOUT') throw new Error(`start did not complete within ${e.spec.startupTimeoutMs} ms`);
      e.status.state = 'RUNNING';
      e.status.startedAt = this.clock.now();
      this.log.info({ service: name, critical: e.spec.critical, timers: e.timers.length }, 'Service started');
    } catch (err: any) {
      e.status.lastError = err?.message ?? String(err);
      e.status.lastFailureAt = this.clock.now();
      e.status.failureCount++;
      this.toFailed(e, `startup: ${e.status.lastError}`);
    }
  }

  /** Starts every registered service (in registration order; each awaits only its own `ready`). */
  async startAll(evaluateEveryMs = 30_000): Promise<void> {
    this.stopped = false;
    if (!this.evalTimer) {
      this.evalTimer = this.clock.setInterval(() => this.evaluate(), evaluateEveryMs);
      this.evalTimer?.unref?.();
    }
    await Promise.all([...this.entries.keys()].map((n) => this.start(n)));
  }

  /** A sign of life from a service (its work completed). */
  heartbeat(name: string): void {
    const e = this.entries.get(name);
    if (!e || e.status.state === 'STOPPED') return;
    e.status.lastSuccessAt = this.clock.now();
    e.status.consecutiveFailures = 0;
    if (e.status.state === 'DEGRADED' || (e.status.state === 'STARTING' && e.spec.kind === 'COMPONENT')) e.status.state = 'RUNNING';
  }

  /** A failure reported by (or observed in) a service. */
  failure(name: string, err: unknown): void {
    const e = this.entries.get(name);
    if (!e || e.status.state === 'STOPPED') return;
    e.status.failureCount++;
    e.status.consecutiveFailures++;
    e.status.lastFailureAt = this.clock.now();
    e.status.lastError = (err as any)?.message ?? String(err);
    if (e.status.consecutiveFailures >= this.failureThreshold) this.toFailed(e, `${e.status.consecutiveFailures} consecutive failures: ${e.status.lastError}`);
    else if (e.status.state === 'RUNNING') e.status.state = 'DEGRADED';
  }

  private toFailed(e: Entry, why: string): void {
    if (e.status.state === 'RESTARTING' || e.status.state === 'STOPPED') return;
    e.status.state = 'FAILED';
    this.log.error({ service: e.spec.name, critical: e.spec.critical, why }, 'Service FAILED');
    this.scheduleRestart(e);
  }

  /** Controlled restart with exponential backoff; gives up (stays FAILED) after maxRestarts. */
  private scheduleRestart(e: Entry): void {
    if (this.stopped) return;
    if (e.status.restarts >= this.maxRestarts) {
      this.log.error({ service: e.spec.name, restarts: e.status.restarts }, 'Service restart limit reached — left FAILED');
      return;
    }
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** e.status.restarts);
    e.status.state = 'RESTARTING';
    e.restartTimer = this.clock.setTimeout(() => this.restartNow(e), delay);
    e.restartTimer?.unref?.();
  }

  private restartNow(e: Entry): void {
    if (this.stopped) return;
    e.status.restarts++;
    // Only the periodic schedule is replaced; pending one-shot timeouts (which
    // may belong to a library called from a callback) are left to fire.
    const intervals = e.timers.filter((t) => t.kind === 'interval');
    for (const t of intervals) this.clock.clearInterval(t.handle);
    e.timers = e.timers.filter((t) => t.kind !== 'interval');
    if (e.spec.kind === 'TIMER') {
      if (intervals.length > 0) for (const t of intervals) this.addTimer(e, 'interval', t.fn, t.ms, t.args);
      else {
        // Nothing periodic was captured: start it again.
        try {
          this.captureInto(e, () => e.spec.start());
        } catch (err) {
          this.failure(e.spec.name, err);
          return;
        }
      }
    }
    e.status.consecutiveFailures = 0;
    e.status.state = 'RUNNING';
    e.status.startedAt = this.clock.now();
    this.log.warn({ service: e.spec.name, restarts: e.status.restarts }, 'Service restarted');
  }

  /** Missed heartbeats: > 2 intervals → DEGRADED, > 4 → FAILED (restart). Only while the service is expected to be active. */
  evaluate(): void {
    const now = this.clock.now();
    for (const e of this.entries.values()) {
      const s = e.status;
      if (s.state !== 'RUNNING' && s.state !== 'DEGRADED') continue;
      const hb = s.heartbeatIntervalMs;
      if (!(hb > 0)) continue;
      if (e.spec.activeWhen && !e.spec.activeWhen(now)) continue;
      const since = now - (s.lastSuccessAt ?? s.startedAt ?? now);
      if (since > 4 * hb) {
        s.lastError = `no heartbeat for ${Math.round(since / 1000)} s`;
        this.toFailed(e, s.lastError);
      } else if (since > 2 * hb && s.state === 'RUNNING') {
        s.state = 'DEGRADED';
        s.lastError = `heartbeat late (${Math.round(since / 1000)} s)`;
      }
    }
  }

  /** Graceful shutdown, step 1: every service timer and the supervisor's own. */
  stopAll(): void {
    this.stopped = true;
    if (this.evalTimer) this.clock.clearInterval(this.evalTimer);
    this.evalTimer = null;
    for (const e of this.entries.values()) {
      this.clearTimers(e);
      e.timers = [];
      if (e.restartTimer) this.clock.clearTimeout(e.restartTimer);
      e.status.timers = 0;
      e.status.state = 'STOPPED';
    }
  }

  snapshot(): ServiceStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status, timers: e.timers.length }));
  }

  /** Critical services that are not RUNNING / STARTING — /api/health is DEGRADED while any exists. */
  degradedCritical(): ServiceStatus[] {
    return this.snapshot().filter((s) => s.critical && s.state !== 'RUNNING' && s.state !== 'STARTING');
  }
}

/** The process's supervisor. */
export const serviceSupervisor = new ServiceSupervisor();

/** Report a sign of life from a COMPONENT (or a TIMER service's own explicit check). No-op for an unregistered name. */
export function serviceHeartbeat(name: string): void {
  serviceSupervisor.heartbeat(name);
}

/** Report a failure. No-op for an unregistered name. */
export function serviceFailure(name: string, err: unknown): void {
  serviceSupervisor.failure(name, err);
}
