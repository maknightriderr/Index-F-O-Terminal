// Data quality of a decision's inputs, judged against the decision bar T on
// the exchange session calendar (getLatestSessionWindow — never the server's
// local time zone). Pure: every function here takes its instants as input.

import type { Exchange } from '../types/index.js';
import type { InputQuality, InputQualityStatus, SnapshotDataQuality, SnapshotInputKey } from '../types/decision-record.js';
import { getLatestSessionWindow } from './index.js';

/**
 * T — the close of the newest `barMs` bar of the exchange session that has
 * CLOSED by `at`. Bars are counted from the session open. Before the first
 * bar of a session has closed, T is the previous session's last bar close.
 * Null when no session opened in the past two weeks.
 */
export function decisionBarCloseAt(exchange: Exchange, at: number, barMs: number): number | null {
  let w = getLatestSessionWindow(exchange, at);
  if (!w) return null;
  if (Math.min(at, w.close) < w.open + barMs) {
    w = getLatestSessionWindow(exchange, w.open - 1);
    if (!w) return null;
  }
  const end = Math.min(at, w.close);
  return w.open + Math.floor((end - w.open) / barMs) * barMs;
}

/** ageMs = decisionBarTime − asOf (negative when the input is as of after T); null when missing. */
export function ageMsOf(asOf: number | null, decisionBarTime: number): number | null {
  return asOf == null || !Number.isFinite(asOf) ? null : decisionBarTime - asOf;
}

/** The status of an input from its asOf, T and tolerance. */
export function inputStatusOf(asOf: number | null, decisionBarTime: number, toleranceMs: number): InputQualityStatus {
  const age = ageMsOf(asOf, decisionBarTime);
  if (age == null) return 'MISSING';
  if (age < 0) return 'FUTURE_INPUT';
  return age > toleranceMs ? 'STALE_INPUT' : 'OK';
}

export function inputQuality(args: { asOf: number | null; decisionBarTime: number; source: string; toleranceMs: number }): InputQuality {
  const { asOf, decisionBarTime, source, toleranceMs } = args;
  return { asOf, decisionBarTime, ageMs: ageMsOf(asOf, decisionBarTime), source, status: inputStatusOf(asOf, decisionBarTime, toleranceMs), toleranceMs };
}

/**
 * Summary of every input's quality. `notApplicable` inputs (e.g. 5m bars in
 * 15m mode, corporate actions for an index) are not counted against the
 * snapshot. Keys are visited in a fixed order (deterministic reasons).
 */
export function summarizeDataQuality(inputs: Record<SnapshotInputKey, InputQuality>, notApplicable: readonly SnapshotInputKey[] = []): SnapshotDataQuality {
  const keys = (Object.keys(inputs) as SnapshotInputKey[]).sort();
  const reasons: string[] = [];
  const flags = { anyFuture: false, anyStale: false, anyMissing: false };
  for (const k of keys) {
    if (notApplicable.includes(k)) continue;
    const q = inputs[k];
    if (q.status === 'OK') continue;
    if (q.status === 'FUTURE_INPUT') flags.anyFuture = true;
    if (q.status === 'STALE_INPUT') flags.anyStale = true;
    if (q.status === 'MISSING') flags.anyMissing = true;
    reasons.push(q.status === 'MISSING' ? `${k}: MISSING (${q.source})` : `${k}: ${q.status} (asOf ${q.ageMs! < 0 ? `${-q.ageMs!} ms after` : `${q.ageMs} ms before`} T, tolerance ${q.toleranceMs} ms, ${q.source})`);
  }
  return { inputs, degraded: reasons.length > 0, reasons, flags };
}
