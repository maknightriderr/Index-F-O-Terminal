// Dhan order-flow engine v2 columns of the setup radar (9 Nov): each contract's latest setup A-D outcome today, from
// GET /api/diagnostics/order-flow/engine/signals (status.latest). Refreshed every minute; absent = not evaluated
// (no Dhan futures contract for that instrument, or no closed 15-minute bar yet today).
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface DhanRadarCell { status: string; side: string | null; failed: string | null; passed: number; score: number | null }
export type DhanRadarLatest = Record<string, { at: number; day: string; setups: Record<string, DhanRadarCell> }>;

export const DHAN_RADAR_SETUPS = [
  { key: 'A', header: 'Dhan A · sweep + absorption' },
  { key: 'B', header: 'Dhan B · imbalance breakout' },
  { key: 'C', header: 'Dhan C · failed auction + CVD' },
  { key: 'D', header: 'Dhan D · VWAP / profile' },
] as const;

/** "A3_SELLING_AGGRESSION_UP" -> "A3 selling aggression up". */
export const dhanCheckLabel = (id: string) => {
  const m = /^([A-D]\d+(?:_[A-D]\d+)*)_(.*)$/.exec(id);
  return m ? `${m[1]} ${m[2].replace(/_/g, ' ').toLowerCase()}` : id.replace(/_/g, ' ').toLowerCase();
};

export function dhanCellText(c: DhanRadarCell | undefined): { text: string; tone: 'ok' | 'warn' | null } {
  if (!c) return { text: '—', tone: null };
  if (c.status === 'SIGNAL') return { text: `SIGNAL ${c.side === 'BEARISH' ? 'bear' : 'bull'}${c.score != null ? ` ${c.score}/10` : ''}`, tone: 'ok' };
  if (c.status === 'NO_TRADE') return { text: `Rejected: ${dhanCheckLabel(c.failed ?? 'gates')}`, tone: 'warn' };
  return { text: c.failed ? `Stopped at ${dhanCheckLabel(c.failed)}` : 'No setup', tone: null };
}

export function useDhanRadar(): DhanRadarLatest {
  const [latest, setLatest] = useState<DhanRadarLatest>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => { try { void api.getDhanEngineSignals().then((r) => { if (!cancelled) setLatest((r.status as { latest?: DhanRadarLatest }).latest ?? {}); }).catch(() => undefined); } catch { /* the radar's other columns do not depend on it */ } };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return latest;
}
