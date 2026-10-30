import { FRESH_PACK_VERSION, FRESH_STRATEGIES, type FreshStrategy } from './strategies.js';
export interface FreshResult {
    strategy: FreshStrategy;
    version: string;
    session: string;
    state: string;
    netPnl: number | null;
    initialRisk: number;
}
/** Closed, observed quote-backed fills only; unresolved exits remain in the denominator report. */
export function freshPerformance(rows: readonly FreshResult[]) {
    return FRESH_STRATEGIES.map(strategy => {
        const cohort = rows.filter(x => x.version === FRESH_PACK_VERSION && x.strategy === strategy);
        const complete = cohort.filter(x => x.state === 'CLOSED' && x.netPnl != null && Number.isFinite(x.netPnl) && x.initialRisk > 0);
        const wins = complete.filter(x => x.netPnl! > 0), losses = complete.filter(x => x.netPnl! < 0), grossProfit = wins.reduce((s, x) => s + x.netPnl!, 0), grossLoss = -losses.reduce((s, x) => s + x.netPnl!, 0);
        const net = complete.reduce((s, x) => s + x.netPnl!, 0), sessions = new Set(complete.map(x => x.session)).size;
        const n = complete.length, p = n ? wins.length / n : 0, z = 1.959963984540054, den = 1 + z * z / (n || 1), center = (p + z * z / (2 * (n || 1))) / den, half = z * Math.sqrt(p * (1 - p) / (n || 1) + z * z / (4 * (n || 1) ** 2)) / den;
        return { strategy, filled: cohort.length, closed: n, pending: cohort.filter(x => x.state === 'EXIT_PENDING').length, open: cohort.filter(x => x.state === 'OPEN').length, unmeasured: cohort.length - complete.length - cohort.filter(x => x.state === 'OPEN' || x.state === 'EXIT_PENDING').length,
            wins: wins.length, losses: losses.length, flat: n - wins.length - losses.length, grossProfit, grossLoss, netPnl: n ? net : null, winRate: n ? p : null,
            winRate95: n ? [Math.max(0, center - half), Math.min(1, center + half)] as [
                number,
                number
            ] : null,
            expectancyR: n ? complete.reduce((s, x) => s + x.netPnl! / x.initialRisk, 0) / n : null,
            profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null, independentSessions: sessions,
            validation: 'NOT_VALIDATED' as const, minimumSampleMet: n >= 200 && sessions >= 60,
            note: 'Wilson interval is descriptive per-trade only; day-block bootstrap, untouched holdout and forward validation are still required.',
        };
    });
}
export type FreshPerformanceTotals = Pick<ReturnType<typeof freshPerformance>[number], 'strategy' | 'filled' | 'closed' | 'pending' | 'open' | 'unmeasured' | 'wins' | 'losses' | 'flat' | 'grossProfit' | 'grossLoss' | 'netPnl' | 'expectancyR' | 'independentSessions'>;
/** Database aggregation keeps the status response bounded as the measured cohort grows. */
export function freshPerformanceFromTotals(totals: readonly FreshPerformanceTotals[]) {
    return FRESH_STRATEGIES.map(strategy => {
        const empty = freshPerformance([]).find(x => x.strategy === strategy)!;
        const t = totals.find(x => x.strategy === strategy);
        if (!t)
            return empty;
        const n = t.closed, p = n ? t.wins / n : 0, z = 1.959963984540054, den = 1 + z * z / (n || 1), center = (p + z * z / (2 * (n || 1))) / den, half = z * Math.sqrt(p * (1 - p) / (n || 1) + z * z / (4 * (n || 1) ** 2)) / den;
        return { ...empty, ...t, winRate: n ? p : null, winRate95: n ? [Math.max(0, center - half), Math.min(1, center + half)] as [
                number,
                number
            ] : null, profitFactor: t.grossLoss > 0 ? t.grossProfit / t.grossLoss : null, minimumSampleMet: n >= 200 && t.independentSessions >= 60 };
    });
}
