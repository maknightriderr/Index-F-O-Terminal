// ============================================================
// HUMAN TA runner (owner, 13 Nov): the chart reader on every index and MCX reference, at each 5-minute close.
// ============================================================
// Data only from this side: the reference's own 5- and 15-minute bars (the fresh-start context), the futures' daily
// candles (dhan-daily.ts), the option chain with OI and Greeks (buildOptionChain, cached and shared) and the futures' OI
// read. Every decision is HTA-1.0's own (packages/analytics/src/human-ta). A signal becomes one paper candidate on the
// strike HTA chose (its own book, ':HTA:'), priced and admitted by the same paper adapter and store as every engine,
// and a Telegram alert with the reasoning. Paper only: no broker order path exists. Never throws into the scan.
// ============================================================

import { evaluateHumanTa, FRESH_PACK_VERSION, HTA_STRATEGY_ID, type FreshCandidate, type FreshContext, type HtaBar, type HtaChain, type HtaSignal } from '@fno/analytics';
import type { OptionChain } from '@fno/shared';
import { logger } from '../../lib/logger.js';
import { sendTelegramMessage } from '../../lib/telegram.js';
import { dhanDailyBars } from '../dhan-daily.js';

export const HTA_MARKETS: ReadonlySet<string> = new Set(['NSE_INDEX_OPTIONS', 'BSE_VERIFIED_OPTIONS', 'MCX_VERIFIED_FUTURES_OPTIONS']);
/** Entry window of an HTA candidate (the adapter waits for books inside it). */
export const HTA_ENTRY_WINDOW_MS = 45_000;
const CHAIN_KEEP_MS = 30 * 60_000;

export interface HtaRef { id: string; name: string; market: string; exchange: string }
export interface HtaDeps {
  chain: (name: string, exchange: string) => Promise<OptionChain>;
  enter: (c: FreshCandidate) => Promise<string>;
  daily?: (name: string, now: number) => Array<{ time: number; open: number; high: number; low: number; close: number }>;
  alert?: (text: string) => Promise<void>;
}

const IST = 19_800_000;
/** Whole days from today (IST) to the chain's expiry (0 = expiry day); 3 when the date cannot be read. */
export function daysToExpiry(expiry: string, now: number): number {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(expiry) ? `${expiry}T00:00:00+05:30` : expiry);
  if (!Number.isFinite(t)) return 3;
  const day = (x: number) => Math.floor((x + IST) / 86_400_000);
  return Math.max(0, day(t) - day(now));
}

/** The option chain in the reference's price space (an index future trades at a basis to the spot the strikes are on). */
export function htaChainOf(chain: OptionChain, referencePrice: number, now: number): { chain: HtaChain; basis: number } {
  const basis = Number.isFinite(referencePrice) && chain.spotPrice > 0 ? referencePrice - chain.spotPrice : 0;
  const leg = (l: OptionChain['strikes'][number]['call']) => (l && l.ask > 0 && l.bid > 0 ? { ltp: l.ltp, bid: l.bid, ask: l.ask, oi: l.observedOi ?? l.oi ?? 0, iv: l.iv, delta: l.delta, gamma: l.gamma, theta: l.theta } : null);
  return {
    basis,
    chain: { at: chain.timestamp ?? now, spot: chain.spotPrice + basis, expiry: chain.expiry, daysToExpiry: daysToExpiry(chain.expiry, now), strikes: chain.strikes.map((s) => ({ strike: s.strike + basis, call: leg(s.call), put: leg(s.put) })) },
  };
}

const bars = (xs: FreshContext['bars5']): HtaBar[] => xs.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));

export function htaAlertText(name: string, s: HtaSignal, decision: string): string {
  const why = s.lines.filter((l) => l.points > 0).map((l) => l.item.toLowerCase().replace(/_/g, ' ')).join(', ');
  const against = s.lines.filter((l) => l.points < 0).map((l) => l.item.toLowerCase().replace(/_/g, ' ')).join(', ');
  const o = s.option;
  return [
    `🧭 Human TA · ${name} ${s.side === 'BULLISH' ? 'BUY CE' : 'BUY PE'} · ${s.pattern.replace(/_/g, ' ')} · score ${s.score}`,
    `Chart: entry ${s.entry} · stop ${s.stop} · target ${s.target} (R:R ${s.rr})`,
    `Option: ${name} ${Math.round(o.strike)} ${o.side} @ ₹${o.ask} · Δ ${o.delta} · θ ${Math.round(o.theta * 100) / 100}/day · IV ${o.iv} → target ₹${o.premiumAtTarget} / stop ₹${o.premiumAtStop} (option R:R ${o.optionRr}, +${o.returnPct}%)`,
    `Why: ${why}${against ? ` · against: ${against}` : ''}`,
    `Paper decision: ${decision} (paper only — no real order)`,
  ].join('\n');
}

export class HumanTaRunner {
  private chains = new Map<string, Array<{ at: number; chain: HtaChain; basis: number }>>();
  private lastBar = new Map<string, number>();
  constructor(private deps: HtaDeps) {}

  /** The reference's newest 5-minute close (fresh-start context). Never throws. */
  async onBar(ref: HtaRef, c: FreshContext): Promise<string | null> {
    try {
      if (!HTA_MARKETS.has(ref.market)) return null;
      const b5 = bars(c.bars5.filter((b) => b.time + 300_000 <= c.now));
      const barTime = b5[b5.length - 1]?.time;
      if (barTime == null || this.lastBar.get(ref.id) === barTime) return null;
      this.lastBar.set(ref.id, barTime);
      const price = b5[b5.length - 1].close;
      let chainNow: { at: number; chain: HtaChain; basis: number } | null = null;
      try {
        const raw = await this.deps.chain(ref.name, ref.exchange), conv = htaChainOf(raw, price, c.now);
        chainNow = { at: c.now, ...conv };
        this.chains.set(ref.id, [...(this.chains.get(ref.id) ?? []).filter((x) => c.now - x.at <= CHAIN_KEEP_MS), chainNow]);
      } catch (err: any) {
        logger.info({ event: 'humanTaChainUnavailable', name: ref.name, error: err?.message }, 'Human TA: option chain unavailable (no trade without the option)');
      }
      const before = (this.chains.get(ref.id) ?? []).filter((x) => c.now - x.at >= 12 * 60_000 && c.now - x.at <= 20 * 60_000).at(-1) ?? null;
      const daily = (this.deps.daily ?? dhanDailyBars)(ref.name, c.now).map((d) => ({ ...d, volume: 0 }));
      const r = evaluateHumanTa({
        symbol: ref.name, now: c.now, sessionOpen: c.sessionOpen, sessionClose: c.sessionClose, bars5: b5, bars15: bars(c.bars15), daily,
        chain: chainNow?.chain ?? null, chainBefore: before?.chain ?? null, futuresOi: c.indexIntel?.futuresOi ?? null,
      });
      if (!r.signal) {
        if (r.best?.pattern) logger.info({ event: 'humanTaNoTrade', name: ref.name, side: r.best.side, pattern: r.best.pattern, score: r.best.score, refusal: r.best.refusal, lines: r.best.lines }, 'Human TA: a pattern, but no trade');
        return r.best?.refusal ?? null;
      }
      const s = r.signal, basis = chainNow?.basis ?? 0;
      const strikes = [s.option.strike, ...s.backupStrikes].map((k) => Math.round((k - basis) * 100) / 100);
      const parentId = `HTA:${ref.id}:${c.session}:${s.side}:${barTime}`;
      const candidate: FreshCandidate = {
        id: `${FRESH_PACK_VERSION}:${c.sourceEpoch}:${parentId}:${HTA_STRATEGY_ID}`, parentId, version: FRESH_PACK_VERSION, strategy: HTA_STRATEGY_ID as FreshCandidate['strategy'],
        direction: s.side, instrument: c.instrument, sourceEpoch: c.sourceEpoch, session: c.session, at: c.now, referenceEntry: s.entry, stop: s.stop, target: s.target, atr: s.atr15,
        expiresAt: Math.min(c.now + HTA_ENTRY_WINDOW_MS, c.sessionClose - 3_600_000), exitProfile: 'TARGET', origin: barTime, allowedStrikes: strikes,
        evidence: { hta: { ...s, optionStrikeOnChain: strikes[0], basis: Math.round(basis * 100) / 100 } },
      };
      let decision: string;
      try { decision = await this.deps.enter(candidate); } catch (err: any) { decision = err instanceof Error && /^[A-Z_]+$/.test(err.message) ? err.message : 'PAPER_PATH_FAILED'; }
      logger.info({ event: 'humanTaSignal', name: ref.name, side: s.side, pattern: s.pattern, score: s.score, entry: s.entry, stop: s.stop, target: s.target, rr: s.rr, option: { ...s.option, strike: strikes[0] }, lines: s.lines, decision }, 'Human TA: signal (paper only)');
      await (this.deps.alert ?? sendTelegramMessage)(htaAlertText(ref.name, { ...s, option: { ...s.option, strike: strikes[0] } }, decision)).catch(() => undefined);
      return decision;
    } catch (err: any) {
      logger.warn({ event: 'humanTa', name: ref.name, error: err?.message }, 'Human TA: evaluation failed (the scan is unaffected)');
      return null;
    }
  }
}
