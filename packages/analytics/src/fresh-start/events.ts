export interface FreshScheduledEvent {
    at: number;
    kind: 'INDEX_MACRO' | 'ISSUER_RESULTS';
    issuer: string | null;
    impact: 'HIGH' | 'OTHER';
    session: string;
}
/** The caller must verify the source and its coverage interval; an empty unknown calendar is never CLEAR. */
export function freshEventClearance(args: {
    now: number;
    session: string;
    market: 'INDEX' | 'STOCK';
    issuer: string | null;
    coverage: {
        verified: boolean;
        from: number;
        to: number;
        source: string;
    } | null;
    events: readonly FreshScheduledEvent[];
}): string | null {
    const c = args.coverage;
    if (!c?.verified || !c.source || ![args.now, c.from, c.to].every(Number.isFinite) || c.from > args.now - 900000 || c.to < args.now + 900000)
        return 'BLOCKED_EVENT_COVERAGE';
    for (const e of args.events) {
        if (!Number.isFinite(e.at))
            return 'BLOCKED_EVENT_COVERAGE';
        if (args.market === 'INDEX' && e.kind === 'INDEX_MACRO' && e.impact === 'HIGH' && Math.abs(args.now - e.at) <= 900000)
            return 'INDEX_EVENT_BLACKOUT';
        if (args.market === 'STOCK' && e.kind === 'ISSUER_RESULTS' && e.issuer === args.issuer && e.session === args.session)
            return 'ISSUER_RESULTS_DAY';
    }
    if (args.market === 'STOCK' && !args.issuer)
        return 'BLOCKED_ISSUER_MAPPING';
    return null;
}
