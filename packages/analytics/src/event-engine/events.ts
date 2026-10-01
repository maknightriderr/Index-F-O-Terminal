// ============================================================
// EVENT ENGINE — detectors and the chronological event log
// ============================================================
// One pass over a session, bar by bar. At bar i every detector reads bars
// [.., i] only, with ATR and liquidity pools from bars before i, and emits
// events stamped at bar i's close. The log is therefore append-only: running
// the same session with more bars appended never changes an earlier event
// (pinned by event-engine.test.ts).
//
// Events are measurements of what happened, in order. None of them is a
// trade; triggers (triggers.ts) read sequences of them.
// ============================================================

import type { MomentumBar } from '../momentum-break/index.js';
import { findSweep, isDisplacement, STRUCTURE_RULES } from '../structure-engine/index.js';
import { EVENT_RULES, type SeriesContext } from './context.js';
import type { Dir, EventLevel, EventType, MarketEvent } from './types.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const DIRS: Dir[] = ['BEARISH', 'BULLISH'];

/** Pool kinds treated as major levels for MAJOR_LEVEL_BREAK (previous day, equal highs/lows, week, month). */
const MAJOR_KINDS = new Set(['PREV_DAY_HIGH', 'PREV_DAY_LOW', 'EQUAL_HIGHS', 'EQUAL_LOWS', 'WEEK_HIGH', 'WEEK_LOW', 'MONTH_HIGH', 'MONTH_LOW']);
/** Events a FOLLOW_THROUGH can extend. */
const FOLLOWABLE = new Set<EventType>(['MAJOR_LEVEL_BREAK', 'ACCEPTANCE', 'COMPRESSION_BREAK', 'RANGE_EXPANSION', 'DISPLACEMENT', 'OPENING_RANGE_BREAK', 'RETEST_HOLD']);

interface OpenBreak {
  id: string;
  dir: Dir;
  level: EventLevel;
  index: number;
  state: 'PENDING' | 'ACCEPTED' | 'FAILED' | 'DONE';
  closesBeyond: number;
  /** Bar index of the acceptance or the failure. */
  resolvedAt: number;
  resolvedId: string | null;
}

interface OpenSweep {
  id: string;
  dir: Dir;
  level: EventLevel;
  index: number;
  extreme: number;
  done: boolean;
}

export interface SessionEventLog {
  session: string;
  s: number;
  start: number;
  end: number;
  events: MarketEvent[];
  /** Events confirmed at each bar index. */
  byIndex: Map<number, MarketEvent[]>;
  byId: Map<string, MarketEvent>;
}

const levelKey = (l: EventLevel) => `${l.kind}@${round2(l.price)}`;

/**
 * The chronological event log for session s. `endIndex` (default: the
 * session's last bar) lets a caller replay the session as it stood at an
 * earlier bar — the log up to any bar is identical either way.
 */
export function runSessionEvents(ctx: SeriesContext, s: number, endIndex?: number): SessionEventLog {
  const { bars } = ctx.series;
  const R = EVENT_RULES;
  const start = ctx.series.sessionStarts[s];
  const end = Math.min(endIndex ?? ctx.sessionEnd(s), ctx.sessionEnd(s));
  const session = ctx.series.sessionDates[s];
  const events: MarketEvent[] = [];
  const byIndex = new Map<number, MarketEvent[]>();
  const byId = new Map<string, MarketEvent>();

  const nearEmitted = new Set<string>();
  const crossed = new Set<string>(); // level keys already broken this session (per direction)
  const breaks: OpenBreak[] = [];
  const sweeps: OpenSweep[] = [];
  let box: { id: string; hi: number; lo: number; index: number; resolved: boolean } | null = null;
  let burstActive = false;
  const pullbackActive: Record<Dir, boolean> = { BULLISH: false, BEARISH: false };
  const accelActive: Record<Dir, boolean> = { BULLISH: false, BEARISH: false };
  const abnormalEmitted: Record<Dir, boolean> = { BULLISH: false, BEARISH: false };
  const orbEmitted: Record<Dir, boolean> = { BULLISH: false, BEARISH: false };
  let swingHigh: { price: number; k: number } | null = null;
  let swingLow: { price: number; k: number } | null = null;
  const sessionOpen = bars[start]?.open ?? NaN;
  const orEnd = (bars[start]?.time ?? 0) + R.openingRangeMinutes * 60 * 1000;

  for (let i = start; i <= end; i++) {
    const b = bars[i];
    const atr = ctx.atrAt(i);
    if (atr == null) continue;
    const closeAt = b.time + ctx.barMs;
    const here: MarketEvent[] = [];
    const emit = (type: EventType, direction: Dir | null, price: number, extra: { level?: EventLevel | null; parentId?: string | null; measures?: Record<string, number | null> } = {}): string => {
      const id = `${type}:${direction ?? 'NONE'}:${i}:${extra.level ? levelKey(extra.level) : ''}`;
      if (byId.has(id)) return id;
      const e: MarketEvent = { id, type, direction, barIndex: i, time: b.time, availableAt: closeAt, price: round2(price), level: extra.level ?? null, parentId: extra.parentId ?? null, measures: extra.measures };
      events.push(e);
      here.push(e);
      byId.set(id, e);
      return id;
    };
    const beyond = (dir: Dir, price: number, level: number, tol = 0) => (dir === 'BULLISH' ? price > level + tol : price < level - tol);
    const prev = i > start ? bars[i - 1] : null;

    // ---- Gap (the session's first bar) ----
    if (i === start && start > 0) {
      const prevClose = bars[start - 1].close;
      const gapAtr = (b.open - prevClose) / atr;
      if (Math.abs(gapAtr) >= R.gapAtr) {
        emit(gapAtr > 0 ? 'GAP_UP' : 'GAP_DOWN', gapAtr > 0 ? 'BULLISH' : 'BEARISH', b.open, { level: { kind: 'PREV_CLOSE', price: round2(prevClose) }, measures: { gapAtr: round3(gapAtr) } });
      }
    }

    const pa = ctx.poolsAt(s, i);
    const pools = pa?.pools ?? [];
    const research = ctx.researchPoolsAt(s, i);

    // ---- Radar: liquidity nearby ----
    for (const p of pools) {
      const key = `${p.kind}@${round2(p.price)}`;
      if (nearEmitted.has(key) || Math.abs(b.close - p.price) > R.liquidityNearAtr * atr) continue;
      nearEmitted.add(key);
      emit('LIQUIDITY_NEAR', null, p.price, { level: { kind: p.kind, price: round2(p.price), rank: p.rank }, measures: { distanceAtr: round3(Math.abs(b.close - p.price) / atr) } });
    }

    // ---- Sweep + reclaim (the structure engine's own findSweep) ----
    for (const dir of DIRS) {
      const found = findSweep(ctx.series, s, i, dir, STRUCTURE_RULES, (e) => ctx.poolsAt(s, e));
      if (!found) continue;
      const level: EventLevel = { kind: found.pool.kind, price: found.pool.price, rank: found.pool.rank };
      const sweepId = emit('SWEEP', dir, found.pool.price, { level, measures: { depthAtr: round3(found.depth / found.atr), bars: found.bars, extreme: round2(found.extreme) } });
      emit('RECLAIM', dir, b.close, { level, parentId: sweepId });
      if (found.pool.kind === 'OPENING_RANGE_HIGH' || found.pool.kind === 'OPENING_RANGE_LOW') emit('OPENING_RANGE_REJECTION', dir, b.close, { level, parentId: sweepId });
      sweeps.push({ id: sweepId, dir, level, index: i, extreme: found.extreme, done: false });
    }

    // ---- Open breaks: acceptance, failure, retest ----
    for (const br of breaks) {
      if (br.state === 'DONE' || br.index === i) continue;
      const inside = !beyond(br.dir, b.close, br.level.price);
      if (br.state === 'PENDING') {
        if (inside) {
          br.state = 'FAILED';
          br.resolvedAt = i;
          br.resolvedId = emit('FAILED_ACCEPTANCE', br.dir === 'BULLISH' ? 'BEARISH' : 'BULLISH', b.close, { level: br.level, parentId: br.id });
        } else if (++br.closesBeyond >= R.acceptanceBars) {
          br.state = 'ACCEPTED';
          br.resolvedAt = i;
          br.resolvedId = emit('ACCEPTANCE', br.dir, b.close, { level: br.level, parentId: br.id });
        }
        continue;
      }
      if (i - br.resolvedAt > R.retestWithinBars || i === br.resolvedAt) {
        if (i - br.resolvedAt > R.retestWithinBars) br.state = 'DONE';
        continue;
      }
      const tol = R.retestTolAtr * atr;
      if (br.state === 'ACCEPTED') {
        const touched = br.dir === 'BULLISH' ? b.low <= br.level.price + tol : b.high >= br.level.price - tol;
        if (!touched) continue;
        if (beyond(br.dir, b.close, br.level.price)) emit('RETEST_HOLD', br.dir, b.close, { level: br.level, parentId: br.resolvedId });
        else emit('RETEST_FAIL', br.dir === 'BULLISH' ? 'BEARISH' : 'BULLISH', b.close, { level: br.level, parentId: br.resolvedId });
        br.state = 'DONE';
      } else if (br.state === 'FAILED') {
        // A failed break that price returns to: rejected again → the failure is confirmed.
        const failDir: Dir = br.dir === 'BULLISH' ? 'BEARISH' : 'BULLISH';
        const touched = br.dir === 'BULLISH' ? b.high >= br.level.price - tol : b.low <= br.level.price + tol;
        if (!touched) continue;
        if (!beyond(br.dir, b.close, br.level.price)) emit('RETEST_FAIL', failDir, b.close, { level: br.level, parentId: br.resolvedId });
        br.state = 'DONE';
      }
    }

    // ---- Swept level retested and rejected again ----
    for (const sw of sweeps) {
      if (sw.done || sw.index === i) continue;
      if (i - sw.index > R.retestWithinBars) {
        sw.done = true;
        continue;
      }
      const bear = sw.dir === 'BEARISH';
      // A close beyond the sweep extreme ends it (the sweep failed).
      if (bear ? b.close > sw.extreme : b.close < sw.extreme) {
        sw.done = true;
        continue;
      }
      if (i - sw.index < 2) continue;
      const tol = R.retestTolAtr * atr;
      const touched = bear ? b.high >= sw.level.price - tol : b.low <= sw.level.price + tol;
      if (touched && (bear ? b.close < sw.level.price : b.close > sw.level.price)) {
        emit('RETEST_FAIL', sw.dir, b.close, { level: sw.level, parentId: sw.id });
        sw.done = true;
      }
    }

    // ---- Major level breaks (first close beyond) and the opening-range break ----
    const majors: EventLevel[] = [
      ...pools.filter((p) => MAJOR_KINDS.has(p.kind)).map((p) => ({ kind: p.kind, price: round2(p.price), rank: p.rank })),
      ...research.filter((p) => MAJOR_KINDS.has(p.kind)).map((p) => ({ kind: p.kind, price: round2(p.price), rank: p.rank })),
    ];
    for (const lv of majors) {
      const dir: Dir = lv.kind.endsWith('HIGH') || lv.kind === 'EQUAL_HIGHS' ? 'BULLISH' : 'BEARISH';
      const key = `${dir}:${levelKey(lv)}`;
      if (crossed.has(key) || !beyond(dir, b.close, lv.price, R.breakMinAtr * atr) || (prev && beyond(dir, prev.close, lv.price))) continue;
      crossed.add(key);
      const id = emit('MAJOR_LEVEL_BREAK', dir, lv.price, { level: lv, measures: { closeBeyondAtr: round3(Math.abs(b.close - lv.price) / atr) } });
      breaks.push({ id, dir, level: lv, index: i, state: 'PENDING', closesBeyond: 0, resolvedAt: i, resolvedId: null });
    }
    if (b.time >= orEnd) {
      let orHi = -Infinity;
      let orLo = Infinity;
      for (let j = start; j < i && bars[j].time < orEnd; j++) {
        orHi = Math.max(orHi, bars[j].high);
        orLo = Math.min(orLo, bars[j].low);
      }
      for (const dir of DIRS) {
        const level = dir === 'BULLISH' ? orHi : orLo;
        if (orbEmitted[dir] || !Number.isFinite(level) || !beyond(dir, b.close, level, R.breakMinAtr * atr)) continue;
        orbEmitted[dir] = true;
        const lv: EventLevel = { kind: dir === 'BULLISH' ? 'OPENING_RANGE_HIGH' : 'OPENING_RANGE_LOW', price: round2(level), rank: 4 };
        const id = emit('OPENING_RANGE_BREAK', dir, level, { level: lv });
        breaks.push({ id, dir, level: lv, index: i, state: 'PENDING', closesBeyond: 0, resolvedAt: i, resolvedId: null });
      }
    }

    // ---- Compression box and its break ----
    if (box && !box.resolved) {
      if (i - box.index > R.compressionExpiryBars) box.resolved = true;
      else if (b.close > box.hi + R.breakMinAtr * atr || b.close < box.lo - R.breakMinAtr * atr) {
        const dir: Dir = b.close > box.hi ? 'BULLISH' : 'BEARISH';
        emit('COMPRESSION_BREAK', dir, dir === 'BULLISH' ? box.hi : box.lo, { level: { kind: dir === 'BULLISH' ? 'COMPRESSION_HIGH' : 'COMPRESSION_LOW', price: round2(dir === 'BULLISH' ? box.hi : box.lo) }, parentId: box.id, measures: { boxHi: round2(box.hi), boxLo: round2(box.lo) } });
        box.resolved = true;
      }
    }
    if ((!box || box.resolved) && i - R.compressionBars + 1 >= start) {
      let hi = -Infinity;
      let lo = Infinity;
      let widest = 0;
      for (let k = i - R.compressionBars + 1; k <= i; k++) {
        hi = Math.max(hi, bars[k].high);
        lo = Math.min(lo, bars[k].low);
        widest = Math.max(widest, bars[k].high - bars[k].low);
      }
      if (hi - lo <= R.compressionRangeAtr * atr && widest <= R.compressionBarMaxAtr * atr && (!box || box.index < i - R.compressionBars + 1)) {
        const id = emit('COMPRESSION', null, b.close, { measures: { boxHi: round2(hi), boxLo: round2(lo), boxAtr: round3((hi - lo) / atr) } });
        box = { id, hi, lo, index: i, resolved: false };
      }
    }

    // ---- Expansion, displacement, volatility burst ----
    const range = b.high - b.low;
    const body = Math.abs(b.close - b.open);
    const closeEfficiency = range > 0 ? body / range : 0;
    let relVolume: number | null = null;
    if ((b.volume ?? 0) > 0 && i - 20 >= 0) {
      const vols = bars.slice(i - 20, i).map((x) => x.volume ?? 0).filter((v) => v > 0).sort((a, c) => a - c);
      if (vols.length >= 10) relVolume = round3((b.volume ?? 0) / vols[Math.floor(vols.length / 2)]);
    }
    if (range >= R.expansionBarAtr * atr) {
      emit('RANGE_EXPANSION', b.close >= b.open ? 'BULLISH' : 'BEARISH', b.close, { measures: { rangeAtr: round3(range / atr), bodyAtr: round3(body / atr), closeEfficiency: round3(closeEfficiency), relVolume } });
    }
    for (const dir of DIRS) {
      const d = isDisplacement(b, dir, atr, R.displacementMult, STRUCTURE_RULES);
      if (d) emit('DISPLACEMENT', dir, b.close, { measures: { bodyAtr: round3(d.bodyAtr), rangeAtr: round3(range / atr), closeEfficiency: round3(closeEfficiency), relVolume } });
    }
    if (i - R.burstBars + 1 >= start) {
      let trSum = 0;
      for (let k = i - R.burstBars + 1; k <= i; k++) {
        const pc = k > 0 ? bars[k - 1].close : bars[k].close;
        trSum += Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - pc), Math.abs(bars[k].low - pc));
      }
      const ratio = trSum / R.burstBars / atr;
      if (!burstActive && ratio >= R.burstRatio) {
        burstActive = true;
        const net = b.close - bars[i - R.burstBars + 1].open;
        emit('VOLATILITY_BURST', net >= 0 ? 'BULLISH' : 'BEARISH', b.close, { measures: { trRatio: round3(ratio), netAtr: round3(net / atr) } });
      } else if (burstActive && ratio < R.burstRearmRatio) burstActive = false;
    }

    // ---- Micro structure break (3-bar fractals confirmed before this bar) ----
    if (prev) {
      if (swingHigh && b.close > swingHigh.price && prev.close <= swingHigh.price) {
        emit('MICRO_BOS', 'BULLISH', swingHigh.price, { level: { kind: 'SWING_HIGH_3', price: round2(swingHigh.price) } });
        swingHigh = null;
      }
      if (swingLow && b.close < swingLow.price && prev.close >= swingLow.price) {
        emit('MICRO_BOS', 'BEARISH', swingLow.price, { level: { kind: 'SWING_LOW_3', price: round2(swingLow.price) } });
        swingLow = null;
      }
    }

    // ---- Follow-through of the previous bar's directional event ----
    if (prev) {
      for (const e of byIndex.get(i - 1) ?? []) {
        if (!FOLLOWABLE.has(e.type) || !e.direction) continue;
        if (e.direction === 'BULLISH' ? b.close > prev.high : b.close < prev.low) emit('FOLLOW_THROUGH', e.direction, b.close, { parentId: e.id });
      }
    }

    // ---- Trend pullback and acceleration (state from the bar before, never this one) ----
    const prevState = i > start ? ctx.stateAt(i - 1) : 'BALANCED';
    const lookFrom = Math.max(start, i - R.pullbackLookbackBars + 1);
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = lookFrom; k <= i; k++) {
      hh = Math.max(hh, bars[k].high);
      ll = Math.min(ll, bars[k].low);
    }
    if (b.high >= hh) pullbackActive.BULLISH = false;
    if (b.low <= ll) pullbackActive.BEARISH = false;
    if (prevState === 'TRENDING_UP' && !pullbackActive.BULLISH && b.close <= hh - R.pullbackAtr * atr && b.close >= ctx.ema[i] - R.pullbackEmaTolAtr * atr) {
      pullbackActive.BULLISH = true;
      emit('PULLBACK', 'BULLISH', b.close, { measures: { depthAtr: round3((hh - b.close) / atr) } });
    }
    if (prevState === 'TRENDING_DOWN' && !pullbackActive.BEARISH && b.close >= ll + R.pullbackAtr * atr && b.close <= ctx.ema[i] + R.pullbackEmaTolAtr * atr) {
      pullbackActive.BEARISH = true;
      emit('PULLBACK', 'BEARISH', b.close, { measures: { depthAtr: round3((b.close - ll) / atr) } });
    }
    if (i - R.accelerationBars >= start) {
      for (const dir of DIRS) {
        const sign = dir === 'BULLISH' ? 1 : -1;
        let mono = true;
        for (let k = i - R.accelerationBars + 1; k <= i; k++) if ((bars[k].close - bars[k - 1].close) * sign <= 0) mono = false;
        const moved = (b.close - bars[i - R.accelerationBars].close) * sign;
        const trending = prevState === (dir === 'BULLISH' ? 'TRENDING_UP' : 'TRENDING_DOWN');
        if (mono && trending && moved >= R.accelerationAtr * atr) {
          if (!accelActive[dir]) emit('TREND_ACCELERATION', dir, b.close, { measures: { movedAtr: round3(moved / atr) } });
          accelActive[dir] = true;
        } else if (!mono) accelActive[dir] = false;
      }
    }

    // ---- Abnormal directional move for the session ----
    const adr = ctx.adrAt(s);
    if (adr != null && adr > 0 && Number.isFinite(sessionOpen)) {
      const fromOpen = (b.close - sessionOpen) / adr;
      for (const dir of DIRS) {
        const moved = dir === 'BULLISH' ? fromOpen : -fromOpen;
        if (!abnormalEmitted[dir] && moved >= R.abnormalAdr) {
          abnormalEmitted[dir] = true;
          emit('ABNORMAL_MOVE', dir, b.close, { measures: { fromOpenAdr: round3(moved) } });
        }
      }
    }

    // A 3-bar fractal centred on i - 1 is confirmed by this bar's close; it can be broken from the next bar on.
    if (i - 2 >= start) {
      const m = bars[i - 1];
      if (m.high > bars[i - 2].high && m.high > b.high) swingHigh = { price: m.high, k: i - 1 };
      if (m.low < bars[i - 2].low && m.low < b.low) swingLow = { price: m.low, k: i - 1 };
    }

    if (here.length) byIndex.set(i, here);
  }

  return { session, s, start, end, events, byIndex, byId };
}

/** Events of a log up to and including bar i — what was knowable at bar i's close. */
export function eventsUpTo(log: SessionEventLog, i: number): MarketEvent[] {
  return log.events.filter((e) => e.barIndex <= i);
}

export function barRange(bars: readonly MomentumBar[], from: number, to: number): { hi: number; lo: number } {
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = from; k <= to; k++) {
    hi = Math.max(hi, bars[k].high);
    lo = Math.min(lo, bars[k].low);
  }
  return { hi, lo };
}
