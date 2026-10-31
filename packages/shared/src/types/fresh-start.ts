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
    calendarSchemaReady?:boolean;
    eventSources?:{macro:{source:string;status:string;configured:boolean;coverageConfirmed:boolean;fetchedAt:number|null;expiresAt:number|null;snapshotId:string|null;nextAttemptAt:number;eventCount:number|null};issuer:{failureCode?:string|null;source:string;status:string;fetchedAt:number|null;expiresAt:number|null;snapshotId:string|null;nextAttemptAt:number;responseCounts:{events:number;meetings:number;actions:number}|null}|null}|null;
    marketReadiness?:Array<{market:string;universe:number;selected:number;references:number;optionContracts:number;observedExecutableBooks:number;eligibleReferences:number;sessionOpen:boolean;blockers:string[]}>;
    discovery?:{at:number|null;totalReferences:number;unmapped:number;selected:number;historyCache:number;historyLimit:number;historyRequestsPerCycle:number;subscriptionLimit:number;windowMinutes:number};
    requiredEventConfiguration?:string[];
    engineConfigured?:boolean;
    adapterSchemaReady?:boolean;
    brokeragePerOrder?:number;
    adapterDecisions?:Array<{candidate_id:string;at:string;strategy:string;code:string}>;
    evaluations?:Array<{id:string;at:string;instrument:string;session:string;refusals:unknown}>;
    activationRequested:boolean;
    activationApproved:boolean;
    feedQualification:{status:string;lastCheckAt:number|null;sourceEpoch:string|null;referenceContracts:number;optionContracts:number;observedExecutableBooks:number;error:string|null;scope?:string[];monitorRunning?:boolean;recovered?:boolean;entriesArmed?:boolean;barCallbacks?:number;lastDecision?:string|null;eventCode?:string};
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
