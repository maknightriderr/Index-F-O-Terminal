// In-memory counters behind the daily funnel line (decision-summary.ts): how each index's option-chain refresh is
// doing, and how the engine's scans were split by status (armed vs blocked) today. Counts only; decides nothing.
// Reset when the IST day changes or the process restarts (the log line says since when).
const IST_MS = 19_800_000;
const dayOf = (t: number) => Math.floor((t + IST_MS) / 86_400_000);

interface ChainHealth { ok: number; failed: number; lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null }
let day = -1, since = 0;
const chains = new Map<string, ChainHealth>();
const scans = new Map<string, number>();

function roll(now: number): void {
  if (dayOf(now) === day) return;
  day = dayOf(now); since = now; chains.clear(); scans.clear();
}

export function noteChainRefresh(index: string, error: string | null, now = Date.now()): void {
  roll(now);
  const h = chains.get(index) ?? { ok: 0, failed: 0, lastOkAt: null, lastError: null, lastErrorAt: null };
  if (error == null) { h.ok++; h.lastOkAt = now; } else { h.failed++; h.lastError = error.slice(0, 160); h.lastErrorAt = now; }
  chains.set(index, h);
}

export function noteScanStatus(status: string, now = Date.now()): void {
  roll(now);
  scans.set(status, (scans.get(status) ?? 0) + 1);
}

export function healthCounters(now = Date.now()) {
  roll(now);
  const total = [...scans.values()].reduce((a, b) => a + b, 0);
  const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
  return {
    countedSince: iso(since),
    chains: Object.fromEntries([...chains].map(([k, h]) => [k, { ok: h.ok, failed: h.failed, lastOkAt: iso(h.lastOkAt), minutesSinceOk: h.lastOkAt == null ? null : Math.round((now - h.lastOkAt) / 60_000), lastError: h.lastError, lastErrorAt: iso(h.lastErrorAt) }])),
    scans: { total, sharePct: Object.fromEntries([...scans].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, total ? Math.round((n / total) * 1000) / 10 : 0])) },
  };
}

export function resetHealthCounters(): void { day = -1; since = 0; chains.clear(); scans.clear(); }
