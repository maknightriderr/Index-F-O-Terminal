// ============================================================
// SETUP LIFECYCLE — Redis state, lifecycle rows, CONFIRMED alert (I/O)
// ============================================================
// The I/O around structure-live.ts:
//   - the lifecycle state at structure_setup:{ex}:{u}:{mode} (never the
//     paper-trade slot);
//   - one setup_lifecycle_events row per transition (migration 027; the
//     candle label and patterns, migration 028), each
//     claimed once with a Redis SET NX so concurrent bias reads (browser,
//     scanners, background evaluator) never write a transition twice;
//   - the Telegram alert at CONFIRMED only, deduped per lifecycle id the way
//     trade-setup-close-notifier.ts dedupes closes: a Redis key plus an
//     `alerts` row with alert_type 'STRUCTURE_CONFIRMED'.
// Every failure is logged; none of it can block a bias read or a mint.
// ============================================================

import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram.js';
import type { AlertChannel, Exchange, StructureTradePreview, TradingMode } from '@fno/shared';
import { STRUCTURE_PARAMS, liveLogicStamp, STRATEGY_VERSION, TRIGGER_VERSION, RISK_VERSION, OPTION_VERSION, COST_VERSION } from '../config/trading-flags.js';
import { isAlertFresh, structureRulesFor, structureStateKey, type LifecycleEventRow, type LiveLifecycle, type LiveState } from './structure-live.js';
import { recordSetupEvent } from './setup-events.js';

const SETUP_EVENTS_VERSIONS = { strategyVersion: STRATEGY_VERSION, triggerVersion: TRIGGER_VERSION, riskVersion: RISK_VERSION, optionVersion: OPTION_VERSION, costVersion: COST_VERSION };

/** Best-effort session phase from IST clock time — the only context field cheap enough to compute here without threading more state through. */
function sessionPhaseAt(atMs: number): string {
  const ist = new Date(atMs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
  const hhmm = ist.split(', ')[1] ?? ist;
  const [h, m] = hhmm.split(':').map(Number);
  const minutes = (h ?? 0) * 60 + (m ?? 0);
  if (minutes < 9 * 60 + 45) return 'OPENING';
  if (minutes < 13 * 60) return 'MORNING';
  if (minutes < 14 * 60 + 45) return 'MIDDAY';
  return 'CLOSING';
}

const EVENT_DEDUPE_TTL_SECONDS = 3 * 24 * 60 * 60;
const ALERT_DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function readLiveState(exchange: Exchange, underlying: string, mode: TradingMode): Promise<LiveState | null> {
  try {
    const raw = await redis.get(structureStateKey(exchange, underlying, mode));
    return raw ? (JSON.parse(raw) as LiveState) : null;
  } catch (err: any) {
    logger.warn({ error: err.message, underlying, exchange, mode }, 'Structure: lifecycle state read failed — starting from empty');
    return null;
  }
}

export async function writeLiveState(state: LiveState): Promise<void> {
  try {
    await redis.set(structureStateKey(state.exchange, state.underlying, state.mode), JSON.stringify(state), 'EX', STRUCTURE_PARAMS.STRUCTURE_STATE_TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ error: err.message, underlying: state.underlying, exchange: state.exchange }, 'Structure: lifecycle state write failed');
  }
}

/** Every structure state in Redis (SCAN, not KEYS). */
export async function readAllLiveStates(): Promise<LiveState[]> {
  const out: LiveState[] = [];
  let cursor = '0';
  try {
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'structure_setup:*', 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        const values = await redis.mget(...keys);
        for (const [k, v] of values.entries()) {
          if (!v) continue;
          try {
            out.push(JSON.parse(v) as LiveState);
          } catch (err: any) {
            logger.warn({ error: err.message, key: keys[k] }, 'Structure: unparseable lifecycle state skipped');
          }
        }
      }
    } while (cursor !== '0');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Structure: lifecycle state scan failed');
  }
  return out;
}

/** Writes each transition once (claimed in Redis first). Fire-and-forget. */
export function recordLifecycleEvents(events: readonly LifecycleEventRow[]): void {
  if (events.length === 0) return;
  void (async () => {
    const logicVersion = liveLogicStamp().logicVersion;
    for (const e of events) {
      try {
        const claimed = await redis.set(`structure_event:${e.lifecycleId}:${e.toState}`, '1', 'EX', EVENT_DEDUPE_TTL_SECONDS, 'NX');
        if (claimed !== 'OK') continue;
      } catch (err: any) {
        // A missed dedupe claim must not lose the row: write it (a rare duplicate beats a silent gap).
        logger.warn({ error: err.message, lifecycleId: e.lifecycleId, toState: e.toState }, 'Structure: lifecycle event dedupe claim failed — writing anyway');
      }
      try {
        await sql`
          INSERT INTO setup_lifecycle_events (
            time, lifecycle_id, symbol, exchange, mode, direction, from_state, to_state, reason,
            pool_kind, pool_price, zone_kind, zone_near, zone_far, entry, stop, t1, t2, score, underlying_price,
            decision_id, signal_id, logic_version, pattern_label, patterns
          ) VALUES (
            ${new Date(e.at)}, ${e.lifecycleId}, ${e.symbol}, ${e.exchange}, ${e.mode}, ${e.direction}, ${e.fromState}, ${e.toState}, ${e.reason},
            ${e.poolKind}, ${e.poolPrice}, ${e.zone?.kind ?? null}, ${e.zone?.near ?? null}, ${e.zone?.far ?? null}, ${e.entry}, ${e.stop}, ${e.t1}, ${e.t2},
            ${e.score}, ${e.underlyingPrice}, ${e.decisionId ?? null}, ${e.signalId ?? null}, ${logicVersion},
            ${e.patterns?.label ?? null}, ${e.patterns ? sql.json({ ...e.patterns, scoreCandle: e.scoreCandle ?? null } as never) : null}
          )
        `;
      } catch (err: any) {
        logger.warn({ error: err.message, lifecycleId: e.lifecycleId, toState: e.toState }, 'Structure: lifecycle event insert failed');
      }
      // Stage 2 (signal-diagnostics): setup_events, a separate table nothing
      // in the decision path reads. Every transition setup_lifecycle_events
      // gets, setup_events gets too (see setup-events.ts's module comment for
      // what its score columns are and aren't). Never blocks/alters the
      // lifecycle above — recordSetupEvent is fire-and-forget and logs its
      // own failures loudly.
      recordSetupEvent({
        time: new Date(e.at),
        instrument: e.symbol,
        exchange: e.exchange,
        timeframe: '15m',
        lifecycleId: e.lifecycleId,
        direction: e.direction,
        fromStage: e.fromState,
        toStage: e.toState,
        reason: e.reason,
        poolType: e.poolKind,
        poolPrice: e.poolPrice,
        poolRank: e.poolRank ?? null,
        sweepDepthAtr: e.sweepDepthAtr ?? null,
        entry: e.entry,
        stop: e.stop,
        t1: e.t1,
        t2: e.t2,
        scoreTotal: e.score,
        scoreCandleApplied: e.scoreCandle?.applied ?? null,
        displacementBodyAtr: e.displacementBodyAtr ?? null,
        context: { sessionPhase: sessionPhaseAt(e.at) },
        decisionId: e.decisionId ?? null,
        signalId: e.signalId ?? null,
        versions: SETUP_EVENTS_VERSIONS,
      });
    }
  })().catch((err: any) => logger.warn({ error: err.message }, 'Structure: lifecycle event recording failed'));
}

/**
 * Telegram (and the alerts table) at CONFIRMED only, once per lifecycle.
 * A transition older than STRUCTURE_ALERT_MAX_AGE_MIN is recorded but not
 * pushed. Fire-and-forget.
 */
export function notifyStructureConfirmed(state: LiveState, lc: LiveLifecycle, now: number, preview?: StructureTradePreview | null): void {
  if (lc.stage !== 'CONFIRMED' || !isAlertFresh(lc.stageAt, now, STRUCTURE_PARAMS.STRUCTURE_ALERT_MAX_AGE_MIN)) return;
  void deliverConfirmed(state, lc, preview ?? null).catch((err: any) => logger.warn({ error: err.message, lifecycleId: lc.id }, 'Structure: CONFIRMED alert failed'));
}

async function deliverConfirmed(state: LiveState, lc: LiveLifecycle, preview: StructureTradePreview | null): Promise<void> {
  const claimed = await redis.set(`structure_confirmed_notified:${lc.id}`, '1', 'EX', ALERT_DEDUPE_TTL_SECONDS, 'NX');
  if (claimed !== 'OK') return;
  const channels: AlertChannel[] = isTelegramConfigured() ? ['TERMINAL', 'TELEGRAM'] : ['TERMINAL'];
  const message = confirmedMessage(state, lc, (s) => s, preview);
  try {
    await sql`
      INSERT INTO alerts (symbol, alert_type, message, severity, channels, condition, triggered, triggered_at)
      VALUES (
        ${state.underlying}, 'STRUCTURE_CONFIRMED', ${message}, 'INFO', ${sql.json(channels)},
        ${sql.json({
          lifecycleId: lc.id,
          exchange: state.exchange,
          mode: state.mode,
          timeframe: lc.timeframe ?? state.timeframe ?? '15m',
          direction: lc.direction,
          pool: lc.pool,
          zone: lc.zone,
          entry: lc.entry,
          stop: lc.stop,
          t1: lc.t1,
          t2: lc.t2,
          rToT1: lc.rToT1,
          score: lc.score,
          scoreCandle: lc.scoreCandle ?? null,
          patterns: lc.patterns ?? null,
        } as never)},
        true, NOW()
      )
    `;
  } catch (err: any) {
    logger.error({ error: err.message, symbol: state.underlying }, 'Failed to persist STRUCTURE_CONFIRMED alert');
  }
  logger.info({ symbol: state.underlying, alertType: 'STRUCTURE_CONFIRMED', lifecycleId: lc.id }, message.replace(/\n/g, ' | '));
  if (channels.includes('TELEGRAM')) await sendTelegramMessage(confirmedMessage(state, lc, escapeHtml, preview));
}

export function confirmedMessage(state: LiveState, lc: LiveLifecycle, esc: (s: string) => string, preview?: StructureTradePreview | null): string {
  const arrow = lc.direction === 'BULLISH' ? '🟢' : '🔴';
  const side = lc.direction === 'BULLISH' ? 'CE' : 'PE';
  const tf = lc.timeframe ?? state.timeframe ?? '15m';
  const fillWithin = tf === '5m' ? `${structureRulesFor(tf).fillWithinBars} five-minute bars (120 min)` : `${structureRulesFor(tf).fillWithinBars} bars`;
  const lines = [
    `${arrow} STRUCTURE · NEW CONFIRMED — ${state.underlying} ${lc.direction} (${state.exchange} · ${tf === '5m' ? '5m entry, 15m pools' : '15m'})`,
    `${lc.pool.kind.replace(/_/g, ' ').toLowerCase()} ${lc.pool.price} swept, displacement printed.`,
    ...(lc.patterns ? [`Candles: ${lc.patterns.label}${lc.scoreCandle && lc.scoreCandle.applied > 0 ? ` (+${lc.scoreCandle.applied} score)` : ''}.`] : []),
    `Limit ${lc.entry} (${lc.zone?.kind === 'FVG' ? `fair-value gap ${lc.zone.near}–${lc.zone.far}` : 'displacement 50%'}) · stop ${lc.stop} · T1 ${lc.t1 ? `${lc.t1.price} (${lc.t1.kind.replace(/_/g, ' ').toLowerCase()}, ${lc.rToT1}R)` : '—'}${lc.t2 ? ` · T2 ${lc.t2.price}` : ''}`,
    `Setup quality ${lc.score ?? '—'}/100 · ranking only, never gates. A ${side} paper trade is minted only if the limit fills within ${fillWithin} and every gate passes.`,
    ...(preview
      ? preview.available
        ? [
            '',
            `ORDER PENDING (est.) — ${side} ${preview.strike} ${preview.expiry ? `(exp ${preview.expiry}, ${preview.dte} DTE)` : ''}`,
            `Entry ~${preview.estEntryPremium} · SL ~${preview.estStopLossPremium} · Target ~${preview.estTargetPremium}${preview.riskReward != null ? ` · R:R 1:${preview.riskReward.toFixed(2)}` : ''}`,
            ...(preview.trailPlan
              ? [`Trail: SL → entry at +${preview.trailPlan.breakevenAtR}R (₹${preview.trailPlan.breakevenPremium}); locks +1x risk at +${preview.trailPlan.lockAtR}R (₹${preview.trailPlan.lockPremium}).`]
              : []),
          ]
        : ['', `If it fills now, F&O validation would refuse it: ${preview.reason ?? 'reason unavailable'}.`]
      : []),
    'Paper signal — no order is placed.',
  ];
  return lines.map(esc).join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
