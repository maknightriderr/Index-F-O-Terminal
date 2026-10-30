export interface FreshSourceObservation {
    contract: string;
    source: string;
    epoch: string;
    eventAt: number;
    receivedAt: number;
    mid: number;
    tick: number;
}
export interface FreshSourceState {
    primary: string;
    epoch: string;
    consecutiveConflicts: number;
    blocked: boolean;
    healthySince: number | null;
}
/** Secondary data can detect trouble but can never silently become entry authority. */
export function reconcileFreshSources(s: FreshSourceState, primary: FreshSourceObservation | null, secondary: FreshSourceObservation | null, now: number): FreshSourceState {
    if (!primary || primary.source !== s.primary || primary.epoch !== s.epoch || ![now, primary.eventAt, primary.receivedAt, primary.mid, primary.tick].every(Number.isFinite) || primary.mid <= 0 || primary.tick <= 0 || primary.eventAt > primary.receivedAt || primary.receivedAt > now || now - primary.eventAt > 2000)
        return { ...s, blocked: true, healthySince: null };
    if (!secondary)
        return { ...s, blocked: true, healthySince: null }; // Cross-source qualification is incomplete.
    if (secondary.contract !== primary.contract || secondary.source === primary.source || ![secondary.eventAt, secondary.receivedAt, secondary.mid, secondary.tick].every(Number.isFinite) || secondary.mid <= 0 || secondary.tick <= 0 || secondary.eventAt > secondary.receivedAt || secondary.receivedAt > now || now - secondary.eventAt > 2000 || Math.abs(primary.eventAt - secondary.eventAt) > 1000)
        return { ...s, blocked: true, healthySince: null };
    const conflict = Math.abs(primary.mid - secondary.mid) > Math.max(.005 * primary.mid, 2 * Math.max(primary.tick, secondary.tick));
    if (conflict) {
        const n = s.consecutiveConflicts + 1;
        return { ...s, consecutiveConflicts: n, blocked: s.blocked || n >= 3, healthySince: null };
    }
    const healthySince = s.healthySince ?? now;
    return { ...s, consecutiveConflicts: 0, healthySince, blocked: s.blocked && now - healthySince < 60000 };
}
