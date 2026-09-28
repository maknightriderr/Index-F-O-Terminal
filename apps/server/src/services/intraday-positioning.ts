// ============================================================
// INTRADAY POSITIONING WINDOW (flag INTRADAY_POSITIONING)
// ============================================================
// Every positioning input the bias engine votes on — the futures OI build-up,
// OI-PCR, chain-wide option OI flow, and the OI-shift magnitude — was measured
// against YESTERDAY'S CLOSE. On a day that rallies and then reverses, those
// reads stay bullish for hours after the chart has turned: on 28 Sep CRUDEOIL
// fell ~270 points (16:30-19:30 IST) while positioning still voted with the
// morning's rally, and confidence (the average of the chart and positioning
// sources) sat at 52-54 against a 75 floor.
//
// The market-state capture already writes a 15-minute snapshot of the futures
// leg (futures_snapshots), the PCR aggregates (pcr_history) and the chain
// (oi_snapshots). This module turns the change over the last N minutes of
// those snapshots into the same votes, using the same classifiers and bands
// the day-level reads use:
//
//   futures   Δprice% and ΔOI -> classifyFuturesOI -> banded on Δprice% with
//             the existing FUTURES_MOVE_ENTER/HOLD bands (as the day vote is)
//   PCR       ΔOI-PCR -> banded on INTRADAY_PCR_DELTA_ENTER/HOLD (new,
//             untested defaults; same sign convention as the day vote: more
//             puts = bullish)
//   flow      per leg ΔOI and Δltp% -> classifyOptionOI -> |ΔOI|-weighted
//             bullish/bearish skew -> the existing ±0.15/±0.08 bands
//   OI shift  the window ΔOI% of the futures contract
//
// Each input falls back to its day-level vote on its own when its data is
// thin: fewer than INTRADAY_POSITIONING_MIN_SNAPSHOTS snapshots in the window,
// or the newest one older than INTRADAY_POSITIONING_MAX_AGE_MIN. Which
// baseline each input actually used is returned so it can be recorded.
//
// Pure: no I/O, no clock. The caller loads the rows and passes `now`.
// ============================================================

import { classifyFuturesOI, classifyOptionOI, getOIDescription } from '@fno/analytics';
import type { OIInterpretation } from '@fno/shared';
import { bandVote, type Vote } from './vote-bands.js';

/** Which reference a positioning input was measured against. */
export type PositioningBaseline = `INTRADAY_${number}M` | 'PREV_CLOSE';

export interface FuturesSnapshotPoint {
  /** epoch ms */
  time: number;
  price: number;
  oi: number;
}

export interface PcrSnapshotPoint {
  time: number;
  oiPcr: number;
}

export interface OptionLegSnapshotPoint {
  time: number;
  strike: number;
  optionType: 'CE' | 'PE';
  oi: number;
  ltp: number;
}

export interface Band {
  enter: number;
  hold: number;
}

export interface IntradayPositioningConfig {
  /** The decision instant, epoch ms. Rows after it are ignored (no look-ahead). */
  now: number;
  windowMin: number;
  minSnapshots: number;
  maxAgeMin: number;
  /** Reused: FUTURES_MOVE_ENTER_PCT / FUTURES_MOVE_HOLD_PCT. */
  futuresBand: Band;
  /** New: INTRADAY_PCR_DELTA_ENTER / INTRADAY_PCR_DELTA_HOLD. */
  pcrBand: Band;
  /** Reused: OPTION_OI_FLOW_MIN_SKEW / OPTION_OI_FLOW_HOLD_SKEW. */
  optionFlowBand: Band;
  /** Reused: the chain's own noise band for a leg's price read (IV_PRESSURE_MIN_PCT). */
  optionPriceNoisePct: number;
}

export interface WindowSufficiency {
  sufficient: boolean;
  /** Distinct snapshot instants inside the window. */
  snapshots: number;
  /** Minutes since the newest snapshot inside the window; null when there is none. */
  newestAgeMin: number | null;
  /** Why the window was not used; null when it was. */
  reason: string | null;
}

interface PrevVotes {
  futuresOi?: Vote;
  pcr?: Vote;
  optionOiFlow?: Vote;
}

export interface FuturesWindowRead {
  sufficiency: WindowSufficiency;
  /** Null = fall back to the day-level vote. */
  vote: Vote | null;
  interpretation: OIInterpretation | null;
  priceChangePct: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
}

export interface PcrWindowRead {
  sufficiency: WindowSufficiency;
  vote: Vote | null;
  pcrChange: number | null;
}

export interface OptionFlowWindowRead {
  sufficiency: WindowSufficiency;
  vote: Vote | null;
  netSkew: number | null;
  dominant: OIInterpretation | null;
  dominantShare: number | null;
  legsCompared: number;
}

export interface IntradayPositioningRead {
  windowLabel: PositioningBaseline;
  futures: FuturesWindowRead;
  pcr: PcrWindowRead;
  optionFlow: OptionFlowWindowRead;
}

export const intradayBaselineLabel = (windowMin: number): PositioningBaseline => `INTRADAY_${Math.round(windowMin)}M`;

const MINUTE_MS = 60_000;

/** Distinct instants inside [now - window, now], and whether they are enough and fresh enough. */
export function assessWindow(times: number[], cfg: Pick<IntradayPositioningConfig, 'now' | 'windowMin' | 'minSnapshots' | 'maxAgeMin'>): WindowSufficiency {
  const from = cfg.now - cfg.windowMin * MINUTE_MS;
  const inWindow = [...new Set(times.filter((t) => Number.isFinite(t) && t >= from && t <= cfg.now))].sort((a, b) => a - b);
  const newest = inWindow[inWindow.length - 1];
  const newestAgeMin = newest != null ? Math.round(((cfg.now - newest) / MINUTE_MS) * 10) / 10 : null;
  let reason: string | null = null;
  if (inWindow.length < cfg.minSnapshots) {
    reason = `${inWindow.length} snapshot(s) in the last ${cfg.windowMin} min, ${cfg.minSnapshots} needed`;
  } else if (newestAgeMin == null || newestAgeMin > cfg.maxAgeMin) {
    reason = `newest snapshot is ${newestAgeMin} min old, limit ${cfg.maxAgeMin}`;
  }
  return { sufficient: reason == null, snapshots: inWindow.length, newestAgeMin, reason };
}

function windowPoints<T extends { time: number }>(points: T[], cfg: IntradayPositioningConfig): T[] {
  const from = cfg.now - cfg.windowMin * MINUTE_MS;
  return points.filter((p) => Number.isFinite(p.time) && p.time >= from && p.time <= cfg.now).sort((a, b) => a.time - b.time);
}

export function intradayFuturesRead(points: FuturesSnapshotPoint[], prev: Vote | undefined, cfg: IntradayPositioningConfig): FuturesWindowRead {
  const valid = points.filter((p) => p.price > 0 && Number.isFinite(p.oi));
  const sufficiency = assessWindow(valid.map((p) => p.time), cfg);
  const none: FuturesWindowRead = { sufficiency, vote: null, interpretation: null, priceChangePct: null, oiChange: null, oiChangePct: null };
  if (!sufficiency.sufficient) return none;
  const pts = windowPoints(valid, cfg);
  const base = pts[0];
  const latest = pts[pts.length - 1];
  const priceChangePct = ((latest.price - base.price) / base.price) * 100;
  const oiChange = latest.oi - base.oi;
  const oiChangePct = base.oi > 0 ? (oiChange / base.oi) * 100 : 0;
  const interpretation = classifyFuturesOI({ priceChange: priceChangePct, oiChange });
  // Same shape as the day-level futures vote: NEUTRAL (OI or price not
  // moving) is no vote; otherwise the side is the banded price move.
  const vote: Vote =
    interpretation === 'NEUTRAL'
      ? 0
      : bandVote(priceChangePct, prev, cfg.futuresBand.enter, cfg.futuresBand.hold, -cfg.futuresBand.enter, -cfg.futuresBand.hold);
  return { sufficiency, vote, interpretation, priceChangePct, oiChange, oiChangePct };
}

export function intradayPcrRead(points: PcrSnapshotPoint[], prev: Vote | undefined, cfg: IntradayPositioningConfig): PcrWindowRead {
  const valid = points.filter((p) => Number.isFinite(p.oiPcr) && p.oiPcr > 0);
  const sufficiency = assessWindow(valid.map((p) => p.time), cfg);
  if (!sufficiency.sufficient) return { sufficiency, vote: null, pcrChange: null };
  const pts = windowPoints(valid, cfg);
  const pcrChange = pts[pts.length - 1].oiPcr - pts[0].oiPcr;
  const vote = bandVote(pcrChange, prev, cfg.pcrBand.enter, cfg.pcrBand.hold, -cfg.pcrBand.enter, -cfg.pcrBand.hold);
  return { sufficiency, vote, pcrChange };
}

export function intradayOptionFlowRead(points: OptionLegSnapshotPoint[], prev: Vote | undefined, cfg: IntradayPositioningConfig): OptionFlowWindowRead {
  const valid = points.filter((p) => Number.isFinite(p.oi) && Number.isFinite(p.ltp));
  const sufficiency = assessWindow(valid.map((p) => p.time), cfg);
  const none: OptionFlowWindowRead = { sufficiency, vote: null, netSkew: null, dominant: null, dominantShare: null, legsCompared: 0 };
  if (!sufficiency.sufficient) return none;

  const pts = windowPoints(valid, cfg);
  const baseTime = pts[0].time;
  const latestTime = pts[pts.length - 1].time;
  const legKey = (p: OptionLegSnapshotPoint) => `${p.strike}:${p.optionType}`;
  const baseByLeg = new Map(pts.filter((p) => p.time === baseTime).map((p) => [legKey(p), p]));

  // The same aggregation the day-level flow uses: each leg's interpretation
  // from its own OI and premium change, weighted by how much OI moved.
  let bull = 0;
  let bear = 0;
  let legsCompared = 0;
  const byType = new Map<OIInterpretation, number>();
  for (const latest of pts.filter((p) => p.time === latestTime)) {
    const base = baseByLeg.get(legKey(latest));
    if (!base || !(base.ltp > 0)) continue;
    legsCompared++;
    const oiChange = latest.oi - base.oi;
    if (oiChange === 0) continue;
    const ltpChangePct = ((latest.ltp - base.ltp) / base.ltp) * 100;
    const interpretation = classifyOptionOI({ priceChange: ltpChangePct, oiChange }, latest.optionType, cfg.optionPriceNoisePct);
    const weight = Math.abs(oiChange);
    const { implication } = getOIDescription(interpretation);
    if (implication === 'BULLISH') bull += weight;
    else if (implication === 'BEARISH') bear += weight;
    byType.set(interpretation, (byType.get(interpretation) ?? 0) + weight);
  }

  if (legsCompared === 0) {
    return { ...none, sufficiency: { ...sufficiency, sufficient: false, reason: 'no leg present in both the first and the latest snapshot of the window' } };
  }

  const total = bull + bear;
  const netSkew = total > 0 ? (bull - bear) / total : 0;
  let dominant: OIInterpretation | null = null;
  let dominantWeight = 0;
  for (const [type, weight] of byType) {
    if (weight > dominantWeight) {
      dominant = type;
      dominantWeight = weight;
    }
  }
  const vote = bandVote(netSkew, prev, cfg.optionFlowBand.enter, cfg.optionFlowBand.hold, -cfg.optionFlowBand.enter, -cfg.optionFlowBand.hold);
  return { sufficiency, vote, netSkew, dominant, dominantShare: total > 0 ? dominantWeight / total : null, legsCompared };
}

export function evaluateIntradayPositioning(
  input: { futures: FuturesSnapshotPoint[]; pcr: PcrSnapshotPoint[]; legs: OptionLegSnapshotPoint[]; prev: PrevVotes | null | undefined },
  cfg: IntradayPositioningConfig
): IntradayPositioningRead {
  return {
    windowLabel: intradayBaselineLabel(cfg.windowMin),
    futures: intradayFuturesRead(input.futures, input.prev?.futuresOi, cfg),
    pcr: intradayPcrRead(input.pcr, input.prev?.pcr, cfg),
    optionFlow: intradayOptionFlowRead(input.legs, input.prev?.optionOiFlow, cfg),
  };
}

export interface PositioningBaselines {
  futuresOi: PositioningBaseline;
  pcr: PositioningBaseline;
  optionOiFlow: PositioningBaseline;
  oiShifts: PositioningBaseline;
}

export interface ResolvedPositioning {
  futuresOiVote: Vote;
  pcrVote: Vote;
  optionOiFlowVote: Vote;
  /** The futures OI change % the OI-shift score is scaled by. */
  futuresChangeOiPct: number;
  baselines: PositioningBaselines;
}

/**
 * Picks, per input, the intraday vote when its window was sufficient and the
 * day-level vote otherwise. `intraday` null (flag off, POSITIONAL mode, or
 * the read failed) returns the day-level votes untouched.
 */
export function resolvePositioningVotes(
  day: { futuresOiVote: Vote; pcrVote: Vote; optionOiFlowVote: Vote; futuresChangeOiPct: number },
  intraday: IntradayPositioningRead | null
): ResolvedPositioning {
  const prevClose: PositioningBaseline = 'PREV_CLOSE';
  if (!intraday) {
    return { ...day, baselines: { futuresOi: prevClose, pcr: prevClose, optionOiFlow: prevClose, oiShifts: prevClose } };
  }
  const label = intraday.windowLabel;
  const futuresUsed = intraday.futures.vote != null;
  const pcrUsed = intraday.pcr.vote != null;
  const flowUsed = intraday.optionFlow.vote != null;
  const shiftUsed = futuresUsed && intraday.futures.oiChangePct != null;
  return {
    futuresOiVote: futuresUsed ? intraday.futures.vote! : day.futuresOiVote,
    pcrVote: pcrUsed ? intraday.pcr.vote! : day.pcrVote,
    optionOiFlowVote: flowUsed ? intraday.optionFlow.vote! : day.optionOiFlowVote,
    futuresChangeOiPct: shiftUsed ? intraday.futures.oiChangePct! : day.futuresChangeOiPct,
    baselines: {
      futuresOi: futuresUsed ? label : prevClose,
      pcr: pcrUsed ? label : prevClose,
      optionOiFlow: flowUsed ? label : prevClose,
      oiShifts: shiftUsed ? label : prevClose,
    },
  };
}
