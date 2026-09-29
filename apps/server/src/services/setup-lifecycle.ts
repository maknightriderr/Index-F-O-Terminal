// ============================================================
// SETUP LIFECYCLE — Redis state, lifecycle rows, CONFIRMED alert (I/O)
// ============================================================
// The I/O around structure-live.ts:
//   - the lifecycle state at structure_setup:{ex}:{u}:{mode} (never the
//     paper-trade slot);
//   - one setup_lifecycle_events row per transition (migration 027), each
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
import type { AlertChannel, Exchange, TradingMode } from '@fno/shared';
import { STRUCTURE_PARAMS, liveLogicStamp } from '../config/trading-flags.js';
import { isAlertFresh, structureRulesFor, structureStateKey, type LifecycleEventRow, type LiveLifecycle, type LiveState } from './structure-live.js';

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
            decision_id, signal_id, logic_version
          ) VALUES (
            ${new Date(e.at)}, ${e.lifecycleId}, ${e.symbol}, ${e.exchange}, ${e.mode}, ${e.direction}, ${e.fromState}, ${e.toState}, ${e.reason},
            ${e.poolKind}, ${e.poolPrice}, ${e.zone?.kind ?? null}, ${e.zone?.near ?? null}, ${e.zone?.far ?? null}, ${e.entry}, ${e.stop}, ${e.t1}, ${e.t2},
            ${e.score}, ${e.underlyingPrice}, ${e.decisionId ?? null}, ${e.signalId ?? null}, ${logicVersion}
          )
        `;
      } catch (err: any) {
        logger.warn({ error: err.message, lifecycleId: e.lifecycleId, toState: e.toState }, 'Structure: lifecycle event insert failed');
      }
    }
  })().catch((err: any) => logger.warn({ error: err.message }, 'Structure: lifecycle event recording failed'));
}

/**
 * Telegram (and the alerts table) at CONFIRMED only, once per lifecycle.
 * A transition older than STRUCTURE_ALERT_MAX_AGE_MIN is recorded but not
 * pushed. Fire-and-forget.
 */
export function notifyStructureConfirmed(state: LiveState, lc: LiveLifecycle, now: number): void {
  if (lc.stage !== 'CONFIRMED' || !isAlertFresh(lc.stageAt, now, STRUCTURE_PARAMS.STRUCTURE_ALERT_MAX_AGE_MIN)) return;
  void deliverConfirmed(state, lc).catch((err: any) => logger.warn({ error: err.message, lifecycleId: lc.id }, 'Structure: CONFIRMED alert failed'));
}

async function deliverConfirmed(state: LiveState, lc: LiveLifecycle): Promise<void> {
  const claimed = await redis.set(`structure_confirmed_notified:${lc.id}`, '1', 'EX', ALERT_DEDUPE_TTL_SECONDS, 'NX');
  if (claimed !== 'OK') return;
  const channels: AlertChannel[] = isTelegramConfigured() ? ['TERMINAL', 'TELEGRAM'] : ['TERMINAL'];
  const message = confirmedMessage(state, lc, (s) => s);
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
        } as never)},
        true, NOW()
      )
    `;
  } catch (err: any) {
    logger.error({ error: err.message, symbol: state.underlying }, 'Failed to persist STRUCTURE_CONFIRMED alert');
  }
  logger.info({ symbol: state.underlying, alertType: 'STRUCTURE_CONFIRMED', lifecycleId: lc.id }, message.replace(/\n/g, ' | '));
  if (channels.includes('TELEGRAM')) await sendTelegramMessage(confirmedMessage(state, lc, escapeHtml));
}

export function confirmedMessage(state: LiveState, lc: LiveLifecycle, esc: (s: string) => string): string {
  const arrow = lc.direction === 'BULLISH' ? '🟢' : '🔴';
  const side = lc.direction === 'BULLISH' ? 'CE' : 'PE';
  const tf = lc.timeframe ?? state.timeframe ?? '15m';
  const fillWithin = tf === '5m' ? `${structureRulesFor(tf).fillWithinBars} five-minute bars (120 min)` : `${structureRulesFor(tf).fillWithinBars} bars`;
  const lines = [
    `${arrow} STRUCTURE CONFIRMED — ${state.underlying} ${lc.direction} (${state.exchange} · ${tf === '5m' ? '5m entry, 15m pools' : '15m'})`,
    `${lc.pool.kind.replace(/_/g, ' ').toLowerCase()} ${lc.pool.price} swept, displacement printed.`,
    `Limit ${lc.entry} (${lc.zone?.kind === 'FVG' ? `fair-value gap ${lc.zone.near}–${lc.zone.far}` : 'displacement 50%'}) · stop ${lc.stop} · T1 ${lc.t1 ? `${lc.t1.price} (${lc.t1.kind.replace(/_/g, ' ').toLowerCase()}, ${lc.rToT1}R)` : '—'}${lc.t2 ? ` · T2 ${lc.t2.price}` : ''}`,
    `Score ${lc.score ?? '—'}/100 (describes, never gates). A ${side} paper trade is minted only if the limit fills within ${fillWithin} and every gate passes.`,
    'Paper signal — no order is placed.',
  ];
  return lines.map(esc).join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
