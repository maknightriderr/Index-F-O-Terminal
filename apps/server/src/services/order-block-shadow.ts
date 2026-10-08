// ============================================================
// ORDER BLOCK SHADOW — OB-2.0 recorded beside the live vote (measurement)
// ============================================================
// ORDER_BLOCK_MODE=SHADOW: the indicator engine's live structure vote keeps
// reading the frozen legacy detector, so no paper trade changes. Once per
// closed decision bar, per symbol, this records:
//   * every OB-2.0 block with its lifecycle and reaction (order_blocks);
//   * the legacy vote, the OB-2.0 signal at the same bar, and whether the
//     OB-2.0 vote would have changed the indicator's direction
//     (order_block_shadow).
// Reads closed bars only; old trades are never touched.
// ============================================================

import { detectOrderBlocks, ORDER_BLOCK_VERSION, type OhlcBar, type OrderBlockSignal, type OrderBlockV2 } from '@fno/analytics';
import { sql } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { schemaFileReady } from './ensure-capture-schema.js';
import { ORDER_BLOCK_MODE } from '../config/order-flow-flags.js';

export const ORDER_BLOCK_MIGRATION = '038_order_blocks_order_flow_of1.sql';

type Vote = -1 | 0 | 1;

/**
 * Pure: the indicator engine's direction with the OB-2.0 vote in place of the
 * legacy one — the same aggregation it uses (chart votes and positioning
 * votes each netted and capped, then summed).
 */
export function directionWithOrderBlockVote(args: {
  chartVotes: readonly Vote[];
  positioningVotes: readonly Vote[];
  legacyVote: Vote;
  v2Vote: Vote;
  cap: number;
}): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  const chart = [...args.chartVotes];
  if (args.legacyVote !== 0) {
    const k = chart.indexOf(args.legacyVote);
    if (k >= 0) chart.splice(k, 1);
  }
  if (args.v2Vote !== 0) chart.push(args.v2Vote);
  const capped = (votes: readonly Vote[]) => {
    const net = votes.reduce((a: number, b) => a + b, 0);
    return Math.sign(net) * Math.min(Math.abs(net), args.cap);
  };
  const sum = capped(chart) + capped(args.positioningVotes);
  return sum > 0 ? 'BULLISH' : sum < 0 ? 'BEARISH' : 'NEUTRAL';
}

const lastWritten = new Map<string, string>();
const blockKey = (symbol: string, exchange: string, b: OrderBlockV2, bars: readonly OhlcBar[]) => `${exchange}:${symbol}:${bars[b.blockIndex].time}:${b.type}`;

export async function recordOrderBlockShadow(a: {
  underlying: string;
  exchange: string;
  mode: string;
  bars: ReadonlyArray<OhlcBar & { time: number }>;
  legacyVote: Vote;
  signal: OrderBlockSignal | null;
  liveDirection: string;
  directionWithV2: string;
}): Promise<void> {
  if (ORDER_BLOCK_MODE === 'OFF' || !schemaFileReady(ORDER_BLOCK_MIGRATION) || a.bars.length === 0) return;
  const decisionBar = a.bars[a.bars.length - 1].time;
  const first = await redis.set(`ob_shadow:${a.exchange}:${a.underlying}:${a.mode}:${decisionBar}`, '1', 'EX', 36 * 60 * 60, 'NX');
  if (first !== 'OK') return;
  try {
    const s = a.signal;
    await sql`
      INSERT INTO order_block_shadow (symbol, exchange, mode, decision_bar_time, version, legacy_vote, v2_vote, block_type, block_time, block_high, block_low, live_direction, direction_with_v2, changed_direction)
      VALUES (${a.underlying}, ${a.exchange}, ${a.mode}, ${new Date(decisionBar)}, ${ORDER_BLOCK_VERSION}, ${a.legacyVote}, ${s?.vote ?? 0}, ${s?.block.type ?? null},
        ${s ? new Date(a.bars[s.block.blockIndex].time) : null}, ${s?.block.top ?? null}, ${s?.block.bottom ?? null}, ${a.liveDirection}, ${a.directionWithV2}, ${a.liveDirection !== a.directionWithV2})
      ON CONFLICT (symbol, exchange, mode, decision_bar_time) DO NOTHING
    `;
    for (const b of detectOrderBlocks(a.bars)) {
      const key = blockKey(a.underlying, a.exchange, b, a.bars);
      const sig = `${b.state}|${b.firstTouchIndex}|${b.mitigatedIndex}|${b.reaction?.barsMeasured ?? -1}|${b.reaction?.held ?? 'x'}`;
      if (lastWritten.get(key) === sig) continue;
      lastWritten.set(key, sig);
      const t = (i: number | null) => (i == null ? null : new Date(a.bars[i].time));
      await sql`
        INSERT INTO order_blocks (symbol, exchange, version, block_type, block_time, displacement_time, block_high, block_low, atr, displacement_atr, state, first_touch_time, mitigated_time, reaction_bars, mfe_atr, mae_atr, held)
        VALUES (${a.underlying}, ${a.exchange}, ${ORDER_BLOCK_VERSION}, ${b.type}, ${t(b.blockIndex)}, ${t(b.displacementIndex)}, ${b.top}, ${b.bottom}, ${b.atr}, ${b.displacementAtr}, ${b.state},
          ${t(b.firstTouchIndex)}, ${t(b.mitigatedIndex)}, ${b.reaction?.barsMeasured ?? null}, ${b.reaction?.mfeAtr ?? null}, ${b.reaction?.maeAtr ?? null}, ${b.reaction?.held ?? null})
        ON CONFLICT (symbol, exchange, version, block_time, block_type) DO UPDATE SET
          state = EXCLUDED.state, first_touch_time = EXCLUDED.first_touch_time, mitigated_time = EXCLUDED.mitigated_time, reaction_bars = EXCLUDED.reaction_bars,
          mfe_atr = EXCLUDED.mfe_atr, mae_atr = EXCLUDED.mae_atr, held = EXCLUDED.held, updated_at = NOW()
      `;
    }
    if (lastWritten.size > 20_000) lastWritten.clear();
  } catch (err: any) {
    logger.warn({ error: err.message, underlying: a.underlying }, 'Order block shadow: record failed');
  }
}
