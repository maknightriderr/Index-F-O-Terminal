// ============================================================
// EXPIRY PREMIUM PRESSURE runner (GXP-1.0): the index option chains the fresh-start worker already samples each minute
// ============================================================
// No provider call of its own: the worker's per-minute chain refresh (NIFTY, BANKNIFTY, FINNIFTY, SENSEX, BANKEX; the
// shared chain cache) hands each chain here. This side keeps 30 minutes of samples per index, runs the pure analysis
// (packages/analytics/src/premium-pressure) and keeps the latest read for the dashboard. A directional read becomes ONE
// paper candidate per index and direction per 30 minutes, in its own paper book (':GXP:'), priced, costed and admitted
// by the same paper adapter and store as every engine. Paper only: no broker order path exists. Never throws.
// ============================================================

import { analyzePremiumPressure, ppEntryPlan, FRESH_PACK_VERSION, GXP_STRATEGY_ID, GXP_CONFIG, type FreshCandidate, type PpAnalysis, type PpBar, type PpLeg, type PpSample } from '@fno/analytics';
import type { OptionChain } from '@fno/shared';
import { logger } from '../../lib/logger.js';
import { sendTelegramMessage } from '../../lib/telegram.js';

const KEEP_MS = 30 * 60_000;
export const GXP_SIGNAL_BUCKET_MS = 30 * 60_000;
export const GXP_ENTRY_WINDOW_MS = 45_000;
/** New entries stop 30 minutes before the session cutoff (the module's last-30-minutes rule; the adapter's floor is 10). */
export const GXP_LAST_ENTRY_BEFORE_CUTOFF_MS = 30 * 60_000;
/** Paper entries on by default (owner: validate on paper, not in shadow); GXP_PAPER=false keeps the analysis only. */
export const gxpPaperEnabled = () => process.env.GXP_PAPER !== 'false';

export interface GxpRef { id: string; name: string; market: string; exchange: string }
export interface GxpTick {
  now: number; session: string; sessionOpen: number; sessionClose: number; sourceEpoch: string;
  /** The paper reference's own price (an index future trades at a basis to the spot the strikes are on) and its age. */
  price: number | null; priceAt: number | null;
  bars5: readonly PpBar[];
}
export interface GxpDeps { enter: (c: FreshCandidate) => Promise<string>; alert?: (text: string) => Promise<void> }
export interface GxpEvent { at: number; symbol: string; classification: string; state: string; score: number; confidence: number; decision: string | null; explanation: string[] }

const IST = 19_800_000;
/** Minutes from `at` to the expiry instant: the expiry date at the session's closing time of day. */
export function gxpMinutesToExpiry(expiry: string, at: number, sessionClose: number): number {
  const day = Date.parse(/^\d{4}-\d{2}-\d{2}/.test(expiry) ? `${expiry.slice(0, 10)}T00:00:00+05:30` : expiry);
  if (!Number.isFinite(day)) return NaN;
  const closeOfDay = (sessionClose + IST) % 86_400_000;
  return (day + closeOfDay - at) / 60_000;
}

export function gxpSampleOf(chain: OptionChain, sessionClose: number): PpSample {
  const leg = (l: OptionChain['strikes'][number]['call']): PpLeg | null => (l ? {
    ltp: l.ltp, bid: l.bid, ask: l.ask, oi: l.observedOi === undefined ? (l.oi > 0 ? l.oi : null) : l.observedOi, volume: Number.isFinite(l.volume) ? l.volume : null,
    iv: l.iv > 0 ? l.iv : null, delta: Number.isFinite(l.delta) ? l.delta : null, gamma: Number.isFinite(l.gamma) ? l.gamma : null, theta: Number.isFinite(l.theta) ? l.theta : null, vega: Number.isFinite(l.vega) ? l.vega : null,
  } : null);
  return { at: chain.timestamp, spot: chain.spotPrice, expiry: chain.expiry, minutesToExpiry: gxpMinutesToExpiry(chain.expiry, chain.timestamp, sessionClose), strikeStep: chain.strikeInterval, strikes: chain.strikes.map((s) => ({ strike: s.strike, call: leg(s.call), put: leg(s.put) })) };
}

/** Wilder-free simple ATR over the last 14 closed 5-minute bars. */
export function gxpAtr(bars: readonly PpBar[]): number {
  const xs = bars.slice(-15); if (xs.length < 6) return 0;
  let sum = 0; for (let i = 1; i < xs.length; i++) sum += Math.max(xs[i].high - xs[i].low, Math.abs(xs[i].high - xs[i - 1].close), Math.abs(xs[i].low - xs[i - 1].close));
  return sum / (xs.length - 1);
}

export function gxpAlertText(a: PpAnalysis, plan: { optionSide: string; entry: number; stop: number; target: number; strikes: number[] }, decision: string): string {
  return [
    `🧲 Premium Pressure · ${a.symbol} ${a.classification.replace(/_/g, ' ')} · score ${a.score} · confidence ${a.confidence}`,
    `Plan (underlying): entry ${plan.entry} · stop ${plan.stop} · target ${plan.target} · buy ${plan.optionSide} ${plan.strikes.join(' / ')}`,
    ...a.explanation.slice(1, 5),
    `Paper decision: ${decision} (paper only — no real order)`,
  ].join('\n');
}

const latest = new Map<string, PpAnalysis>();
const events: GxpEvent[] = [];
export const premiumPressureLatest = (): PpAnalysis[] => [...latest.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
export const premiumPressureEvents = (): GxpEvent[] => [...events];

export class PremiumPressureRunner {
  private samples = new Map<string, PpSample[]>();
  private fired = new Map<string, number>();
  private lastClass = new Map<string, string>();
  constructor(private deps: GxpDeps) {}

  /** One fresh chain of one index. Returns the paper decision code when a candidate was sent, else null. Never throws. */
  async onChain(ref: GxpRef, chain: OptionChain, t: GxpTick): Promise<string | null> {
    try {
      const s = gxpSampleOf(chain, t.sessionClose);
      const kept = (this.samples.get(ref.id) ?? []).filter((x) => t.now - x.at <= KEEP_MS && x.at < s.at && x.expiry === s.expiry);
      this.samples.set(ref.id, [...kept, s]);
      const a = analyzePremiumPressure({ symbol: ref.name, now: t.now, samples: this.samples.get(ref.id)!, sessionOpen: t.sessionOpen, config: GXP_CONFIG });
      latest.set(ref.name, a);
      const changed = this.lastClass.get(ref.id) !== `${a.classification}:${a.state}`;
      this.lastClass.set(ref.id, `${a.classification}:${a.state}`);
      const directional = a.state === 'BULLISH' || a.state === 'STRONG_BULLISH' || a.state === 'BEARISH' || a.state === 'STRONG_BEARISH';
      let decision: string | null = null;
      if (directional) {
        const side = a.score > 0 ? 'BULLISH' : 'BEARISH', bucket = Math.floor(t.now / GXP_SIGNAL_BUCKET_MS) * GXP_SIGNAL_BUCKET_MS, key = `${ref.id}:${side}`;
        // One candidate per index and direction per 30-minute bucket (the id is the bucket's, so a restart cannot repeat it).
        if (this.fired.get(key) !== bucket) {
          const fresh = t.price != null && t.priceAt != null && t.now - t.priceAt <= 5000;
          const plan = fresh ? ppEntryPlan(a, t.bars5.filter((b) => b.time + 300_000 <= t.now), gxpAtr(t.bars5), t.price!) : ({ ok: false, code: 'REFERENCE_PRICE_STALE' } as const);
          if (!plan.ok) decision = plan.code;
          else if (!gxpPaperEnabled()) decision = 'GXP_PAPER_OFF';
          else {
            this.fired.set(key, bucket);
            const parentId = `GXP:${ref.id}:${t.session}:${side}:${bucket}`;
            const candidate: FreshCandidate = {
              id: `${FRESH_PACK_VERSION}:${t.sourceEpoch}:${parentId}:${GXP_STRATEGY_ID}`, parentId, version: FRESH_PACK_VERSION, strategy: GXP_STRATEGY_ID as FreshCandidate['strategy'],
              direction: side, instrument: ref.id, sourceEpoch: t.sourceEpoch, session: t.session, at: t.now, referenceEntry: plan.entry, stop: plan.stop, target: plan.target, atr: Math.round(gxpAtr(t.bars5) * 100) / 100,
              expiresAt: Math.min(t.now + GXP_ENTRY_WINDOW_MS, t.sessionClose - GXP_LAST_ENTRY_BEFORE_CUTOFF_MS), exitProfile: 'TARGET', origin: bucket, allowedStrikes: plan.strikes, lastEntryBeforeCutoffMs: GXP_LAST_ENTRY_BEFORE_CUTOFF_MS,
              evidence: { gxp: { version: a.version, classification: a.classification, state: a.state, score: a.score, confidence: a.confidence, period: a.period, components: a.components, ce: a.ce, pe: a.pe, gex: a.gex, dataQuality: a.dataQuality, plan, explanation: a.explanation, invalidation: a.invalidation, simulated: true } },
            };
            try { decision = await this.deps.enter(candidate); } catch (err: any) { decision = err instanceof Error && /^[A-Z_]+$/.test(err.message) ? err.message : 'PAPER_PATH_FAILED'; }
            await (this.deps.alert ?? sendTelegramMessage)(gxpAlertText(a, plan, decision)).catch(() => undefined);
          }
        }
      }
      if (changed || decision) {
        events.push({ at: t.now, symbol: ref.name, classification: a.classification, state: a.state, score: a.score, confidence: a.confidence, decision, explanation: a.explanation });
        while (events.length > 100) events.shift();
        logger.info({ event: 'premiumPressure', name: ref.name, classification: a.classification, state: a.state, score: a.score, confidence: a.confidence, period: a.period, components: a.components, cePressure: a.ce?.writerPressure ?? null, pePressure: a.pe?.writerPressure ?? null, gex: a.gex ? { net: a.gex.netGex, regime: a.gex.regime, flip: a.gex.gammaFlip, pinned: a.gex.pinned } : null, issues: a.dataQuality.issues, decision }, 'Premium pressure: read changed (paper only)');
      }
      return decision;
    } catch (err: any) {
      logger.warn({ event: 'premiumPressure', name: ref.name, error: err?.message }, 'Premium pressure: evaluation failed (the scan is unaffected)');
      return null;
    }
  }
}
