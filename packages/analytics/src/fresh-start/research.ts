import { FRESH_PACK_VERSION, type FreshStrategy } from './strategies.js';
export interface FreshResearchTrade {
    id: string;
    strategy: FreshStrategy;
    version: string;
    session: string;
    entryAt: number;
    exitAt: number;
    netPnl: number;
    initialRisk: number;
}
export interface FreshDatasetManifest {
    id: string;
    frozenAt: number;
    parametersFrozenAt: number;
    developmentEnd: number;
    validationEnd: number;
    holdoutEnd: number;
    holdoutInspected: boolean;
    evidence: 'SIGNAL_ONLY' | 'MODELED_FILL' | 'OBSERVED_QUOTE_BACKTEST';
    fixedContractQuotes: boolean;
    pointInTimeUniverse: boolean;
    costsVerified: boolean;
    calendarsVerified: boolean;
}
/** Fixed chronological boundaries. Does not randomly shuffle samples or silently reuse an inspected holdout. */
export function partitionFreshResearch(trades: readonly FreshResearchTrade[], m: FreshDatasetManifest) {
    if (![m.frozenAt, m.parametersFrozenAt, m.developmentEnd, m.validationEnd, m.holdoutEnd].every(Number.isFinite) || m.developmentEnd >= m.validationEnd || m.validationEnd >= m.holdoutEnd || m.parametersFrozenAt > m.validationEnd || m.frozenAt > m.validationEnd)
        throw Error('INVALID_FROZEN_RESEARCH_PROTOCOL');
    if (m.holdoutInspected)
        throw Error('HOLDOUT_ALREADY_INSPECTED');
    const ids = new Set<string>();
    for (const t of trades) {
        if (ids.has(t.id) || t.version !== FRESH_PACK_VERSION || ![t.entryAt, t.exitAt, t.netPnl, t.initialRisk].every(Number.isFinite) || t.initialRisk <= 0 || t.entryAt >= t.exitAt)
            throw Error('INVALID_OR_MIXED_COHORT');
        ids.add(t.id);
    }
    // Boundary-crossing positions are excluded explicitly; a train-period entry cannot leak its holdout outcome.
    return { development: trades.filter(t => t.exitAt <= m.developmentEnd), validation: trades.filter(t => t.entryAt > m.developmentEnd && t.exitAt <= m.validationEnd), holdout: trades.filter(t => t.entryAt > m.validationEnd && t.exitAt <= m.holdoutEnd), crossBoundary: trades.filter(t => (t.entryAt <= m.developmentEnd && t.exitAt > m.developmentEnd) || (t.entryAt <= m.validationEnd && t.exitAt > m.validationEnd)), afterProtocol: trades.filter(t => t.exitAt > m.holdoutEnd) };
}
/** Day-block resampling preserves all within-day dependence. Seed and sample budget are frozen, reproducible inputs. */
export function freshDayBootstrap(trades: readonly FreshResearchTrade[], seed = 1731, repeats = 2000) {
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(repeats) || repeats < 100 || repeats > 10000)
        throw Error('INVALID_BOOTSTRAP_BUDGET');
    const days = new Map<string, {
        sum: number;
        n: number;
    }>();
    for (const t of trades) {
        if (!Number.isFinite(t.netPnl) || !Number.isFinite(t.initialRisk) || t.initialRisk <= 0)
            throw Error('UNMEASURED_TRADE');
        const d = days.get(t.session) ?? { sum: 0, n: 0 };
        d.sum += t.netPnl / t.initialRisk;
        d.n++;
        days.set(t.session, d);
    }
    if (days.size < 2)
        return null;
    const a = [...days.values()];
    let state = seed >>> 0;
    const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
    const estimates = Array.from({ length: repeats }, () => {
        let sum = 0, n = 0;
        for (let i = 0; i < a.length; i++) {
            const d = a[Math.floor(random() * a.length)];
            sum += d.sum;
            n += d.n;
        }
        return sum / n;
    }).sort((a, b) => a - b);
    return { lower: estimates[Math.floor(.025 * (repeats - 1))], upper: estimates[Math.ceil(.975 * (repeats - 1))], sessions: a.length, seed, repeats, method: 'DAY_BLOCK_NET_R' as const };
}
export function freshValidationGate(args: {
    trades: readonly FreshResearchTrade[];
    strategy: FreshStrategy;
    manifest: FreshDatasetManifest;
    equityPath: readonly {
        at: number;
        equity: number;
    }[];
    unresolved: number;
    forwardTrades: number;
    forwardSessions: number;
}) {
    const blockers: string[] = [];
    const { manifest: m } = args;
    const split = partitionFreshResearch(args.trades, m), sample = split.holdout.filter(t => t.strategy === args.strategy);
    if (m.evidence !== 'OBSERVED_QUOTE_BACKTEST' || !m.fixedContractQuotes)
        blockers.push('INSUFFICIENT_EXECUTION_EVIDENCE');
    if (!m.pointInTimeUniverse || !m.costsVerified || !m.calendarsVerified)
        blockers.push('DATASET_CAPABILITY_UNVERIFIED');
    const ci = freshDayBootstrap(sample), sessions = new Set(sample.map(t => t.session)).size;
    if (sample.length < 200 || sessions < 60)
        blockers.push('HISTORICAL_SAMPLE_TOO_SMALL');
    if (!ci || ci.lower <= 0)
        blockers.push('EXPECTANCY_LOWER_BOUND_NOT_POSITIVE');
    const profit = sample.reduce((s, t) => s + Math.max(0, t.netPnl), 0), loss = -sample.reduce((s, t) => s + Math.min(0, t.netPnl), 0);
    const pf = loss > 0 ? profit / loss : null;
    if (pf == null || pf < 1.2)
        blockers.push('PROFIT_FACTOR_UNPROVEN');
    let high = 0, drawdown = 0;
    if (args.equityPath.length < 2 || args.equityPath.some((e, i) => !Number.isFinite(e.equity) || e.equity <= 0 || !Number.isFinite(e.at) || (i > 0 && e.at <= args.equityPath[i - 1].at)))
        blockers.push('EQUITY_PATH_UNAVAILABLE');
    else
        for (const e of args.equityPath) {
            high = Math.max(high, e.equity);
            drawdown = Math.max(drawdown, (high - e.equity) / high);
        }
    if (drawdown > .05)
        blockers.push('DRAWDOWN_LIMIT');
    if (args.unresolved !== 0)
        blockers.push('UNRESOLVED_EXECUTION');
    if (args.forwardTrades < 100 || args.forwardSessions < 30)
        blockers.push('FORWARD_SAMPLE_TOO_SMALL');
    return { strategy: args.strategy, sample: sample.length, sessions, expectancy95: ci, profitFactor: pf, maxDrawdown: drawdown, blockers, promoted: false, eligibleForHumanReview: blockers.length === 0 };
}
