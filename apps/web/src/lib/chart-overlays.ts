// ============================================================
// CHART OVERLAYS — only what the recorded data really supports
// ============================================================
// Each overlay group states whether its data is available and, when not, WHY — it is never drawn from a guess or
// a placeholder. Levels come from the symbol's last recorded assessment (the same read-only snapshot the cards use):
//
//   OI_LEVELS        support / resistance from option-chain OI walls
//   VWAP             the volume-weighted average price the engine used
//   LIQUIDITY        the swept liquidity pool of a running structure lifecycle
//   STRUCTURE_ZONE   the fair-value-gap / displacement zone of a running lifecycle
//   SETUP_LEVELS     entry / stop / T1 of a CONFIRMED setup's option plan, as UNDERLYING prices
//   PAPER_TRADE      entry / stop / T1 of a lifecycle the live engine minted a paper trade from (underlying prices)
//   ORDER_BLOCK      NOT AVAILABLE: order-block zones are recorded for measurement only; no zone feed reaches the chart
//   ORDER_FLOW       NOT AVAILABLE: delta / POC / VAH / VAL are not exposed per bar; the feed status is shown instead
//
// A paper trade's OPTION premium levels cannot be drawn on an underlying price chart, so they are not.
// ============================================================

import type { SetupWatchRow, StructureBlock } from '@fno/shared';

export type OverlayGroup = 'OI_LEVELS' | 'VWAP' | 'LIQUIDITY' | 'STRUCTURE_ZONE' | 'SETUP_LEVELS' | 'PAPER_TRADE' | 'ORDER_BLOCK' | 'ORDER_FLOW';
export type OverlayTone = 'support' | 'resistance' | 'vwap' | 'liquidity' | 'zone' | 'entry' | 'stop' | 'target';

export interface ChartOverlayLine {
  id: string;
  group: OverlayGroup;
  price: number;
  label: string;
  tone: OverlayTone;
  dash: 'solid' | 'dashed' | 'dotted';
}

export interface OverlayGroupInfo {
  group: OverlayGroup;
  label: string;
  /** Whether recorded data exists for this group right now. */
  available: boolean;
  /** Why not, when unavailable. */
  reason: string | null;
  count: number;
  defaultOn: boolean;
}

export interface OverlayInputs {
  /** bias.inputs of the last assessment (supportLevels, resistanceLevels, vwap …). */
  inputs: Record<string, unknown>;
  structure: StructureBlock | null;
  setupWatch: readonly SetupWatchRow[];
  /** The order-flow feed's status from /api/health (CONNECTED / DISCONNECTED / DATA_PLAN_INACTIVE / NOT_CONFIGURED), when known. */
  orderFlowStatus?: string | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const levelsOf = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => (x as { strike?: number })?.strike).filter(finite) : []);

export const GROUP_LABEL: Record<OverlayGroup, string> = {
  OI_LEVELS: 'OI support / resistance',
  VWAP: 'VWAP',
  LIQUIDITY: 'Liquidity pool',
  STRUCTURE_ZONE: 'Structure zone (FVG)',
  SETUP_LEVELS: 'Confirmed setup levels',
  PAPER_TRADE: 'Paper trade levels',
  ORDER_BLOCK: 'Order block zones',
  ORDER_FLOW: 'Order flow (delta, POC, VAH, VAL)',
};

export function buildChartOverlays(i: OverlayInputs): { lines: ChartOverlayLine[]; groups: OverlayGroupInfo[] } {
  const lines: ChartOverlayLine[] = [];
  const add = (l: ChartOverlayLine) => {
    if (finite(l.price)) lines.push(l);
  };

  levelsOf(i.inputs.supportLevels).slice(0, 2).forEach((p, k) => add({ id: `sup${k}`, group: 'OI_LEVELS', price: p, label: k === 0 ? 'Support' : `Support ${k + 1}`, tone: 'support', dash: 'dashed' }));
  levelsOf(i.inputs.resistanceLevels).slice(0, 2).forEach((p, k) => add({ id: `res${k}`, group: 'OI_LEVELS', price: p, label: k === 0 ? 'Resistance' : `Resistance ${k + 1}`, tone: 'resistance', dash: 'dashed' }));
  if (finite(i.inputs.vwap)) add({ id: 'vwap', group: 'VWAP', price: i.inputs.vwap as number, label: 'VWAP', tone: 'vwap', dash: 'solid' });

  const lifecycles = i.structure ? [i.structure.current?.BULLISH, i.structure.current?.BEARISH].filter((l): l is NonNullable<typeof l> => !!l) : [];
  for (const l of lifecycles) {
    const side = l.direction === 'BULLISH' ? 'bull' : 'bear';
    if (l.pool) add({ id: `pool-${side}`, group: 'LIQUIDITY', price: l.pool.price, label: `${l.pool.kind} pool`, tone: 'liquidity', dash: 'dotted' });
    if (l.zone) {
      add({ id: `zone-near-${side}`, group: 'STRUCTURE_ZONE', price: l.zone.near, label: `${l.zone.kind === 'FVG' ? 'FVG' : 'Zone'} near`, tone: 'zone', dash: 'dashed' });
      add({ id: `zone-far-${side}`, group: 'STRUCTURE_ZONE', price: l.zone.far, label: `${l.zone.kind === 'FVG' ? 'FVG' : 'Zone'} far`, tone: 'zone', dash: 'dashed' });
    }
    if (l.liveOutcome === 'MINTED') {
      add({ id: `pt-entry-${side}`, group: 'PAPER_TRADE', price: l.entry ?? NaN, label: 'Paper entry', tone: 'entry', dash: 'solid' });
      add({ id: `pt-stop-${side}`, group: 'PAPER_TRADE', price: l.stop ?? NaN, label: 'Paper stop', tone: 'stop', dash: 'solid' });
      add({ id: `pt-t1-${side}`, group: 'PAPER_TRADE', price: l.t1?.price ?? NaN, label: 'Paper T1', tone: 'target', dash: 'solid' });
    }
  }
  for (const r of i.setupWatch) {
    if (r.status !== 'CONFIRMED' || !r.plan) continue;
    add({ id: `sw-entry-${r.id}`, group: 'SETUP_LEVELS', price: r.plan.underlyingEntry, label: `${r.source} entry`, tone: 'entry', dash: 'dotted' });
    add({ id: `sw-stop-${r.id}`, group: 'SETUP_LEVELS', price: r.plan.underlyingSl ?? NaN, label: `${r.source} stop`, tone: 'stop', dash: 'dotted' });
    add({ id: `sw-t1-${r.id}`, group: 'SETUP_LEVELS', price: r.plan.underlyingT1 ?? NaN, label: `${r.source} T1`, tone: 'target', dash: 'dotted' });
  }

  const count = (g: OverlayGroup) => lines.filter((l) => l.group === g).length;
  const recorded = (g: OverlayGroup, reason: string, defaultOn: boolean): OverlayGroupInfo => ({ group: g, label: GROUP_LABEL[g], available: count(g) > 0, reason: count(g) > 0 ? null : reason, count: count(g), defaultOn });
  const flow = i.orderFlowStatus;
  const flowReason = !flow
    ? 'Per-bar order flow is not exposed to the chart, and the feed status is unknown.'
    : flow === 'CONNECTED'
      ? 'The feed is connected, but per-bar delta, POC, VAH and VAL are not exposed to the chart. Delta here would be inferred, not exchange delta.'
      : `Order-flow feed ${flow.replace(/_/g, ' ').toLowerCase()}; no data to draw.`;

  const groups: OverlayGroupInfo[] = [
    recorded('OI_LEVELS', 'No option-chain OI walls in the last assessment.', true),
    recorded('VWAP', 'The last assessment carries no VWAP.', true),
    recorded('LIQUIDITY', 'No running structure lifecycle for this symbol.', false),
    recorded('STRUCTURE_ZONE', 'No running structure zone for this symbol.', false),
    recorded('SETUP_LEVELS', 'No confirmed setup with an option plan for this symbol.', true),
    recorded('PAPER_TRADE', 'No paper trade with recorded underlying levels for this symbol. (A paper trade\'s option premium levels cannot be drawn on an underlying price chart.)', true),
    { group: 'ORDER_BLOCK', label: GROUP_LABEL.ORDER_BLOCK, available: false, reason: 'Order-block zones are recorded for measurement only; no per-symbol zone feed reaches the chart. See Signal Diagnostics for their lifecycle.', count: 0, defaultOn: false },
    { group: 'ORDER_FLOW', label: GROUP_LABEL.ORDER_FLOW, available: false, reason: flowReason, count: 0, defaultOn: false },
  ];
  return { lines, groups };
}

/** Pure: the lines of the groups currently switched on. */
export function visibleOverlayLines(lines: readonly ChartOverlayLine[], enabled: ReadonlySet<OverlayGroup>): ChartOverlayLine[] {
  return lines.filter((l) => enabled.has(l.group));
}
