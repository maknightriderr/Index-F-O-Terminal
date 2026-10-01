// ============================================================
// DATA QUALITY — was there valid data before calling anything a miss?
// ============================================================
// A session is judged on two things: the bars (present, missing, stale) and
// the recorder (was the process that writes setup_events up for the whole
// session). Only a COVERED session can turn an objective opportunity into
// NEVER_DETECTED; anything else is a data problem, not a signal failure.
//
//   UNCOVERED  no bars, or recording covered < 10% of the session
//   DATA_GAP   > 25% of bars missing or stale
//   PARTIAL    any missing bar, > 2 stale bars, or a recording gap
//   COVERED    otherwise
//
// Recording gaps come from recorder boots: a boot inside the session means
// the previous process stopped around then. The gap is taken as the 5
// minutes before the boot through 2 minutes after it (deploy downtime plus
// warm-up — an assumption, stated, not measured).
// ============================================================

export type SessionCoverage = 'COVERED' | 'PARTIAL' | 'UNCOVERED' | 'DATA_GAP';

export const RECORDING_GAP_BEFORE_BOOT_MS = 5 * 60 * 1000;
export const RECORDING_WARMUP_MS = 2 * 60 * 1000;

export interface CoverageReport {
  coverage: SessionCoverage;
  sessionStart: number;
  sessionEnd: number;
  expectedBars: number;
  presentBars: number;
  missingBars: number;
  staleBars: number;
  /** First and last instants the recorder was up inside the session (null when not tracked or never up). */
  recordingStart: number | null;
  recordingEnd: number | null;
  /** Recording gaps inside the session. */
  gaps: Array<{ from: number; to: number }>;
}

/**
 * `boots`: recorder boot instants (epoch ms), any order. Null = recording not
 * tracked (research on stored bars): only the bars are judged.
 */
export function classifySessionCoverage(args: {
  sessionOpen: number;
  sessionClose: number;
  barMs: number;
  bars: ReadonlyArray<{ time: number; open: number; high: number; low: number; close: number }>;
  boots: readonly number[] | null;
}): CoverageReport {
  const { sessionOpen: open, sessionClose: close, barMs } = args;
  const expected = Math.max(0, Math.floor((close - open) / barMs));
  const inSession = args.bars.filter((b) => b.time >= open && b.time < close).sort((a, b) => a.time - b.time);
  const slots = new Set(inSession.map((b) => Math.floor((b.time - open) / barMs)));
  const present = slots.size;
  const missing = Math.max(0, expected - present);
  let stale = 0;
  for (let k = 1; k < inSession.length; k++) {
    const a = inSession[k - 1];
    const b = inSession[k];
    if (a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close) stale++;
  }

  let gaps: Array<{ from: number; to: number }> = [];
  let recordingStart: number | null = null;
  let recordingEnd: number | null = null;
  let recordedShare = 1;
  if (args.boots) {
    const boots = [...args.boots].sort((a, b) => a - b);
    const firstUp = boots.find((t) => t <= open);
    const insideBoots = boots.filter((t) => t > open && t < close);
    if (firstUp == null && insideBoots.length === 0) {
      gaps = [{ from: open, to: close }];
    } else {
      if (firstUp == null) gaps.push({ from: open, to: Math.min(close, insideBoots[0] + RECORDING_WARMUP_MS) });
      for (const t of firstUp == null ? insideBoots.slice(1) : insideBoots) gaps.push({ from: Math.max(open, t - RECORDING_GAP_BEFORE_BOOT_MS), to: Math.min(close, t + RECORDING_WARMUP_MS) });
    }
    gaps = mergeIntervals(gaps);
    const gapMs = gaps.reduce((acc, g) => acc + (g.to - g.from), 0);
    recordedShare = close > open ? 1 - gapMs / (close - open) : 0;
    if (recordedShare > 0) {
      recordingStart = gaps.length && gaps[0].from <= open ? gaps[0].to : open;
      const last = gaps[gaps.length - 1];
      recordingEnd = last && last.to >= close ? last.from : close;
    }
  }

  let coverage: SessionCoverage;
  if (present === 0 || recordedShare < 0.1) coverage = 'UNCOVERED';
  else if (expected > 0 && (missing + stale) / expected > 0.25) coverage = 'DATA_GAP';
  else if (missing > 0 || stale > 2 || gaps.length > 0) coverage = 'PARTIAL';
  else coverage = 'COVERED';

  return { coverage, sessionStart: open, sessionEnd: close, expectedBars: expected, presentBars: present, missingBars: missing, staleBars: stale, recordingStart, recordingEnd, gaps };
}

/** True when an opportunity starting at `time` (± one bar) falls inside a recording gap: it cannot be NEVER_DETECTED. */
export function inRecordingGap(time: number, gaps: ReadonlyArray<{ from: number; to: number }>, barMs: number): boolean {
  return gaps.some((g) => time >= g.from - barMs && time <= g.to + barMs);
}

function mergeIntervals(xs: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = xs.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ ...x });
  }
  return out;
}
