import { LIQUID_SPREAD_MAX_PCT, type FnoScannerRow, type Instrument } from '@fno/shared';
import { FRESH_WITHIN_MS } from './freshness';

export interface RadarUniverseItem { symbol: string; exchange: string }
/** Use the newest row per symbol; never count derivatives or duplicate rows as extra stocks. */
export function buildRadar(rows: readonly FnoScannerRow[], universe: readonly RadarUniverseItem[] | null, now: number, sessionOpen: boolean) {
  const symbols = universe == null ? null : new Set(universe.filter(r => r.exchange === 'NSE').map(r => r.symbol));
  const latest = new Map<string, FnoScannerRow>();
  for (const row of rows) {
    if (row.exchange !== 'NSE' || (symbols && !symbols.has(row.symbol))) continue;
    if (!latest.has(row.symbol) || row.timestamp > latest.get(row.symbol)!.timestamp) latest.set(row.symbol, row);
  }
  const usable = [...latest.values()].filter(r => Number.isFinite(r.price) && r.price > 0 && Number.isFinite(r.timestamp) && r.timestamp > 0 && r.timestamp <= now + 60_000 && ['BULLISH','BEARISH','NEUTRAL'].includes(r.direction) && (!sessionOpen || now - r.timestamp <= FRESH_WITHIN_MS.scan));
  const bullish = usable.filter(r => r.direction === 'BULLISH');
  const bearish = usable.filter(r => r.direction === 'BEARISH');
  const neutral = usable.filter(r => r.direction === 'NEUTRAL');
  // Screening shortlist, NOT setup readiness. No invented trigger/stop/target or win probability.
  const rank = (list: FnoScannerRow[], sign: number) => list.filter(r => Number.isFinite(r.score) && Number.isFinite(r.relativeStrength) && r.relativeStrength * sign > 0 && r.atmSpreadPct != null && Number.isFinite(r.atmSpreadPct) && r.atmSpreadPct >= 0 && r.atmSpreadPct <= LIQUID_SPREAD_MAX_PCT)
    .sort((a,b) => sign*(b.score-a.score) || sign*(b.relativeStrength-a.relativeStrength) || a.symbol.localeCompare(b.symbol)).slice(0,10);
  const total = symbols?.size ?? null;
  return { total, observed: latest.size, bullish: bullish.length, bearish: bearish.length, neutral: neutral.length, unavailable: total == null ? null : total-usable.length, bull: rank(bullish,1), bear: rank(bearish,-1) };
}

/** Exact cash instrument only; never substitute a derivative or similarly named equity. */
export function equityChartToken(instruments: readonly Instrument[], symbol: string, exchange: string): string | null {
  return instruments.find(i => i.exchange === exchange && i.segment === 'CM' && i.instrumentType === 'EQ' && (i.symbol === symbol || i.symbol === `${symbol}-EQ`))?.token ?? null;
}
