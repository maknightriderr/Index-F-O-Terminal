export interface FreshStrategyPerformance {
    strategy: string;
    filled: number;
    closed: number;
    pending: number;
    open: number;
    unmeasured: number;
    wins: number;
    losses: number;
    flat: number;
    grossProfit: number;
    grossLoss: number;
    netPnl: number | null;
    winRate: number | null;
    winRate95: [
        number,
        number
    ] | null;
    expectancyR: number | null;
    profitFactor: number | null;
    independentSessions: number;
    validation: 'NOT_VALIDATED';
    minimumSampleMet: boolean;
    note: string;
}
export interface FreshStartStatus {
    version: string;
    implementationApproved: boolean;
    enabled: boolean;
    legacyNewEntries: boolean;
    legacyExitsPreserved: boolean;
    liveOrdersAllowed: boolean;
    schemaReady: boolean;
    capital: number | null;
    blockers: string[];
    capabilities: Array<{
        id: string;
        status: string;
    }>;
    strategies: Array<{
        id: string;
        enabled: boolean;
    }>;
    performance: FreshStrategyPerformance[];
    positions: Array<{
        strategy: string;
        version: string;
        session: string;
        status: string;
        state: unknown;
    }>;
    positionsTruncated: boolean;
    candidates: Array<{
        id: string;
        at: string;
        strategy: string;
        decision: string;
        code: string | null;
        evidence: unknown;
    }>;
    reviews: Array<{
        position_id: string;
        status: string;
        response: {
            text: string;
            explanationOnly: boolean;
        } | null;
        completed_at: string | null;
    }>;
    evidence: string;
    performanceValidated: boolean;
}
