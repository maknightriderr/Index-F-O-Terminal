// ============================================================
// HUMAN TA (HTA-1.0) — a chart reader that works like a discretionary trader (owner, 13 Nov)
// ============================================================
// Independent of every other strategy in this repository: it reads only raw data (5-minute and 15-minute bars, daily
// bars, the option chain with OI and Greeks, the futures' OI read) and does all of its own calculations:
//   1. multi-timeframe trend      daily, 15-minute, 5-minute (EMA 20 / 50 and swing structure)
//   2. support / resistance       swing pivots of the 15-minute and daily charts, previous day high / low, today's
//                                 opening range, clustered into levels with a touch count
//   3. trendlines                 the line through the last two rising swing lows (falling swing highs)
//   4. patterns                   level bounce, range breakout, double bottom / top, bull / bear flag, trendline bounce
//   5. candlesticks               engulfing, hammer / shooting star, strong (marubozu-like) bar
//   6. volume                     relative volume of the signal bar against the last 20 bars
//   7. open interest              PCR, call / put OI walls, OI added since ~15 minutes ago, the futures' OI read
//   8. the option itself          for each liquid strike in the admission delta band, the premium at target and at
//                                 stop from its own delta, gamma and theta; the strike with the best option R:R wins
// Every piece adds or removes points; a setup that scores HTA_RULES.minScore or more, has a structural stop, a target
// at least minRr away and a liquid option is a trade. The score breakdown is kept as evidence.
// Pure: no I/O. Bullish logic is written once; bearish reuses it on the price-mirrored input.
// ============================================================

export const HTA_VERSION = 'HTA-1.0';
export const HTA_STRATEGY_ID = 'HTA_HUMAN_TA_V1';

export const HTA_RULES = Object.freeze({
  minScore: 65,
  minRr: 1.5,
  maxRiskAtr15: 1.5,
  levelClusterAtr: 0.3,
  touchAtr: 0.25,
  boxMaxAtr15: 1.2,
  boxBars: [12, 10, 8, 6] as readonly number[],
  breakoutRvol: 1.5,
  minOptionRr: 1.2,
  maxSpreadPct: 2,
  minAbsDelta: 0.45,
  maxAbsDelta: 0.65,
  holdHours: 1.5,
  noEntryAfterExpiryDayMin: 13 * 60,
});

export interface HtaBar { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface HtaLeg { ltp: number; bid: number; ask: number; oi: number; iv: number; delta: number; gamma: number; theta: number }
export interface HtaChain { at: number; spot: number; expiry: string; daysToExpiry: number; strikes: ReadonlyArray<{ strike: number; call: HtaLeg | null; put: HtaLeg | null }> }
export interface HtaInput {
  symbol: string;
  now: number;
  sessionOpen: number;
  sessionClose: number;
  /** Closed 5-minute bars, oldest first (previous sessions included). */
  bars5: readonly HtaBar[];
  /** Closed 15-minute bars, oldest first (several sessions). */
  bars15: readonly HtaBar[];
  /** Completed daily bars, oldest first (empty = unknown). */
  daily: readonly HtaBar[];
  chain: HtaChain | null;
  /** The chain about 15 minutes earlier (OI change), or null. */
  chainBefore: HtaChain | null;
  /** The futures' price / OI read (LONG_BUILDUP, SHORT_BUILDUP, SHORT_COVERING, LONG_UNWINDING, NEUTRAL) or null. */
  futuresOi: string | null;
}
export type HtaSide = 'BULLISH' | 'BEARISH';
export interface HtaScoreLine { item: string; points: number; detail?: unknown }
export interface HtaOptionPick { strike: number; side: 'CE' | 'PE'; ask: number; delta: number; gamma: number; theta: number; iv: number; premiumAtTarget: number; premiumAtStop: number; optionRr: number; returnPct: number }
export interface HtaSignal {
  version: string;
  side: HtaSide;
  pattern: string;
  score: number;
  lines: HtaScoreLine[];
  entry: number;
  stop: number;
  target: number;
  rr: number;
  atr15: number;
  option: HtaOptionPick;
  backupStrikes: number[];
  levels: { support: number[]; resistance: number[] };
}
export interface HtaResult { signal: HtaSignal | null; best: { side: HtaSide; pattern: string | null; score: number; refusal: string; lines: HtaScoreLine[] } | null }

// ---------------- helpers ----------------
const avg = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const last = <T>(a: readonly T[]) => a[a.length - 1];
const r2 = (x: number) => Math.round(x * 100) / 100;
function ema(values: readonly number[], n: number): number[] {
  if (values.length < n) return [];
  const k = 2 / (n + 1), out: number[] = [];
  let e = avg(values.slice(0, n));
  out.push(e);
  for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function atr(bars: readonly HtaBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  return avg(tr.slice(-n));
}
/** Swing pivots with k bars on each side. */
export function htaPivots(bars: readonly HtaBar[], k = 2): { highs: Array<{ i: number; price: number }>; lows: Array<{ i: number; price: number }> } {
  const highs: Array<{ i: number; price: number }> = [], lows: Array<{ i: number; price: number }> = [];
  for (let i = k; i < bars.length - k; i++) {
    const w = bars.slice(i - k, i + k + 1);
    if (w.every((b, j) => j === k || b.high < bars[i].high)) highs.push({ i, price: bars[i].high });
    if (w.every((b, j) => j === k || b.low > bars[i].low)) lows.push({ i, price: bars[i].low });
  }
  return { highs, lows };
}
export type HtaTrend = 'UP' | 'DOWN' | 'SIDE' | 'UNKNOWN';
export function htaTrendOf(bars: readonly HtaBar[]): HtaTrend {
  if (bars.length < 55) return 'UNKNOWN';
  const closes = bars.map((b) => b.close), e20 = last(ema(closes, 20)), e50 = last(ema(closes, 50)), c = last(closes);
  const p = htaPivots(bars.slice(-60), 2), hs = p.highs.slice(-2), ls = p.lows.slice(-2);
  const hh = hs.length === 2 && hs[1].price > hs[0].price, hl = ls.length === 2 && ls[1].price > ls[0].price;
  const lh = hs.length === 2 && hs[1].price < hs[0].price, ll = ls.length === 2 && ls[1].price < ls[0].price;
  if (c > e20 && e20 > e50 && !(lh && ll)) return 'UP';
  if (c < e20 && e20 < e50 && !(hh && hl)) return 'DOWN';
  if (hh && hl && c > e50) return 'UP';
  if (lh && ll && c < e50) return 'DOWN';
  return 'SIDE';
}
export function htaDailyTrendOf(daily: readonly HtaBar[]): HtaTrend {
  if (daily.length < 25) return 'UNKNOWN';
  const closes = daily.map((b) => b.close), e = ema(closes, 20), now = last(e), before = e[e.length - 6], c = last(closes);
  return c > now && now > before ? 'UP' : c < now && now < before ? 'DOWN' : 'SIDE';
}
export interface HtaLevel { price: number; touches: number; sources: string[] }
/** Support / resistance levels: pivots (15-minute, daily), previous day high / low, opening range, clustered. */
export function htaLevelsOf(bars15: readonly HtaBar[], daily: readonly HtaBar[], today5: readonly HtaBar[], a15: number): HtaLevel[] {
  const raw: Array<{ price: number; src: string }> = [];
  const p15 = htaPivots(bars15.slice(-120), 2);
  for (const x of [...p15.highs, ...p15.lows]) raw.push({ price: x.price, src: 'SWING_15M' });
  const pd = htaPivots(daily.slice(-40), 2);
  for (const x of [...pd.highs, ...pd.lows]) raw.push({ price: x.price, src: 'SWING_DAILY' });
  const pdBar = last(daily);
  if (pdBar) raw.push({ price: pdBar.high, src: 'PDH' }, { price: pdBar.low, src: 'PDL' });
  const or = today5.slice(0, 3);
  if (or.length === 3) raw.push({ price: Math.max(...or.map((b) => b.high)), src: 'OR_HIGH' }, { price: Math.min(...or.map((b) => b.low)), src: 'OR_LOW' });
  raw.sort((x, y) => x.price - y.price);
  const out: HtaLevel[] = [];
  for (const r of raw) {
    const l = last(out);
    if (l && r.price - l.price <= HTA_RULES.levelClusterAtr * a15) { l.price = (l.price * l.touches + r.price) / (l.touches + 1); l.touches++; if (!l.sources.includes(r.src)) l.sources.push(r.src); }
    else out.push({ price: r.price, touches: 1, sources: [r.src] });
  }
  return out;
}
export type HtaCandle = 'BULL_ENGULFING' | 'HAMMER' | 'STRONG_BULL' | 'NONE';
export function htaCandleOf(b: HtaBar, prev: HtaBar | undefined): HtaCandle {
  const range = b.high - b.low;
  if (!(range > 0)) return 'NONE';
  const body = Math.abs(b.close - b.open), lower = Math.min(b.open, b.close) - b.low, closeLoc = (b.close - b.low) / range;
  if (prev && b.close > b.open && prev.close < prev.open && b.close >= prev.open && b.open <= prev.close) return 'BULL_ENGULFING';
  if (lower >= 2 * body && closeLoc >= 0.6) return 'HAMMER';
  if (b.close > b.open && body >= 0.6 * range && closeLoc >= 0.8) return 'STRONG_BULL';
  return 'NONE';
}
function rvolOf(bars: readonly HtaBar[]): number | null {
  const v = bars.slice(-21, -1).map((b) => b.volume).filter((x) => x > 0);
  const cur = last(bars)?.volume ?? 0;
  return v.length >= 10 && cur > 0 ? r2(cur / avg(v)) : null;
}

// ---------------- mirroring (bearish = bullish logic on the mirrored chart) ----------------
const M = 1_000_000_000;
const mBar = (b: HtaBar): HtaBar => ({ ...b, open: M - b.open, high: M - b.low, low: M - b.high, close: M - b.close });
const mLeg = (l: HtaLeg | null) => l;
function mirrorInput(x: HtaInput): HtaInput {
  return {
    ...x, bars5: x.bars5.map(mBar), bars15: x.bars15.map(mBar), daily: x.daily.map(mBar),
    // Calls and puts swap roles, strikes mirror; Greeks keep their magnitudes (delta sign is read as |delta|).
    chain: x.chain && { ...x.chain, spot: M - x.chain.spot, strikes: x.chain.strikes.map((s) => ({ strike: M - s.strike, call: mLeg(s.put), put: mLeg(s.call) })) },
    chainBefore: x.chainBefore && { ...x.chainBefore, spot: M - x.chainBefore.spot, strikes: x.chainBefore.strikes.map((s) => ({ strike: M - s.strike, call: mLeg(s.put), put: mLeg(s.call) })) },
    futuresOi: x.futuresOi === 'LONG_BUILDUP' ? 'SHORT_BUILDUP' : x.futuresOi === 'SHORT_BUILDUP' ? 'LONG_BUILDUP' : x.futuresOi === 'SHORT_COVERING' ? 'LONG_UNWINDING' : x.futuresOi === 'LONG_UNWINDING' ? 'SHORT_COVERING' : x.futuresOi,
  };
}

// ---------------- the option ----------------
/** The liquid strike in the admission delta band whose own Greeks give the best R:R between target and stop. */
export function htaPickOption(chain: HtaChain, side: 'CE' | 'PE', move: number, risk: number, holdHours = HTA_RULES.holdHours): { best: HtaOptionPick | null; ranked: HtaOptionPick[] } {
  const ranked: HtaOptionPick[] = [];
  for (const s of chain.strikes) {
    const l = side === 'CE' ? s.call : s.put;
    if (!l || !(l.ask > 0) || !(l.bid > 0)) continue;
    const mid = (l.ask + l.bid) / 2, spread = ((l.ask - l.bid) / mid) * 100, d = Math.abs(l.delta);
    if (spread > HTA_RULES.maxSpreadPct || d < HTA_RULES.minAbsDelta || d > HTA_RULES.maxAbsDelta || !Number.isFinite(l.gamma) || !Number.isFinite(l.theta)) continue;
    const decay = Math.abs(l.theta) * (holdHours / 24);
    const atTarget = l.ask + d * move + 0.5 * Math.abs(l.gamma) * move * move - decay;
    const atStop = Math.max(0, l.ask - d * risk + 0.5 * Math.abs(l.gamma) * risk * risk - decay);
    const gain = atTarget - l.ask, loss = l.ask - atStop;
    if (!(loss > 0) || !(gain > 0)) continue;
    ranked.push({ strike: s.strike, side, ask: l.ask, delta: r2(l.delta), gamma: l.gamma, theta: l.theta, iv: l.iv, premiumAtTarget: r2(atTarget), premiumAtStop: r2(atStop), optionRr: r2(gain / loss), returnPct: r2((gain / l.ask) * 100) });
  }
  ranked.sort((a, b) => b.optionRr - a.optionRr || b.returnPct - a.returnPct);
  return { best: ranked[0] ?? null, ranked };
}

// ---------------- one side ----------------
interface SideRead { side: HtaSide; pattern: string | null; score: number; lines: HtaScoreLine[]; refusal: string | null; plan: { entry: number; stop: number; target: number; rr: number } | null; option: HtaOptionPick | null; backups: number[]; levels: HtaLevel[]; a15: number }

function readBullish(x: HtaInput, side: HtaSide, unmirror: (p: number) => number): SideRead {
  const lines: HtaScoreLine[] = [];
  const out = (refusal: string | null, extra: Partial<SideRead> = {}): SideRead => ({ side, pattern: null, score: lines.reduce((a, l) => a + l.points, 0), lines, refusal, plan: null, option: null, backups: [], levels: [], a15: 0, ...extra });
  const bars5 = x.bars5.filter((b) => b.time + 300_000 <= x.now), bars15 = x.bars15.filter((b) => b.time + 900_000 <= x.now);
  const today5 = bars5.filter((b) => b.time >= x.sessionOpen);
  if (today5.length < 4 || bars15.length < 60) return out('NOT_ENOUGH_BARS');
  const a15 = atr(bars15), a5 = atr(bars5);
  if (!a15 || !a5) return out('NO_ATR');
  const cur = last(bars5), prev = bars5[bars5.length - 2];

  // 1. trend
  const td = htaDailyTrendOf(x.daily), t15 = htaTrendOf(bars15), t5 = htaTrendOf(bars5);
  if (td === 'DOWN') lines.push({ item: 'DAILY_TREND_AGAINST', points: -25 }); else if (td === 'UP') lines.push({ item: 'DAILY_TREND_WITH', points: 15 });
  if (t15 === 'DOWN') lines.push({ item: 'TREND_15M_AGAINST', points: -15 }); else if (t15 === 'UP') lines.push({ item: 'TREND_15M_WITH', points: 15 });
  if (t5 === 'UP') lines.push({ item: 'TREND_5M_WITH', points: 5 });

  // 2. levels
  const levels = htaLevelsOf(bars15, x.daily, today5, a15);
  const supports = levels.filter((l) => l.price <= cur.close), resistances = levels.filter((l) => l.price > cur.close);
  const candle = htaCandleOf(cur, prev), rvol = rvolOf(bars5);

  // 3-4. patterns (the first that fits, strongest first)
  let pattern: string | null = null, stop = NaN, level: HtaLevel | null = null;
  // Range breakout: a tight box, this bar closes out of the top on volume.
  for (const n of HTA_RULES.boxBars) {
    const box = bars5.slice(-1 - n, -1);
    if (box.length < n) continue;
    const hi = Math.max(...box.map((b) => b.high)), lo = Math.min(...box.map((b) => b.low));
    if (hi - lo <= HTA_RULES.boxMaxAtr15 * a15 && cur.close > hi + 0.05 * a5 && (rvol ?? 0) >= HTA_RULES.breakoutRvol) { pattern = `RANGE_BREAKOUT_${n}`; stop = Math.max(lo, cur.low) - 0.1 * a15; break; }
  }
  // Bounce at a support level (touched at least twice before) with a bullish candle.
  if (!pattern) {
    const s = supports.filter((l) => l.touches >= 2 && cur.low <= l.price + HTA_RULES.touchAtr * a15 && cur.close > l.price).sort((a, b) => b.price - a.price)[0];
    if (s && candle !== 'NONE') { pattern = 'SUPPORT_BOUNCE'; level = s; stop = Math.min(cur.low, s.price) - 0.15 * a15; }
  }
  // Double bottom on the 5-minute chart, confirmed by a close above the middle peak.
  if (!pattern) {
    const w = bars5.slice(-36), p = htaPivots(w, 2), ls = p.lows.slice(-2);
    if (ls.length === 2 && ls[1].i - ls[0].i >= 6 && Math.abs(ls[1].price - ls[0].price) <= 0.2 * a15) {
      const mid = Math.max(...w.slice(ls[0].i, ls[1].i + 1).map((b) => b.high));
      if (cur.close > mid && prev.close <= mid) { pattern = 'DOUBLE_BOTTOM'; stop = Math.min(ls[0].price, ls[1].price) - 0.1 * a15; }
    }
  }
  // Bull flag: a pole (>= 1.5 ATR in <= 4 bars), a shallow pullback of 3-8 bars, a close above the flag.
  if (!pattern) {
    for (const f of [3, 4, 5, 6, 7, 8]) {
      const flag = bars5.slice(-1 - f, -1), pole = bars5.slice(-1 - f - 4, -1 - f);
      if (flag.length < f || pole.length < 4) continue;
      const poleUp = last(pole).close - pole[0].open, fHi = Math.max(...flag.map((b) => b.high)), fLo = Math.min(...flag.map((b) => b.low));
      if (poleUp >= 1.5 * a15 && fHi - fLo <= 0.5 * poleUp && fLo >= last(pole).close - 0.5 * poleUp && cur.close > fHi) { pattern = `BULL_FLAG_${f}`; stop = fLo - 0.1 * a15; break; }
    }
  }
  // Trendline bounce: the line through the last two rising 15-minute swing lows, touched by this bar.
  if (!pattern) {
    const w15 = bars15.slice(-80), p = htaPivots(w15, 2), ls = p.lows.slice(-2);
    if (ls.length === 2 && ls[1].price > ls[0].price) {
      const slope = (ls[1].price - ls[0].price) / (ls[1].i - ls[0].i);
      const lineNow = ls[1].price + slope * (w15.length - 1 - ls[1].i + (cur.time - last(w15).time) / 900_000);
      if (cur.low <= lineNow + HTA_RULES.touchAtr * a15 && cur.close > lineNow && candle !== 'NONE') { pattern = 'TRENDLINE_BOUNCE'; stop = Math.min(cur.low, lineNow) - 0.15 * a15; }
    }
  }
  if (!pattern) return out('NO_PATTERN', { levels, a15 });
  lines.push({ item: `PATTERN_${pattern}`, points: 20 });

  // Level quality, candle, volume.
  const near = level ?? supports.filter((l) => Math.abs(l.price - stop) <= 0.6 * a15).sort((a, b) => b.touches - a.touches)[0];
  if (near && near.touches >= 3) lines.push({ item: 'STRONG_LEVEL', points: 15, detail: { price: r2(unmirror(near.price)), touches: near.touches, sources: near.sources } });
  else if (near && near.touches >= 2) lines.push({ item: 'LEVEL', points: 10, detail: { price: r2(unmirror(near.price)), touches: near.touches } });
  if (candle !== 'NONE') lines.push({ item: `CANDLE_${candle}`, points: 10 });
  if (rvol != null && rvol >= 1.5) lines.push({ item: 'VOLUME_HIGH', points: 10, detail: rvol }); else if (rvol != null && rvol >= 1.2) lines.push({ item: 'VOLUME_ABOVE_AVERAGE', points: 5, detail: rvol });

  // Plan.
  const entry = cur.close, risk = entry - stop;
  if (!(risk > 0) || risk > HTA_RULES.maxRiskAtr15 * a15) return out('RISK_TOO_WIDE', { pattern, levels, a15 });
  // 7. OI (also gives the call wall, a resistance the target must respect).
  let callWall: number | null = null;
  if (x.chain) {
    const above = x.chain.strikes.filter((s) => s.strike > entry && s.call), below = x.chain.strikes.filter((s) => s.strike < entry && s.put);
    const cw = above.sort((a, b) => (b.call!.oi - a.call!.oi))[0], pw = below.sort((a, b) => (b.put!.oi - a.put!.oi))[0];
    callWall = cw ? cw.strike : null;
    const callOi = x.chain.strikes.reduce((a, s) => a + (s.call?.oi ?? 0), 0), putOi = x.chain.strikes.reduce((a, s) => a + (s.put?.oi ?? 0), 0);
    const pcr = callOi > 0 ? putOi / callOi : null;
    if (pcr != null && pcr >= 1.1) lines.push({ item: 'PCR_SUPPORTIVE', points: 5, detail: r2(pcr) }); else if (pcr != null && pcr <= 0.7) lines.push({ item: 'PCR_AGAINST', points: -5, detail: r2(pcr) });
    if (pw && pw.strike >= stop - a15 && pw.strike <= entry) lines.push({ item: 'PUT_WALL_UNDER_ENTRY', points: 5, detail: r2(unmirror(pw.strike)) });
    if (x.chainBefore) {
      const was = new Map(x.chainBefore.strikes.map((s) => [s.strike, s]));
      const nearStrikes = x.chain.strikes.filter((s) => Math.abs(s.strike - entry) <= 2 * a15);
      const dPut = nearStrikes.reduce((a, s) => a + (s.put?.oi ?? 0) - (was.get(s.strike)?.put?.oi ?? s.put?.oi ?? 0), 0);
      const dCall = nearStrikes.reduce((a, s) => a + (s.call?.oi ?? 0) - (was.get(s.strike)?.call?.oi ?? s.call?.oi ?? 0), 0);
      if (dPut > 0 && dPut > dCall) lines.push({ item: 'PUT_WRITING_NEAR_SPOT', points: 10, detail: { dPut, dCall } });
      else if (dCall > 0 && dCall > dPut) lines.push({ item: 'CALL_WRITING_NEAR_SPOT', points: -10, detail: { dPut, dCall } });
    }
  }
  if (x.futuresOi === 'LONG_BUILDUP' || x.futuresOi === 'SHORT_COVERING') lines.push({ item: `FUTURES_${x.futuresOi}`, points: 5 });
  else if (x.futuresOi === 'SHORT_BUILDUP') lines.push({ item: 'FUTURES_SHORT_BUILDUP', points: -10 });

  // Target: the nearest resistance (level or call wall) at least 1R away; else 2R.
  const blockers = [...resistances.map((l) => l.price), ...(callWall != null ? [callWall] : [])].filter((p) => p > entry).sort((a, b) => a - b);
  const wall = blockers[0];
  if (wall != null && wall - entry < HTA_RULES.minRr * risk) return out('RESISTANCE_TOO_CLOSE', { pattern, levels, a15 });
  const target = wall ?? entry + 2 * risk, rr = (target - entry) / risk;
  if (rr >= 2) lines.push({ item: 'RR_2_PLUS', points: 10, detail: r2(rr) }); else lines.push({ item: 'RR_1_5_PLUS', points: 5, detail: r2(rr) });

  // 8. the option.
  if (!x.chain) return out('NO_OPTION_CHAIN', { pattern, levels, a15 });
  const mins = (() => { const d = new Date(x.now + 19_800_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
  if (x.chain.daysToExpiry < 1 && mins >= HTA_RULES.noEntryAfterExpiryDayMin) return out('EXPIRY_DAY_AFTERNOON', { pattern, levels, a15 });
  const { best, ranked } = htaPickOption(x.chain, 'CE', target - entry, risk);
  if (!best) return out('NO_LIQUID_OPTION_IN_DELTA_BAND', { pattern, levels, a15 });
  if (best.optionRr < HTA_RULES.minOptionRr) return out('OPTION_RR_TOO_LOW', { pattern, levels, a15, option: best });
  lines.push({ item: 'OPTION_PICKED', points: best.optionRr >= 2 ? 10 : 5, detail: { strike: r2(unmirror(best.strike)), optionRr: best.optionRr, returnPct: best.returnPct } });
  const score = lines.reduce((a, l) => a + l.points, 0);
  const plan = { entry, stop, target, rr: r2(rr) };
  if (score < HTA_RULES.minScore) return out('SCORE_BELOW_MIN', { pattern, plan, option: best, levels, a15 });
  return { side, pattern, score, lines, refusal: null, plan, option: best, backups: ranked.slice(1, 3).map((r) => r.strike), levels, a15 };
}

/** Evaluate both directions on the newest closed 5-minute bar. */
export function evaluateHumanTa(x: HtaInput): HtaResult {
  const up = readBullish(x, 'BULLISH', (p) => p);
  const downRaw = readBullish(mirrorInput(x), 'BEARISH', (p) => M - p);
  const down: SideRead = {
    ...downRaw,
    lines: downRaw.lines.map((l) => ({ ...l, item: l.item.replace('BULL', 'BEAR').replace('PUT_', '§').replace('CALL_', 'PUT_').replace('§', 'CALL_') })),
    plan: downRaw.plan && { entry: M - downRaw.plan.entry, stop: M - downRaw.plan.stop, target: M - downRaw.plan.target, rr: downRaw.plan.rr },
    option: downRaw.option && { ...downRaw.option, strike: M - downRaw.option.strike, side: 'PE' },
    backups: downRaw.backups.map((s) => M - s),
    levels: downRaw.levels.map((l) => ({ ...l, price: M - l.price })),
    pattern: downRaw.pattern && downRaw.pattern.replace('BULL', 'BEAR').replace('SUPPORT', 'RESISTANCE').replace('DOUBLE_BOTTOM', 'DOUBLE_TOP').replace('RANGE_BREAKOUT', 'RANGE_BREAKDOWN'),
  };
  const signals = [up, down].filter((s) => s.refusal == null && s.plan && s.option);
  const pick = signals.sort((a, b) => b.score - a.score)[0];
  if (pick && pick.plan && pick.option) {
    const price = pick.plan.entry;
    return {
      best: null,
      signal: {
        version: HTA_VERSION, side: pick.side, pattern: pick.pattern!, score: pick.score, lines: pick.lines, entry: r2(pick.plan.entry), stop: r2(pick.plan.stop), target: r2(pick.plan.target), rr: pick.plan.rr, atr15: r2(pick.a15),
        option: pick.option, backupStrikes: pick.backups,
        levels: { support: pick.levels.filter((l) => l.price <= price).map((l) => r2(l.price)).slice(-3), resistance: pick.levels.filter((l) => l.price > price).map((l) => r2(l.price)).slice(0, 3) },
      },
    };
  }
  const near = [up, down].sort((a, b) => (b.pattern ? 1 : 0) - (a.pattern ? 1 : 0) || b.score - a.score)[0];
  return { signal: null, best: { side: near.side, pattern: near.pattern, score: near.score, refusal: near.refusal ?? 'UNKNOWN', lines: near.lines } };
}
