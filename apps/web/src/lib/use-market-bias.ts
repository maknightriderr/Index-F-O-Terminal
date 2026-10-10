'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { FRESH_WITHIN_MS } from './freshness';
import type { BiasSnapshot, MarketBias, IntelligenceScore, TradeSetup, TradingMode, StructureBlock, SetupWatchRow, ReadOnlyMeta } from '@fno/shared';

const POLL_INTERVAL_MS = 60000;

const NO_SETUP: TradeSetup = { available: false, reason: 'No assessment has been recorded for this symbol yet.' };

/**
 * What the hook returns before any assessment exists for a symbol: a neutral, zero-confidence read carrying the
 * REQUESTED symbol. Consumers must check isLive / assessedAt before presenting direction, regime or score.
 */
export function placeholderBias(symbol: string): MarketBias {
  return {
    symbol,
    direction: 'NEUTRAL',
    bullishProbability: 0,
    bearishProbability: 0,
    neutralProbability: 100,
    confidence: 0,
    regime: 'RANGE_BOUND',
    reasoning: ['No assessment recorded yet.'],
    inputs: {},
    timestamp: 0,
  };
}

export function placeholderScore(symbol: string): IntelligenceScore {
  return {
    symbol,
    score: 0,
    trend: 0,
    priceAction: 0,
    futuresOi: 0,
    optionsOi: 0,
    pcr: 0,
    iv: 0,
    oiShifts: 0,
    volume: 0,
    relativeStrength: 0,
    technicals: 0,
    regime: 0,
    reasoning: [],
    timestamp: 0,
  };
}

export interface BiasState {
  bias: MarketBias;
  score: IntelligenceScore;
  tradeSetup: TradeSetup;
  structure: StructureBlock | null;
  setupWatch: SetupWatchRow[];
  /** The assessment is recent enough to treat as current (within the engine's re-read window). */
  isLive: boolean;
  /** When the assessment was made (epoch ms); null when there is none. */
  assessedAt: number | null;
  /** Where it came from: the engine's cached result, the last decision record, or nothing. */
  origin: 'ENGINE_CACHE' | 'LAST_DECISION_RECORD' | 'NONE';
  /** The read-only response's own source / age. */
  meta: ReadOnlyMeta | null;
  error: string | null;
}

/** Pure: a read-only snapshot as the state the dashboard cards render. Never invents values the snapshot lacks. */
export function biasStateFromSnapshot(symbol: string, snap: BiasSnapshot | null, meta: ReadOnlyMeta | null, now: number): BiasState {
  if (!snap) {
    return { bias: placeholderBias(symbol), score: placeholderScore(symbol), tradeSetup: NO_SETUP, structure: null, setupWatch: [], isLive: false, assessedAt: null, origin: 'NONE', meta, error: null };
  }
  const fresh = snap.assessedAt != null && now - snap.assessedAt <= FRESH_WITHIN_MS.bias;
  if (snap.origin === 'ENGINE_CACHE' && snap.result) {
    const r = snap.result as { bias: MarketBias; score: IntelligenceScore; tradeSetup: TradeSetup; structure?: StructureBlock; setupWatch?: SetupWatchRow[] };
    return { bias: r.bias, score: r.score, tradeSetup: r.tradeSetup, structure: r.structure ?? null, setupWatch: r.setupWatch ?? [], isLive: fresh, assessedAt: snap.assessedAt, origin: 'ENGINE_CACHE', meta, error: null };
  }
  // The last decision record carries only direction / confidence / regime: nothing else is invented.
  const bias: MarketBias = {
    ...placeholderBias(symbol),
    direction: snap.direction ?? 'NEUTRAL',
    confidence: snap.confidence ?? 0,
    regime: (snap.regime as MarketBias['regime']) ?? 'RANGE_BOUND',
    reasoning: snap.reason ? [`Last recorded decision: ${snap.reason}`] : ['Last recorded decision.'],
    timestamp: snap.assessedAt ?? 0,
  };
  return {
    bias,
    score: placeholderScore(symbol),
    tradeSetup: { available: false, reason: `Last recorded decision${snap.reason ? `: ${snap.reason}` : ''}. The live trade setup is not part of a decision record.` },
    structure: null,
    setupWatch: [],
    isLive: false,
    assessedAt: snap.assessedAt,
    origin: 'LAST_DECISION_RECORD',
    meta,
    error: null,
  };
}

// Module-level so a revisited symbol shows its last-known assessment instantly on switch.
const cache = new Map<string, BiasState>();
const keyOf = (symbol: string, exchange: string, mode: TradingMode) => `${exchange}:${symbol}:${mode}`;

/**
 * The last assessment of a symbol — market bias, regime, intelligence score and trade setup — READ-ONLY.
 *
 * It reads GET /api/market/bias-snapshot/:symbol, which returns what the engine already computed. It never runs the
 * engine: the old GET /api/market/bias/:symbol could mint a paper trade, write decision records and register the
 * symbol for background warming just because a page was open.
 *
 * `isLive` means the assessment is recent enough to treat as current; `assessedAt` and `origin` say exactly what is
 * on screen. The cards must show "as of <time>" when it is not live.
 */
export function useMarketBias(symbol: string, exchange: string, mode: TradingMode = 'INTRADAY'): BiasState {
  const [state, setState] = useState<BiasState>(() => cache.get(keyOf(symbol, exchange, mode)) ?? biasStateFromSnapshot(symbol, null, null, Date.now()));

  useEffect(() => {
    let cancelled = false;
    const key = keyOf(symbol, exchange, mode);
    setState(cache.get(key) ?? biasStateFromSnapshot(symbol, null, null, Date.now()));

    const read = async () => {
      try {
        const { data, meta } = await api.getBiasSnapshot(symbol, exchange, mode);
        if (cancelled) return;
        const next = biasStateFromSnapshot(symbol, data, meta ?? null, Date.now());
        cache.set(key, next);
        setState(next);
      } catch (err) {
        if (cancelled) return;
        // Keep the last assessment on screen, marked with the failure — never reset to a made-up value.
        setState((prev) => ({ ...prev, isLive: false, error: err instanceof Error ? err.message : 'Request failed' }));
      }
    };

    read();
    const interval = setInterval(read, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol, exchange, mode]);

  return state;
}
