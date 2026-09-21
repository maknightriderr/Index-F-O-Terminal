// ============================================================
// HISTORICAL MARKET-STATE CAPTURE
// ============================================================
// The look-ahead audit's most consequential finding was not a bug. It was
// that oi_snapshots, futures_snapshots, pcr_history and market_ticks had
// full schema, indexes and hypertables, and had never had a single row
// written to them. No historical option chain existed, so the
// chain-dependent half of the decision pipeline could not be replayed at a
// past instant no matter what harness was built around it.
//
// This service is the fix. Every capture interval during a live session it
// writes, for each symbol the engine actually reads:
//
//   - the raw option chain around ATM (premium, both sides of the book,
//     depth, OI, OI change, IV, all four Greeks, and the spot it was ATM to)
//   - the futures leg (price, basis, OI, OI change, both sides)
//   - the underlying (LTP, OHLC, volume, VWAP, ATR, both sides)
//   - positioning aggregates (the four PCRs, raw call/put OI and OI change,
//     the walls, max pain)
//
// Raw observations, not only derived indicators. A derived number cannot be
// re-derived differently later, and the whole point of the capture is that
// future research should not be limited to the questions today's code
// happens to answer.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not capture per tick. The decision engine polls on minutes and
// makes decisions on minutes; per-tick chain capture would multiply row
// count by two orders of magnitude to record state no decision was ever
// made from. It does not capture outside session hours, because a frozen
// last print is not an observation. It does not capture symbols nobody
// looks at, because the tracking set already knows which chains the engine
// reads. And it never blocks, slows or fails a decision: every write is
// fire-and-forget, and a capture failure is logged and dropped.
//
// The volume this writes to has been filled once already, so pruning is not
// optional: on a TimescaleDB host 007 installs retention policies, and on
// the plain managed Postgres in production this service prunes past its own
// horizon on a schedule instead.
// ============================================================

import { isMarketOpen, getSessionWindow } from '@fno/shared';
import type { Exchange, OptionChain, FuturesChainResponse } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { buildOptionChain } from './option-chain.js';
import { buildFuturesData } from './futures.js';
import { decisionNow } from './decision-clock.js';
import { recordDataQuality } from './data-quality.js';
import {
  assessLegQuality,
  rawLegValues,
  storeIfPositive,
  storeIfFinite,
  CAPTURE_QUALITY_VERSION,
  CURRENT_CONTRACT_GENERATION,
  GREEKS_MODEL_NAME,
  GREEKS_MODEL_VERSION,
} from './capture-quality.js';
import { RISK_FREE_RATE, yearsToExpiry } from '@fno/shared';

const EXCHANGES: Exchange[] = ['NSE', 'BSE', 'MCX'];

/**
 * How often a symbol's full state is captured. Fifteen minutes matches the
 * short-tier candle the intraday engine decides on, so every capture lines
 * up with a bar the engine could have acted at, and a replay stepping bar
 * by bar finds a chain waiting at each step.
 */
const CAPTURE_INTERVAL_MS = 15 * 60 * 1000;
/** Checked more often than that so a restart does not skip a whole bucket. */
const TICK_MS = 60 * 1000;
const INITIAL_DELAY_MS = 120_000;

/**
 * Strikes either side of ATM. Twenty-one covers roughly ±3 expected moves
 * on an index at ordinary volatility, which is every strike a directional
 * setup would ever select and enough of the wings to reconstruct the smile
 * and the OI walls.
 */
const STRIKES_EACH_SIDE = 21;

/** Symbols per capture pass. The quote endpoints are rate-limited. */
const MAX_SYMBOLS_PER_PASS = 12;
const STAGGER_MS = 2500;

/** Fallback pruning horizon for a Postgres with no retention policies. */
const PRUNE_HORIZON_DAYS = 400;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const trackedKey = (exchange: Exchange) => `oi_snapshot_tracked:${exchange}`;
const captureMarkKey = (exchange: Exchange, underlying: string) => `capture:last:${exchange}:${underlying}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Storage representation now lives in capture-quality.ts, split into
// storeIfPositive (for prices and IV, where a zero cannot be a measurement)
// and storeIfFinite (for signed Greeks, where a near-zero can be). The
// earlier single nullIfZero conflated the two, which is what made a
// legitimate far-OTM gamma indistinguishable from a missing one.
//
// The live decision path is still untouched: the chain builder continues to
// fill a missing quote with zero, and `hasQuote` still reads `bid > 0`.

let started = false;

export function startMarketStateCapture(provider: MarketDataProvider): void {
  if (started) return;
  started = true;

  const tick = () => {
    void runCapturePass(provider).catch((err: any) =>
      logger.warn({ error: err.message }, 'Market state capture: pass failed')
    );
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, INITIAL_DELAY_MS);

  const prune = () => {
    void pruneOldCaptures().catch((err: any) =>
      logger.warn({ error: err.message }, 'Market state capture: prune failed')
    );
  };
  setTimeout(() => {
    prune();
    setInterval(prune, PRUNE_INTERVAL_MS);
  }, INITIAL_DELAY_MS + 60_000);

  logger.info(
    { captureIntervalMinutes: CAPTURE_INTERVAL_MS / 60000, strikesEachSide: STRIKES_EACH_SIDE },
    'Market state capture started'
  );
}

async function runCapturePass(provider: MarketDataProvider): Promise<void> {
  for (const exchange of EXCHANGES) {
    // A frozen last print is not an observation. Capturing outside the
    // session would fill the history with rows that repeat the close and
    // look, to a replay, like real quiet-market observations.
    if (!isMarketOpen(exchange)) continue;

    const tracked = await redis.zrevrange(trackedKey(exchange), 0, MAX_SYMBOLS_PER_PASS * 2 - 1);
    if (tracked.length === 0) continue;

    let captured = 0;
    for (const member of tracked) {
      if (captured >= MAX_SYMBOLS_PER_PASS) break;
      const [underlying, expiry] = member.split('|');
      if (!underlying || !expiry) continue;

      if (!(await dueForCapture(exchange, underlying))) continue;

      try {
        await captureSymbol(provider, exchange, underlying, expiry);
        captured++;
        await sleep(STAGGER_MS);
      } catch (err: any) {
        logger.warn({ error: err.message, underlying, exchange }, 'Market state capture: symbol failed');
      }
    }
  }
}

/**
 * True once per capture interval per symbol. The mark is a Redis key with a
 * TTL rather than a timestamp comparison, so a restart cannot double-capture
 * and a missed pass simply captures late rather than not at all.
 */
async function dueForCapture(exchange: Exchange, underlying: string): Promise<boolean> {
  const claimed = await redis.set(
    captureMarkKey(exchange, underlying),
    '1',
    'PX',
    CAPTURE_INTERVAL_MS,
    'NX'
  );
  return claimed === 'OK';
}

async function captureSymbol(
  provider: MarketDataProvider,
  exchange: Exchange,
  underlying: string,
  expiry: string
): Promise<void> {
  const at = new Date(decisionNow());
  const startedAt = Date.now();

  // The attempt is recorded BEFORE the outcome is known. An interval with no
  // capture_runs row is a pass that never ran; a row still reading ATTEMPT is
  // a capture that died mid-flight. Without this, a pass that wrote 40 legs
  // instead of 86 was indistinguishable from one that never ran at all,
  // which is exactly the ambiguity that made "656 option legs" unexplainable.
  const runId = await openCaptureRun(at, exchange, underlying, expiry);

  const [chain, futures] = await Promise.all([
    buildOptionChain(provider, underlying, exchange, expiry).catch(() => null),
    buildFuturesData(provider, underlying, exchange).catch(() => null),
  ]);

  if (!chain) {
    recordDataQuality({
      symbol: underlying,
      exchange,
      issue: 'MISSING_CHAIN',
      severity: 'WARN',
      detail: `No option chain returned for ${underlying} ${expiry} during a live session.`,
    });
    await closeCaptureRun(runId, {
      status: 'FAILED',
      failureReason: 'buildOptionChain returned nothing during a live session',
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const [chainResult, futuresRows] = await Promise.all([
    captureChain(at, exchange, underlying, chain, runId),
    captureFutures(at, exchange, underlying, futures, runId),
    capturePositioning(at, underlying, chain, runId),
  ]);

  // The underlying observation on the capture schedule.
  //
  // captureUnderlyingObservation is also called from the decision path,
  // where it records the VWAP and ATR the engine ACTUALLY used. That is the
  // more valuable row — but it only fires when a setup is taken, and the
  // engine refuses most of what it sees, so relying on it alone left
  // market_ticks empty while every other capture table filled up. A replay
  // needs the underlying at every step, not only at the rare steps that
  // became trades.
  //
  // This row carries no VWAP or ATR: they are written as NULL rather than
  // recomputed here, because a value this service derived from a slightly
  // different candle window would silently disagree with the one the engine
  // decided on, and a replay could not tell which it was looking at.
  captureUnderlyingObservation({
    at: at.getTime(),
    symbol: underlying,
    exchange,
    token: chain.underlying ?? underlying,
    ltp: chain.spotPrice,
    open: null,
    high: null,
    low: null,
    close: chain.spotPrice,
    volume: null,
    vwap: null,
    atr: null,
    captureRunId: runId,
  });

  // PARTIAL means WE fell short of what the exchange offered. A chain that
  // simply lists fewer strikes than the window asked for is a SUCCESS with a
  // clipping reason — the capture is complete for what exists. Collapsing the
  // two would make every MCX commodity look like a partial capture forever.
  await closeCaptureRun(runId, {
    status: chainResult.actualLegs < chainResult.expectedLegs ? 'PARTIAL' : 'SUCCESS',
    spot: chain.spotPrice,
    strikesAvailable: chainResult.strikesAvailable,
    strikesCaptured: chainResult.strikesCaptured,
    expectedStrikes: STRIKES_EACH_SIDE * 2 + 1,
    actualStrikes: chainResult.strikesCaptured,
    expectedLegs: chainResult.expectedLegs,
    actualLegs: chainResult.actualLegs,
    futuresRows,
    positioningRows: 1,
    underlyingRows: 1,
    durationMs: Date.now() - startedAt,
    clippingReason: chainResult.clippingReason,
    failureReason: chainResult.actualLegs < chainResult.expectedLegs ? chainResult.detail : null,
    detail:
      chainResult.invalidGreekLegs > 0
        ? `${chainResult.detail ? chainResult.detail + '; ' : ''}${chainResult.invalidGreekLegs} leg(s) written with Greeks that are not research-usable (recorded, not dropped)`
        : chainResult.detail,
  });
}

// ---------------------------------------------------------------
// Capture run bookkeeping
// ---------------------------------------------------------------

async function openCaptureRun(
  at: Date,
  exchange: Exchange,
  symbol: string,
  expiry: string
): Promise<string | null> {
  try {
    // STARTED, with the start instant recorded separately from the
    // completion instant. A row left reading STARTED with a null completion
    // is a capture that died mid-flight — which is a different fact from a
    // capture that never ran, and neither is visible without this.
    const sessionDate = at.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO capture_runs (time, capture_started_at, session_date, exchange, symbol, expiry, status)
      VALUES (${at}, ${at}, ${sessionDate}, ${exchange}, ${symbol}, ${expiry}, 'STARTED')
      RETURNING id
    `;
    return row?.id ?? null;
  } catch (err: any) {
    logger.debug({ error: err.message, symbol }, 'Capture run: could not open');
    return null;
  }
}

async function closeCaptureRun(
  runId: string | null,
  outcome: {
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
    strikesAvailable?: number;
    strikesCaptured?: number;
    expectedStrikes?: number;
    actualStrikes?: number;
    expectedLegs?: number;
    actualLegs?: number;
    futuresRows?: number;
    positioningRows?: number;
    underlyingRows?: number;
    spot?: number | null;
    durationMs: number;
    /** The exchange did not list the strikes we asked for. Nothing failed. */
    clippingReason?: string | null;
    /** We did not store what the exchange offered. The gap is ours. */
    failureReason?: string | null;
    detail?: string | null;
  }
): Promise<void> {
  if (!runId) return;
  try {
    await sql`
      UPDATE capture_runs SET
        status = ${outcome.status},
        capture_completed_at = ${new Date()},
        spot = ${outcome.spot ?? null},
        strikes_available = ${outcome.strikesAvailable ?? null},
        strikes_captured = ${outcome.strikesCaptured ?? null},
        expected_strikes = ${outcome.expectedStrikes ?? null},
        actual_strikes = ${outcome.actualStrikes ?? null},
        expected_legs = ${outcome.expectedLegs ?? null},
        actual_legs = ${outcome.actualLegs ?? null},
        futures_rows = ${outcome.futuresRows ?? null},
        positioning_rows = ${outcome.positioningRows ?? null},
        underlying_rows = ${outcome.underlyingRows ?? null},
        duration_ms = ${outcome.durationMs},
        clipping_reason = ${outcome.clippingReason ?? null},
        failure_reason = ${outcome.failureReason ?? null},
        detail = ${outcome.detail ?? null}
      WHERE id = ${runId}
    `;
  } catch (err: any) {
    logger.debug({ error: err.message }, 'Capture run: could not close');
  }
}

// ---------------------------------------------------------------
// Option chain
// ---------------------------------------------------------------

interface ChainCaptureResult {
  /** Strikes the chain actually listed inside the capture window. */
  strikesAvailable: number;
  strikesCaptured: number;
  /** Two legs for every strike inside the window. */
  expectedLegs: number;
  actualLegs: number;
  /** Legs written whose Greeks are not research-usable. Recorded, never dropped. */
  invalidGreekLegs: number;
  /** The exchange listed fewer strikes than the window asked for. Not a failure. */
  clippingReason: string | null;
  detail: string | null;
}

async function captureChain(
  at: Date,
  exchange: Exchange,
  underlying: string,
  chain: OptionChain,
  runId: string | null
): Promise<ChainCaptureResult> {
  const atmIndex = chain.strikes.findIndex((s) => s.strike === chain.atmStrike);
  const centre = atmIndex >= 0 ? atmIndex : Math.floor(chain.strikes.length / 2);
  const from = Math.max(0, centre - STRIKES_EACH_SIDE);
  const to = Math.min(chain.strikes.length, centre + STRIKES_EACH_SIDE + 1);

  // The window is clipped by the chain itself. A symbol whose chain lists
  // fewer than 43 strikes around ATM — which is most stock options, and any
  // index near the edge of its listed range — cannot produce 86 legs, and
  // that is a property of the instrument, not a capture failure. Recording
  // both numbers is what makes the difference legible afterwards.
  const strikesInWindow = to - from;
  const expectedLegs = strikesInWindow * 2;
  const missingReasons: string[] = [];
  let invalidGreekLegs = 0;

  const rows: Record<string, unknown>[] = [];
  for (let i = from; i < to; i++) {
    const strike = chain.strikes[i];
    for (const [type, leg] of [
      ['CE', strike.call],
      ['PE', strike.put],
    ] as const) {
      if (!leg) {
        // A strike row that carries only one side. Recorded as a reason, never
        // padded with a zero-valued leg: a leg that does not exist and a leg
        // quoted at zero are different facts.
        missingReasons.push(`${strike.strike}${type} absent from the chain`);
        continue;
      }
      const quality = assessLegQuality(leg);
      if (!quality.greeksValid) invalidGreekLegs++;

      rows.push({
        time: at,
        // Hard lineage: the run that wrote this row, carried ON the row.
        // Matching (timestamp, symbol) in a reporting query is a
        // reconstruction, not a lineage, and it fails silently the moment two
        // captures share a second.
        capture_run_id: runId,
        capture_quality_version: CAPTURE_QUALITY_VERSION,
        // Stamped, not inferred. A row that says which contract wrote it
        // needs no date arithmetic to be classified later.
        contract_generation: CURRENT_CONTRACT_GENERATION,
        token: leg.token,
        symbol: underlying,
        exchange,
        instrument_type: 'OPTION',
        strike: strike.strike,
        option_type: type,
        expiry: chain.expiry,
        oi: leg.oi,
        change_oi: leg.changeOi,
        volume: leg.volume,
        ltp: storeIfPositive(leg.ltp),
        bid: storeIfPositive(leg.bid),
        ask: storeIfPositive(leg.ask),
        // Depth quantities are not on the chain leg today. Recorded as NULL
        // rather than zero: a missing observation and an empty book are
        // different facts, and a replay must be able to tell them apart.
        bid_qty: null,
        ask_qty: null,
        // IV cannot legitimately be zero, so absence is stored as NULL.
        iv: storeIfPositive(leg.iv),
        // The Greeks keep whatever finite value the model produced, including
        // a genuine near-zero. Whether it is USABLE is greeks_valid, not the
        // number — which is the whole point of stating validity at write time.
        delta: storeIfFinite(leg.delta),
        gamma: storeIfFinite(leg.gamma),
        theta: storeIfFinite(leg.theta),
        vega: storeIfFinite(leg.vega),
        spot_price: storeIfPositive(chain.spotPrice),
        moneyness: leg.moneyness,
        greeks_source: leg.greeksSource,

        // Explicit validity, stated by the code that saw the raw value.
        quote_available: quality.quoteAvailable,
        depth_available: quality.depthAvailable,
        iv_available: quality.ivAvailable,
        greeks_available: quality.greeksAvailable,
        greeks_valid: quality.greeksValid,
        validity_reason: quality.validityReason,

        // Raw, exactly as the leg arrived, so the interpretation above stays
        // auditable rather than lossy.
        raw_values: JSON.stringify(rawLegValues(leg)),

        // Model provenance. Every captured Greek so far is model output, and
        // a Greek that cannot be attributed to a model and its inputs cannot
        // be reproduced by a replay.
        greeks_model_name: leg.greeksSource === 'BROKER' ? null : GREEKS_MODEL_NAME,
        greeks_model_version: leg.greeksSource === 'BROKER' ? null : GREEKS_MODEL_VERSION,
        greeks_calculated_at: leg.greeksSource === 'BROKER' ? null : at,
        model_spot: storeIfPositive(chain.spotPrice),
        model_option_price: storeIfPositive(leg.ltp),
        model_iv_input: storeIfPositive(leg.iv),
        model_rate: RISK_FREE_RATE,
        model_time_to_expiry: yearsToExpiry(chain.expiry, exchange, at.getTime()),
      });
    }
  }

  const result: ChainCaptureResult = {
    strikesAvailable: chain.strikes.length,
    strikesCaptured: strikesInWindow,
    expectedLegs,
    actualLegs: rows.length,
    invalidGreekLegs,
    clippingReason:
      strikesInWindow < STRIKES_EACH_SIDE * 2 + 1
        ? `the exchange listed ${chain.strikes.length} strikes for this expiry, so the ${STRIKES_EACH_SIDE}-either-side window clipped to ${strikesInWindow} strikes (${expectedLegs} legs)`
        : null,
    detail:
      missingReasons.length > 0
        ? `${missingReasons.length} leg(s) not present in the chain: ${missingReasons.slice(0, 6).join('; ')}${missingReasons.length > 6 ? ` (+${missingReasons.length - 6} more)` : ''}`
        : strikesInWindow < STRIKES_EACH_SIDE * 2 + 1
          ? `chain listed only ${chain.strikes.length} strikes, so the ${STRIKES_EACH_SIDE}-either-side window clipped to ${strikesInWindow}`
          : null,
  };

  if (rows.length === 0) return result;

  await sql`INSERT INTO oi_snapshots ${sql(
    rows,
    'time', 'capture_run_id', 'capture_quality_version', 'contract_generation', 'token', 'symbol', 'exchange',
    'instrument_type', 'strike', 'option_type', 'expiry',
    'oi', 'change_oi', 'volume', 'ltp', 'bid', 'ask', 'bid_qty', 'ask_qty',
    'iv', 'delta', 'gamma', 'theta', 'vega', 'spot_price', 'moneyness', 'greeks_source',
    'quote_available', 'depth_available', 'iv_available', 'greeks_available', 'greeks_valid',
    'validity_reason', 'raw_values',
    'greeks_model_name', 'greeks_model_version', 'greeks_calculated_at',
    'model_spot', 'model_option_price', 'model_iv_input', 'model_rate', 'model_time_to_expiry'
  )}`;

  return result;
}

// ---------------------------------------------------------------
// Futures
// ---------------------------------------------------------------

async function captureFutures(
  at: Date,
  exchange: Exchange,
  underlying: string,
  futures: FuturesChainResponse | null,
  runId: string | null
): Promise<number> {
  if (!futures || futures.contracts.length === 0) return 0;

  const rows = futures.contracts.map((c) => ({
    time: at,
    capture_run_id: runId,
    token: c.token,
    symbol: underlying,
    exchange,
    expiry: c.expiry,
    spot_price: futures.spotPrice,
    futures_price: storeIfPositive(c.futuresPrice),
    ltp: storeIfPositive(c.futuresPrice),
    basis: c.basis,
    premium_discount: c.premiumDiscount,
    volume: c.volume,
    oi: c.oi,
    change_oi: c.changeOi,
    interpretation: c.interpretation,
    bid: null,
    ask: null,
  }));

  await sql`INSERT INTO futures_snapshots ${sql(
    rows,
    'time', 'capture_run_id', 'token', 'symbol', 'exchange', 'expiry', 'spot_price',
    'futures_price', 'ltp', 'basis', 'premium_discount', 'volume', 'oi', 'change_oi',
    'interpretation', 'bid', 'ask'
  )}`;

  return rows.length;
}

// ---------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------

async function capturePositioning(
  at: Date,
  underlying: string,
  chain: OptionChain,
  runId: string | null
): Promise<void> {
  let callOi = 0;
  let putOi = 0;
  let callOiChange = 0;
  let putOiChange = 0;
  let callWall: { strike: number; oi: number } | null = null;
  let putWall: { strike: number; oi: number } | null = null;

  for (const s of chain.strikes) {
    if (s.call) {
      callOi += s.call.oi;
      callOiChange += s.call.changeOi;
      if (s.strike >= chain.spotPrice && (!callWall || s.call.oi > callWall.oi)) {
        callWall = { strike: s.strike, oi: s.call.oi };
      }
    }
    if (s.put) {
      putOi += s.put.oi;
      putOiChange += s.put.changeOi;
      if (s.strike <= chain.spotPrice && (!putWall || s.put.oi > putWall.oi)) {
        putWall = { strike: s.strike, oi: s.put.oi };
      }
    }
  }

  await sql`
    INSERT INTO pcr_history (
      time, capture_run_id, symbol, expiry, oi_pcr, volume_pcr, change_oi_pcr, near_atm_pcr,
      call_oi, put_oi, call_oi_change, put_oi_change, call_wall, put_wall, max_pain, spot_price
    ) VALUES (
      ${at}, ${runId}, ${underlying}, ${chain.expiry},
      ${chain.pcrDetail?.oiPCR ?? null}, ${chain.pcrDetail?.volumePCR ?? null},
      ${chain.pcrDetail?.changeOiPCR ?? null}, ${chain.pcrDetail?.nearAtmPCR ?? null},
      ${callOi}, ${putOi}, ${callOiChange}, ${putOiChange},
      ${callWall?.strike ?? null}, ${putWall?.strike ?? null},
      ${chain.maxPain ?? null}, ${chain.spotPrice}
    )
  `;
}

// ---------------------------------------------------------------
// Underlying
// ---------------------------------------------------------------

/**
 * Records the underlying observation the engine just decided from.
 *
 * Called by the bias engine rather than on this service's own schedule, on
 * purpose: the values that matter for a replay are the VWAP and ATR the
 * engine ACTUALLY used, not ones this service would recompute a few seconds
 * later from a slightly different candle window and quietly disagree about.
 */
export function captureUnderlyingObservation(input: {
  at: number;
  symbol: string;
  exchange: Exchange;
  token: string;
  ltp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  vwap: number | null;
  atr: number | null;
  captureRunId?: string | null;
}): void {
  void sql`
    INSERT INTO market_ticks (time, capture_run_id, token, symbol, exchange, ltp, open_price, high, low, close_price, volume, vwap, atr)
    VALUES (
      ${new Date(input.at)}, ${input.captureRunId ?? null}, ${input.token}, ${input.symbol}, ${input.exchange}, ${input.ltp},
      ${input.open}, ${input.high}, ${input.low}, ${input.close}, ${input.volume},
      ${input.vwap}, ${input.atr}
    )
  `.catch((err: any) =>
    logger.warn({ error: err.message, symbol: input.symbol }, 'Market state capture: underlying write failed')
  );
}

// ---------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------

/**
 * Deletes past the horizon on a Postgres with no retention policies.
 *
 * On a TimescaleDB host the policies in 007 have already removed these rows
 * and each statement deletes nothing. On the plain managed Postgres in
 * production this is the only thing standing between a year of chain
 * capture and the volume filling up — which has happened before, and took
 * the database down with it.
 */
async function pruneOldCaptures(): Promise<void> {
  const cutoff = new Date(Date.now() - PRUNE_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const dqCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const deleted = {
    oi: (await sql`DELETE FROM oi_snapshots WHERE time < ${cutoff}`).count,
    futures: (await sql`DELETE FROM futures_snapshots WHERE time < ${cutoff}`).count,
    pcr: (await sql`DELETE FROM pcr_history WHERE time < ${cutoff}`).count,
    ticks: (await sql`DELETE FROM market_ticks WHERE time < ${cutoff}`).count,
    dq: (await sql`DELETE FROM data_quality_events WHERE time < ${dqCutoff}`).count,
  };
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info({ deleted, horizonDays: PRUNE_HORIZON_DAYS }, 'Market state capture: pruned');
}

/** Row counts per capture table, for the coverage report. */
export async function captureCoverage(): Promise<
  { table: string; rows: number; oldest: string | null; newest: string | null }[]
> {
  const tables = ['oi_snapshots', 'futures_snapshots', 'pcr_history', 'market_ticks', 'decision_snapshots', 'iv_history'];
  const out: { table: string; rows: number; oldest: string | null; newest: string | null }[] = [];
  for (const table of tables) {
    try {
      const [row] = await sql.unsafe<{ n: string; oldest: Date | null; newest: Date | null }[]>(
        `SELECT COUNT(*) AS n, MIN(time) AS oldest, MAX(time) AS newest FROM ${table}`
      );
      out.push({
        table,
        rows: Number(row?.n ?? 0),
        oldest: row?.oldest ? new Date(row.oldest).toISOString() : null,
        newest: row?.newest ? new Date(row.newest).toISOString() : null,
      });
    } catch (err: any) {
      out.push({ table, rows: -1, oldest: null, newest: err.message });
    }
  }
  return out;
}

/** Exported for the session-window check in tests. */
export { CAPTURE_INTERVAL_MS, STRIKES_EACH_SIDE, getSessionWindow };
