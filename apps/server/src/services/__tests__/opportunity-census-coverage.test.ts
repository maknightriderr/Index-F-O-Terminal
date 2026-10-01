// ============================================================
// OPPORTUNITY CENSUS — which sessions get censused, and capture rate
// ============================================================
// Seen on the first deploy (30 Sep 2026): the census classified that day's
// NSE/BSE sessions although setup_events only started recording after the
// close, so all 15 opportunities read NEVER_DETECTED. A session is censused
// only when it is over and was recorded from its open.
// ============================================================

import { describe, it, expect } from 'vitest';
import { pendingSessions, captureRate, classifyWindow, RECORDING_START_MS } from '../opportunity-census-job.js';

const ist = (s: string) => Date.parse(`${s}+05:30`);
const none = new Set<string>();

describe('pendingSessions', () => {
  it('skips the sessions that opened before recording started (30 Sep)', () => {
    expect(pendingSessions('NSE', ist('2026-09-30T23:00:00'), none)).toEqual([]);
    expect(pendingSessions('MCX', ist('2026-09-30T23:59:00'), none)).toEqual([]);
  });

  it('waits for the close plus the last bar, from the session window', () => {
    expect(pendingSessions('NSE', ist('2026-10-01T15:32:00'), none)).toEqual([]);
    expect(pendingSessions('NSE', ist('2026-10-01T15:36:00'), none)).toEqual(['2026-10-01']);
    // MCX closes 23:30 in US summer time and 23:55 in winter.
    expect(pendingSessions('MCX', ist('2026-10-01T23:36:00'), none)).toEqual(['2026-10-01']);
    expect(pendingSessions('MCX', ist('2026-11-04T23:40:00'), none)).not.toContain('2026-11-04');
    expect(pendingSessions('MCX', ist('2026-11-05T00:01:00'), none)).toContain('2026-11-04');
  });

  it('a pass after midnight still censuses the previous session', () => {
    expect(pendingSessions('MCX', ist('2026-10-02T00:20:00'), none)).toContain('2026-10-01');
  });

  it('never repeats a censused session', () => {
    expect(pendingSessions('NSE', ist('2026-10-01T18:00:00'), new Set(['2026-10-01']))).toEqual([]);
  });

  it('recording started at the PR #12 deploy', () => {
    expect(new Date(RECORDING_START_MS).toISOString()).toBe('2026-09-30T13:20:52.000Z');
  });
});

describe('captureRate', () => {
  it('counts traded opportunities only', () => {
    expect(captureRate(0, 0)).toBeNull();
    expect(captureRate(4, 1)).toBe(0.25);
  });
  it('leaves data-gap opportunities out of the denominator', () => {
    expect(captureRate(6, 1, 2)).toBe(0.25);
    expect(captureRate(3, 0, 3)).toBeNull();
  });
});

describe('classifyWindow', () => {
  const none = { traded: false, detected: false, late: false };
  it('an unmatched window is NEVER_DETECTED only when the data could have detected it', () => {
    expect(classifyWindow({ ...none, sessionCoverage: 'COVERED', inGap: false })).toBe('NEVER_DETECTED');
    expect(classifyWindow({ ...none, sessionCoverage: 'PARTIAL', inGap: false })).toBe('NEVER_DETECTED');
    expect(classifyWindow({ ...none, sessionCoverage: 'PARTIAL', inGap: true })).toBe('DATA_GAP');
    expect(classifyWindow({ ...none, sessionCoverage: 'UNCOVERED', inGap: false })).toBe('DATA_GAP');
    expect(classifyWindow({ ...none, sessionCoverage: 'DATA_GAP', inGap: false })).toBe('DATA_GAP');
  });
  it('a match always wins: traded, then rejected, then late', () => {
    expect(classifyWindow({ traded: true, detected: true, late: false, sessionCoverage: 'UNCOVERED', inGap: true })).toBe('TRADED');
    expect(classifyWindow({ traded: false, detected: true, late: false, sessionCoverage: 'COVERED', inGap: false })).toBe('DETECTED_BUT_REJECTED');
    expect(classifyWindow({ traded: false, detected: false, late: true, sessionCoverage: 'COVERED', inGap: false })).toBe('DETECTED_LATE');
  });
});
