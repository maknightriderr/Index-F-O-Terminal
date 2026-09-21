/**
 * FEATURE / DATA TIMESTAMP MAP
 *
 * One row per feature the trading engine reads, recording where the value
 * comes from, what window it is computed over, when it first becomes
 * knowable, and whether it reads the still-forming bar.
 *
 * This is the audit artefact the validation spec asks for, kept as code
 * rather than a document so it can be tested and so it goes stale loudly
 * instead of quietly. `feature-lineage.test` asserts that every feature
 * named here still exists in the engine, and that no feature classified
 * CLEAN is computed from a series the engine has not bounded to the
 * decision instant.
 *
 * The three risk classifications mean specific things:
 *
 *   CLEAN         Computed only from data that had settled before the
 *                 decision instant. Reproducible in replay, bar for bar.
 *
 *   FORMING_BAR   Computed from a series whose newest element is the bar
 *                 currently in progress. NOT look-ahead: it uses no future
 *                 information, only an unfinished present. It is a PARITY
 *                 risk — the value can change within the bar and then
 *                 settle somewhere else, so a replay driven by completed
 *                 bars will not reproduce the intermediate reading. Each
 *                 row says whether that matters for the decision it feeds.
 *
 *   LIVE_MOMENT   Deliberately the current instant: spot, the running
 *                 session VWAP, a live bid/ask. There is nothing to
 *                 stabilise — the whole point is the present value. In
 *                 replay these must come from the bar being replayed, and
 *                 the row says which.
 *
 * No feature in the engine is classified LEAKED. The audit looked for
 * genuine future reads — a detector indexing past the end of its series, a
 * statistic computed over a window that includes the outcome, an outcome
 * column read back into a decision — and did not find one. What it found
 * instead was the clock problem (see decision-clock.ts) and one detector
 * deciding against a running close, noted on `liquidity sweep` below.
 */

export type LookaheadRisk = 'CLEAN' | 'FORMING_BAR' | 'LIVE_MOMENT' | 'LEAKED';

export interface FeatureLineage {
  /** Feature name as the engine knows it. */
  feature: string;
  /** Where the raw input comes from. */
  source: string;
  /** The window the value is computed over. */
  window: string;
  /** When the value first becomes knowable, relative to the data it needs. */
  availableAt: string;
  /** Where the engine consumes it. */
  usedAt: string;
  risk: LookaheadRisk;
  /** For FORMING_BAR: does the instability actually change a decision? */
  note?: string;
}

export const FEATURE_LINEAGE: FeatureLineage[] = [
  // ---------- Price series ----------
  {
    feature: 'candles15m / candles1h (short & long tier)',
    source: 'Angel One getCandleData',
    window: 'intraday 15m/10d + 1h/30d; positional 1h/60d + 1d/540d',
    availableAt: 'each bar at its own close; the newest bar is in progress',
    usedAt: 'market-bias.ts loadBiasCandles',
    risk: 'FORMING_BAR',
    note: 'The fetch window ends at the decision instant, so nothing beyond it is ever returned. The newest element is partial by construction.',
  },
  {
    feature: 'spot',
    source: 'last close of the short-tier series',
    window: 'single value',
    availableAt: 'continuously',
    usedAt: 'every price comparison in computeMarketBias',
    risk: 'LIVE_MOMENT',
    note: 'Intentionally the running price. In replay it is the replayed bar’s close.',
  },
  {
    feature: 'todayOpen / todayChangePct',
    source: 'first candle of the current IST session',
    window: 'session to date',
    availableAt: 'from the first bar of the session',
    usedAt: 'computeMarketBias, scanner change column',
    risk: 'CLEAN',
  },
  {
    feature: 'previous-session high / low / close (pivots R1-R3, S1-S3)',
    source: 'filterPreviousSession over the short-tier series',
    window: 'the most recent completed session strictly before today',
    availableAt: 'at that session’s close, i.e. before today opened',
    usedAt: 'pivotPoints; structural levels for location & room',
    risk: 'CLEAN',
  },
  {
    feature: 'day high / day low',
    source: 'current session bars',
    window: 'session to date',
    availableAt: 'continuously, as a running extreme',
    usedAt: 'structural levels for location & room',
    risk: 'LIVE_MOMENT',
    note: 'A running extreme of the session so far is not the session’s final range; it must never be compared against the final range in replay.',
  },

  // ---------- Volume ----------
  {
    feature: 'volumeRatio (short tier)',
    source: 'candle volume, completed bars only',
    window: 'last completed bar vs trailing 20 completed bars',
    availableAt: 'at each bar close',
    usedAt: 'volume confirmation for Supertrend flips and Bollinger breakouts',
    risk: 'CLEAN',
    note: 'Explicitly slices off the forming bar — comparing a partial bar to an average of complete ones understated it by roughly half and made it sawtooth within every bucket.',
  },
  {
    feature: 'longVolumeRatio (long tier)',
    source: 'candle volume, completed bars only',
    window: 'last completed bar vs trailing 20',
    availableAt: 'at each bar close',
    usedAt: 'VCP breakout confirmation, 1H Supertrend flip confirmation',
    risk: 'CLEAN',
  },
  {
    feature: 'borrowed futures volume (indices)',
    source: 'nearest futures contract candles',
    window: 'same window as the underlying series',
    availableAt: 'at each bar close',
    usedAt: 'loadBiasCandles withBorrowedVolume',
    risk: 'CLEAN',
    note: 'Index candles carry no volume. Thins in the days before a rollover.',
  },

  // ---------- Indicators ----------
  {
    feature: 'rsi (short tier, 14)',
    source: 'closes',
    window: '14 bars, Wilder smoothing over the full series',
    availableAt: 'continuously; last value moves with the forming bar',
    usedAt: 'price vote',
    risk: 'FORMING_BAR',
    note: 'Standard practice, and the vote is banded with two-read hysteresis, so intra-bar drift does not flip it on one reading.',
  },
  {
    feature: 'macd histogram (long tier, 12/26/9)',
    source: 'closes',
    window: 'full series',
    availableAt: 'continuously',
    usedAt: 'price vote',
    risk: 'FORMING_BAR',
    note: 'Feeds a hysteresis-banded vote, so the histogram drifting across zero within a bar does not flip the vote on a single reading — it has to clear the hold band and stay there.',
  },
  {
    feature: 'adx (long tier, 14)',
    source: 'high/low/close',
    window: '14 bars',
    availableAt: 'continuously',
    usedAt: 'regime classification (trend strength)',
    risk: 'FORMING_BAR',
    note: 'Trend strength, not direction, and it feeds a regime label rather than a vote. A partial bar moves it by a point or two, which does not cross a regime boundary on its own.',
  },
  {
    feature: 'atrShort (short tier, 14)',
    source: 'high/low/close',
    window: '14 bars',
    availableAt: 'continuously',
    usedAt: 'stop/target ATR measurement, trade-health expected progress, location & room',
    risk: 'FORMING_BAR',
    note: 'The scale a stop has to survive. A partial newest bar understates it slightly, which makes stops marginally tighter, not looser — the conservative direction.',
  },
  {
    feature: 'atrPct z-score (long tier)',
    source: 'atr / close',
    window: 'full long-tier series',
    availableAt: 'continuously',
    usedAt: 'HIGH_VOLATILITY / LOW_VOLATILITY regime',
    risk: 'FORMING_BAR',
    note: 'Only used to separate HIGH_VOLATILITY from LOW_VOLATILITY, a two-boundary classification on a z-score of a long-tier series. A single partial bar cannot move a z-score across a boundary.',
  },
  {
    feature: 'supertrendShort (10, 3 / positional 2)',
    source: 'high/low/close',
    window: '10 bars',
    availableAt: 'continuously',
    usedAt: 'price vote, and shortJustFlipped',
    risk: 'FORMING_BAR',
    note: 'Guarded, but differently from the long tier: an unconfirmed flip suppresses the vote to neutral, where the long tier falls back to the previous bar’s direction (regime has no neutral to fall back to). Both guards exist; the asymmetry is deliberate.',
  },
  {
    feature: 'supertrendLong + flip confirmation',
    source: 'high/low/close',
    window: '10 bars',
    availableAt: 'continuously; a flip is only trusted once long-tier volume confirms it',
    usedAt: 'regime classification, price vote',
    risk: 'FORMING_BAR',
    note: 'Guarded: an unconfirmed flip reads as the previous bar’s direction.',
  },
  {
    feature: 'bollinger %B (short tier, 20/2)',
    source: 'closes',
    window: '20 bars',
    availableAt: 'continuously',
    usedAt: 'price vote (breakout, volume-confirmed)',
    risk: 'FORMING_BAR',
    note: 'Feeds a breakout vote that additionally requires completed-bar volume confirmation, so an intra-bar poke outside the band does not vote on its own.',
  },
  {
    feature: 'emaTrendStructure (long tier, 20/50)',
    source: 'closes',
    window: '50 bars plus slope',
    availableAt: 'continuously',
    usedAt: 'price vote',
    risk: 'FORMING_BAR',
    note: 'Requires stacking AND slope, so a single partial bar cannot manufacture the signal.',
  },
  {
    feature: 'session VWAP',
    source: 'high/low/close/volume of the current session',
    window: 'session to date',
    availableAt: 'continuously',
    usedAt: 'price vote, structural level, trade-health structure read',
    risk: 'LIVE_MOMENT',
    note: 'A running session VWAP is the intended value. Reports unavailable rather than falling back to spot when the feed carries no volume.',
  },

  // ---------- Structure ----------
  {
    feature: 'swing points (peaks / troughs)',
    source: 'high/low, findSwingPoints(strength 2)',
    window: 'full short-tier series',
    availableAt: 'two bars AFTER the pivot bar closes',
    usedAt: 'market structure, BOS/CHoCH, liquidity sweep',
    risk: 'CLEAN',
    note: 'A pivot needs two confirming bars on each side, so the newest confirmable swing sits at T-2 and the forming bar can never be one.',
  },
  {
    feature: 'BOS / CHoCH',
    source: 'swing sequence',
    window: 'full short-tier series',
    availableAt: 'with the swing that breaks structure',
    usedAt: 'structure votes',
    risk: 'CLEAN',
  },
  {
    feature: 'liquidity sweep',
    source: 'high/low/close vs prior swing extremes, forming bar excluded',
    window: 'last CLOSED bar against confirmed swings',
    availableAt: 'at the sweeping bar’s close',
    usedAt: 'structure vote',
    risk: 'CLEAN',
    note: 'AUDIT FINDING, FIXED IN THIS RELEASE. The sweep requires the bar to close back through the swept level, so on a forming bar it was being decided against a running close: a wick through a swing high with price still below it read as a completed sweep, and pushed an unhysteresised structure vote that vanished when the bar closed above. Now detected on closed bars only, exactly as fair value gaps already were. Costs one bar of latency; a sweep is not a sweep until its bar closes.',
  },
  {
    feature: 'order blocks',
    source: 'high/low/close',
    window: 'a candle plus up to 3 bars of impulse after it',
    availableAt: 'up to 3 bars after the block candle',
    usedAt: 'structure vote, zone tests',
    risk: 'CLEAN',
    note: 'Indexes forward only within the supplied series, which ends at the decision instant — so a block is identified only once its confirming impulse has actually printed. Verified during the audit; this reads as look-ahead and is not.',
  },
  {
    feature: 'fair value gaps',
    source: 'high/low, forming bar excluded',
    window: '3-bar pattern over closed bars',
    availableAt: 'at the close of the third bar',
    usedAt: 'structure vote, zone tests',
    risk: 'CLEAN',
    note: 'Explicitly slices off the forming bar so "is price testing this zone now" and "has a later bar filled it" stay separate questions.',
  },
  {
    feature: 'premium / discount',
    source: 'high/low range vs spot',
    window: 'trailing 20 bars',
    availableAt: 'continuously',
    usedAt: 'structure vote',
    risk: 'FORMING_BAR',
    note: 'A position within the trailing 20-bar range, so the forming bar shifts it only when it is setting a new extreme — which is genuinely the current state, not a distortion.',
  },
  {
    feature: 'chart patterns (short & long tier)',
    source: 'high/low/close/volume',
    window: 'full tier series',
    availableAt: 'once the pattern’s final swing confirms',
    usedAt: 'reasoning; scanner',
    risk: 'FORMING_BAR',
    note: 'Reasoning and scanner display only; no pattern here casts a trade vote by itself. A pattern that resolves differently once the bar closes changes the text, not the decision.',
  },
  {
    feature: 'candlestick pattern',
    source: 'last 15 short-tier bars',
    window: '1-3 bars plus trailing context',
    availableAt: 'at the pattern bar’s close',
    usedAt: 'reasoning',
    risk: 'FORMING_BAR',
    note: 'A Hammer is not a Hammer until its bar closes.',
  },
  {
    feature: 'VCP',
    source: 'long-tier high/low/close/volume',
    window: 'multi-week base',
    availableAt: 'contraction sequence at bar closes; breakout needs volume confirmation',
    usedAt: 'price vote (confirmed only)',
    risk: 'CLEAN',
    note: 'Breakout counts only when confirmed by completed-bar volume.',
  },
  {
    feature: 'rsi divergence',
    source: 'closes + rsi series',
    window: 'full short-tier series',
    availableAt: 'at swing confirmation',
    usedAt: 'price vote',
    risk: 'FORMING_BAR',
    note: 'Anchored on confirmed swing points, which need two bars on each side, so the divergence itself cannot form on the partial bar — only the RSI value at that swing drifts.',
  },

  // ---------- Option chain ----------
  {
    feature: 'option chain (strikes, LTP, bid/ask, OI, change OI, volume)',
    source: 'Angel One quote + OI, live snapshot',
    window: 'instantaneous',
    availableAt: 'at the quote',
    usedAt: 'buildOptionChain; everything downstream of it',
    risk: 'LIVE_MOMENT',
    note: 'NOT REPLAYABLE. No historical option-chain store exists — see the report. This is the boundary of what the replay harness can reproduce.',
  },
  {
    feature: 'atmIv',
    source: 'chain, near-ATM legs',
    window: 'instantaneous',
    availableAt: 'at the quote',
    usedAt: 'IV-vs-HV, expected move, regime, option quality',
    risk: 'LIVE_MOMENT',
  },
  {
    feature: 'ivRank / ivPercentile',
    source: 'iv_history table',
    window: 'trailing 365 days of recorded ATM IV',
    availableAt: 'from recorded history only',
    usedAt: 'scanner, option quality',
    risk: 'CLEAN',
    note: 'Query is bounded to strictly-past rows. The window is wall-clock-anchored (NOW() - 365 days), so a replay must re-anchor it to the decision instant.',
  },
  {
    feature: 'greeks (delta, gamma, theta, vega)',
    source: 'Black-Scholes on the live chain',
    window: 'instantaneous',
    availableAt: 'at the quote',
    usedAt: 'strike selection, target sizing, option quality',
    risk: 'LIVE_MOMENT',
    note: 'Time to expiry runs to the exchange close, not UTC midnight.',
  },
  {
    feature: 'PCR (oi, volume, change-OI, near-ATM)',
    source: 'chain aggregates',
    window: 'instantaneous',
    availableAt: 'at the quote',
    usedAt: 'positioning vote',
    risk: 'LIVE_MOMENT',
  },
  {
    feature: 'OI walls (support / resistance ladders)',
    source: 'chain OI by strike, side-filtered against spot',
    window: 'instantaneous',
    availableAt: 'at the quote',
    usedAt: 'structural levels for location & room; room-to-target cap',
    risk: 'LIVE_MOMENT',
  },
  {
    feature: 'option OI flow (buying vs writing)',
    source: 'per-leg OI change weighted by OI moved, each leg classified by its own premium direction',
    window: 'today’s OI change',
    availableAt: 'at the quote',
    usedAt: 'positioning vote',
    risk: 'LIVE_MOMENT',
  },
  {
    feature: 'gamma exposure regime',
    source: 'chain gamma by strike',
    window: 'instantaneous',
    availableAt: 'at the quote',
    usedAt: 'regime classification (EXPIRY_GAMMA)',
    risk: 'LIVE_MOMENT',
  },
  {
    feature: 'expected move',
    source: 'atmIv × sqrt(time to expiry)',
    window: 'instantaneous, expiry runs to the exchange close',
    availableAt: 'at the quote',
    usedAt: 'target sizing, room required',
    risk: 'LIVE_MOMENT',
  },

  // ---------- Futures ----------
  {
    feature: 'futures OI, change OI, basis, interpretation',
    source: 'Angel One futures quote',
    window: 'instantaneous',
    availableAt: 'at the quote',
    usedAt: 'positioning vote, operator-activity read',
    risk: 'LIVE_MOMENT',
    note: 'NOT REPLAYABLE — futures_snapshots is empty schema.',
  },

  // ---------- Derived state ----------
  {
    feature: 'historical volatility',
    source: 'long-tier closes',
    window: 'trailing returns',
    availableAt: 'at bar closes',
    usedAt: 'IV-vs-HV richness',
    risk: 'CLEAN',
  },
  {
    feature: 'market regime',
    source: 'adx + confirmed long-tier Supertrend + atrPct z + dte + gamma regime + breakout/operator flags',
    window: 'as its inputs',
    availableAt: 'as its inputs',
    usedAt: 'regime alignment, reporting, trade tagging',
    risk: 'FORMING_BAR',
    note: 'Inherits its inputs’ stability. The flip confirmation exists because this specifically was seen reversing inside two minutes.',
  },
  {
    feature: 'bias direction & confidence',
    source: 'weighted votes over all of the above, with two-read hysteresis per threshold',
    window: 'as its inputs',
    availableAt: 'as its inputs',
    usedAt: 'the setup gate',
    risk: 'FORMING_BAR',
    note: 'Hysteresis is what keeps forming-bar noise from flipping the output; it is a state machine over successive reads, so it is itself order-dependent and a replay must step it in the same order.',
  },
  {
    feature: 'next-day gap / volatile probabilities',
    source: 'daily bars, trailing base rates with shrinkage',
    window: 'trailing 250 sessions, walk-forward',
    availableAt: 'after the basis session closes',
    usedAt: 'next-day bias card',
    risk: 'CLEAN',
    note: 'Asserted: recomputing with all future bars removed must produce a byte-identical estimate, checked every 97th session across 2025-26. isVolatileNext measures ATR strictly before the basis day.',
  },
  {
    feature: 'prediction accuracy windows',
    source: 'graded NEXT_DAY_BIAS rows',
    window: 'trailing graded history',
    availableAt: 'only after grading, which happens after the outcome',
    usedAt: 'DISPLAY ONLY — the track-record strip',
    risk: 'CLEAN',
    note: 'Audited specifically for feedback leakage: graded outcomes are never read back into a prediction, and a resolved prediction is never rewritten.',
  },

  // ---------- Risk state ----------
  {
    feature: 'risk state (realised R, consecutive stops, trades today, open positions)',
    source: 'signals table, today’s rows',
    window: 'current IST day, closed trades only',
    availableAt: 'as each trade closes',
    usedAt: 'the circuit breaker, first in the refusal chain',
    risk: 'CLEAN',
    note: 'Reads only trades that had already closed at the decision instant. Day boundary is IST and now comes from the decision clock.',
  },
  {
    feature: 'post-loss cooldown state',
    source: 'Redis keys named by the IST day',
    window: 'current IST day',
    availableAt: 'at the losing close',
    usedAt: 'the post-loss gates',
    risk: 'CLEAN',
    note: 'Day-keyed, so the decision clock has to drive the key name for replay to work at all.',
  },
  {
    feature: 'trade excursion (MAE / MFE / milestones)',
    source: 'monitor observations folded forward',
    window: 'entry to now',
    availableAt: 'continuously after entry',
    usedAt: 'trade health, exit records',
    risk: 'CLEAN',
    note: 'Fold-forward only: each observation updates the running extremes and can never see a later one.',
  },
];

/** Features whose value can move within a bar and settle elsewhere. */
export function formingBarFeatures(): FeatureLineage[] {
  return FEATURE_LINEAGE.filter((f) => f.risk === 'FORMING_BAR');
}

/** Features that cannot be reproduced from any stored history today. */
export function unreplayableFeatures(): FeatureLineage[] {
  return FEATURE_LINEAGE.filter((f) => f.note?.includes('NOT REPLAYABLE'));
}

/** Any feature the audit classified as genuinely leaking future information. */
export function leakedFeatures(): FeatureLineage[] {
  return FEATURE_LINEAGE.filter((f) => f.risk === 'LEAKED');
}
