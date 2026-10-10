// ============================================================
// BEST SETUPS — one list from the records the system already keeps
// ============================================================
// Candidates come from two existing, read-only sources:
//   * the market scan (stock candidates scored by the Indicator Engine, plus the movers it declined, with its reason)
//   * the structure watchlist (S1 and routed trigger lifecycles, with what the live engine did at the fill)
// Nothing here scores, ranks by a new rule, or builds a trade: it maps recorded fields to display fields.
//
// DECISION STATE is taken only from recorded evidence:
//   LIVE_PAPER_ELIGIBLE  the family's live stage is ACTIVE / PAPER_RESEARCH (or it is the Indicator Engine) and nothing
//                        refused it, or the engine already minted a paper trade from it
//   SHADOW_ONLY          the family's live stage is SHADOW: measured only, it can never create a paper trade
//   REJECTED             the scan declined it, a gate refused it (liveOutcome REFUSED / a block code), or it was invalidated
//   UNAVAILABLE          retired or unknown family, or too little recorded to say
// A reason is shown only when the record carries one; none is invented.
// ============================================================

import type { MarketScanResult, ScannedCandidate, StructureLifecycleView } from '@fno/shared';
import type { DecisionState } from '@/components/ui/status-badge';

export type SetupSource = 'MARKET_SCAN' | 'STRUCTURE' | 'DECLINED';

export interface SetupRow {
  id: string;
  source: SetupSource;
  symbol: string;
  exchange: string;
  family: string;
  familyLabel: string;
  direction: 'BULLISH' | 'BEARISH';
  /** Market regime / trend context recorded with the candidate; null when none. */
  regime: string | null;
  /** Planned levels as recorded (option premium for a scan candidate; underlying for a structure lifecycle). */
  levels: { basis: 'OPTION_PREMIUM' | 'UNDERLYING' | 'NONE'; entry: number | null; stop: number | null; target: number | null };
  rewardRisk: number | null;
  /** Estimated round-trip cost, % of premium, as recorded; null when none. */
  estimatedCostPct: number | null;
  score: number | null;
  stage: string | null;
  evidence: string[];
  concern: string | null;
  decision: DecisionState;
  decisionReason: string | null;
  /** When the underlying record was made (epoch ms). */
  observedAt: number | null;
}

export type StageMap = Record<string, string>;

/** The family a structure lifecycle belongs to: routed triggers carry it in their id (…:MP:A3:…), everything else is S1. */
export function familyOfLifecycle(id: string): string {
  const m = /:MP:([A-Z][0-9]):/.exec(id);
  return m ? m[1] : 'S1';
}

const FAMILY_LABEL = (family: string): string => (family === 'S1' ? 'Structure S1' : family === 'INDICATOR' ? 'Indicator Engine' : /^[A-F][0-9]$/.test(family) ? `Trigger ${family}` : family);

/** Pure: a family's stage, as the registry reports it (INDICATOR is the live consensus engine). */
function stageOf(family: string, stages: StageMap): string | null {
  if (family === 'INDICATOR') return 'ACTIVE';
  return stages[family] ?? null;
}

function decisionFromStage(stage: string | null): { state: DecisionState; reason: string | null } {
  switch (stage) {
    case 'ACTIVE':
    case 'PAPER_RESEARCH':
      return { state: 'LIVE_PAPER_ELIGIBLE', reason: null };
    case 'SHADOW':
      return { state: 'SHADOW_ONLY', reason: 'This family is measured only; it cannot create a paper trade.' };
    case 'RETIRED':
      return { state: 'UNAVAILABLE', reason: 'This family is retired.' };
    default:
      return { state: 'UNAVAILABLE', reason: 'The live stage of this family is not recorded.' };
  }
}

export function setupFromCandidate(c: ScannedCandidate, scan: Pick<MarketScanResult, 'marketTrend' | 'scannedAt'>): SetupRow {
  const ts = c.tradeSetup;
  const entry = ts.entry ?? null;
  const stop = ts.stopLoss ?? null;
  const target = ts.target ?? null;
  const available = ts.available === true;
  return {
    id: `scan:${c.exchange}:${c.symbol}:${c.side}`,
    source: 'MARKET_SCAN',
    symbol: c.symbol,
    exchange: c.exchange,
    family: 'INDICATOR',
    familyLabel: FAMILY_LABEL('INDICATOR'),
    direction: c.side === 'CE' ? 'BULLISH' : 'BEARISH',
    regime: scan.marketTrend?.trend ?? null,
    levels: { basis: available ? 'OPTION_PREMIUM' : 'NONE', entry, stop, target },
    rewardRisk: ts.riskReward ?? null,
    estimatedCostPct: ts.estimatedCostPct ?? null,
    score: c.score,
    stage: c.tier,
    evidence: (c.reasoning ?? []).slice(0, 4),
    concern: available ? null : ts.reason ?? null,
    decision: available ? 'LIVE_PAPER_ELIGIBLE' : 'REJECTED',
    decisionReason: available ? null : ts.reason ?? 'The engine refused this setup; no reason was recorded.',
    observedAt: scan.scannedAt ?? null,
  };
}

export function setupFromDeclined(d: MarketScanResult['declined'][number], scan: Pick<MarketScanResult, 'marketTrend' | 'scannedAt'>): SetupRow {
  return {
    id: `declined:${d.exchange}:${d.symbol}:${d.direction}`,
    source: 'DECLINED',
    symbol: d.symbol,
    exchange: d.exchange,
    family: 'INDICATOR',
    familyLabel: FAMILY_LABEL('INDICATOR'),
    direction: d.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH',
    regime: scan.marketTrend?.trend ?? null,
    levels: { basis: 'NONE', entry: null, stop: null, target: null },
    rewardRisk: null,
    estimatedCostPct: null,
    score: null,
    stage: 'DECLINED',
    evidence: [],
    concern: d.reason,
    decision: 'REJECTED',
    decisionReason: d.reason,
    observedAt: scan.scannedAt ?? null,
  };
}

export function setupFromLifecycle(l: StructureLifecycleView, stages: StageMap): SetupRow {
  const family = familyOfLifecycle(l.id);
  const base = decisionFromStage(stageOf(family, stages));
  let state = base.state;
  let reason = base.reason;
  if (l.liveOutcome === 'MINTED') {
    state = 'LIVE_PAPER_ELIGIBLE';
    reason = 'The live engine minted a paper trade from this setup.';
  } else if (l.liveOutcome === 'REFUSED') {
    state = 'REJECTED';
    reason = l.liveReason ?? 'The live engine refused it; no reason was recorded.';
  } else if (['INVALIDATED', 'MISSED', 'LATE', 'LOW_RR', 'CLOSED'].includes(l.stage)) {
    // A lifecycle that ended is not a candidate any more; its recorded reason is shown.
    state = state === 'SHADOW_ONLY' ? 'SHADOW_ONLY' : 'REJECTED';
    reason = l.reason ?? `The setup ended (${l.stage}).`;
  }
  const preview = l.preview && l.preview.available ? l.preview : null;
  return {
    id: `structure:${l.id}`,
    source: 'STRUCTURE',
    symbol: l.symbol,
    exchange: l.exchange,
    family,
    familyLabel: FAMILY_LABEL(family),
    direction: l.direction,
    regime: null,
    levels: preview
      ? { basis: 'OPTION_PREMIUM', entry: preview.estEntryPremium ?? null, stop: preview.estStopLossPremium ?? null, target: preview.estTargetPremium ?? null }
      : { basis: 'UNDERLYING', entry: l.entry, stop: l.stop, target: l.t1?.price ?? null },
    rewardRisk: preview?.riskReward ?? l.rToT1 ?? null,
    estimatedCostPct: null,
    score: l.score,
    stage: l.stage,
    evidence: [l.pool ? `Liquidity pool ${l.pool.kind} swept` : null, l.zone ? `${l.zone.kind === 'FVG' ? 'Fair-value gap' : 'Displacement 50%'} zone` : null, l.timeframe ? `${l.timeframe} timeframe` : null].filter((x): x is string => !!x),
    concern: state === 'REJECTED' ? reason : l.preview && !l.preview.available ? l.preview.reason ?? 'The option trade preview is not available right now.' : null,
    decision: state,
    decisionReason: reason,
    observedAt: l.stageAt ?? null,
  };
}

/** Pure: every candidate the recorded sources hold, best-scored first within each decision state's priority. */
export function buildSetupRows(scan: MarketScanResult | null, watchlist: readonly StructureLifecycleView[], stages: StageMap): SetupRow[] {
  const rows: SetupRow[] = [];
  if (scan) {
    for (const c of scan.candidates ?? []) rows.push(setupFromCandidate(c, scan));
    for (const c of scan.stockSpecificMovers ?? []) rows.push({ ...setupFromCandidate(c, scan), id: `scan-specific:${c.exchange}:${c.symbol}:${c.side}`, evidence: ['Stock-specific mover (not aligned with the broader market read)', ...(c.reasoning ?? []).slice(0, 3)] });
    for (const d of scan.declined ?? []) rows.push(setupFromDeclined(d, scan));
  }
  for (const l of watchlist) rows.push(setupFromLifecycle(l, stages));
  const priority: Record<DecisionState, number> = { LIVE_PAPER_ELIGIBLE: 0, SHADOW_ONLY: 1, REJECTED: 2, UNAVAILABLE: 3 };
  return rows.sort((a, b) => priority[a.decision] - priority[b.decision] || (b.score ?? -1) - (a.score ?? -1) || a.symbol.localeCompare(b.symbol));
}

export interface SetupFilters {
  exchange: string;
  family: string;
  direction: '' | 'BULLISH' | 'BEARISH';
  status: '' | DecisionState;
  query: string;
}
export const DEFAULT_SETUP_FILTERS: SetupFilters = { exchange: '', family: '', direction: '', status: '', query: '' };

export function filterSetups(rows: readonly SetupRow[], f: SetupFilters): SetupRow[] {
  const q = f.query.trim().toUpperCase();
  return rows.filter((r) => (!f.exchange || r.exchange === f.exchange) && (!f.family || r.family === f.family) && (!f.direction || r.direction === f.direction) && (!f.status || r.decision === f.status) && (!q || r.symbol.includes(q)));
}
