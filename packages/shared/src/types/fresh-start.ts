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
export interface FreshSessionEvidence {
    version:string;scope:'LATEST_100_CURRENT_VERSION';sampled:number;sampleTruncated:boolean;unclassified:number;note:string;
    markets:Array<{market:string;sampled:number;consistentSessionClosed:number}>;
    cohorts:Array<{market:string;strategy:string;policyId:string;evidenceClass:string;sampled:number;entryOnly:number;pending:number;closed:number;incomplete:number;inconsistent:number;sessionTimingUnproven:number;consistentSessionClosed:number;sessions:string[]}>;
}
export interface FreshResearchReadiness {
    observedAt:number;sources:Array<{table:string;evidence:string;limit:string;available:boolean;hasRows:boolean;estimatedRows:number|null}>;
    protocol:{id:string;digest:string;version:string;registered:boolean;registeredAt:string|null;captureStart:string;developmentEnd:string;validationEnd:string;holdoutEnd:string;holdoutBlindnessEnforced:boolean;note:string};
    blockers:string[];note:string;
}
export interface FreshStartStatus {
    research?:FreshResearchReadiness|null;
    sessionEvidence?:FreshSessionEvidence;
    integrity?:{version:string;scope:'LATEST_100_CURRENT_VERSION';sampled:number;sampleTruncated:boolean;consistent:number;incomplete:number;inconsistent:number;closedChecked:number;note:string;rows:Array<{id:string;contract:string;positionStatus:string;verdict:'CONSISTENT'|'INCOMPLETE'|'INCONSISTENT';phase:'ENTRY_ONLY'|'EXIT_PENDING'|'CLOSED';eventEvidenceClass:string;issues:string[];missing:string[]}>};
    eventPolicy?:{id:string;allowMissingMacroCoverage:boolean;approval?:string;liveOrdersAllowed?:boolean};
    eventCohorts?:Array<{policyId:string;evidenceClass:string;performance:FreshStrategyPerformance[]}>;
    calendarSchemaReady?:boolean;
    eventSources?:{freeGlobal?:{source:string;status:string;failureCode:string|null;snapshotId:string|null;fetchedAt:number|null;expiresAt:number|null;nextAttemptAt:number;nextReleaseAt:number|null;eventCount:number|null;completeMacroCoverage:boolean}|null;officialMacro?:Array<{source:string;status:string;failureCode:string|null;snapshotId:string|null;fetchedAt:number|null;expiresAt:number|null;nextAttemptAt:number;nextReleaseAt:number|null;nextEventDay:string|null;eventCount:number|null;completeMacroCoverage:boolean}>;publicMacro?:{source:string;status:string;failureCode:string|null;snapshotId:string|null;fetchedAt:number|null;expiresAt:number|null;nextAttemptAt:number;nextReleaseAt:number|null;eventCount:number|null;completeMacroCoverage:boolean}|null;commodity?:Array<{product:string;source:string;status:string;failureCode?:string|null;snapshotId:string|null;fetchedAt:number|null;expiresAt:number|null;nextReleaseAt:number|null;nextAttemptAt:number;completeCommodityCoverage:boolean}>;macro:{source:string;status:string;configured:boolean;coverageConfirmed:boolean;fetchedAt:number|null;expiresAt:number|null;snapshotId:string|null;nextAttemptAt:number;eventCount:number|null};issuer:{failureCode?:string|null;source:string;status:string;fetchedAt:number|null;expiresAt:number|null;snapshotId:string|null;nextAttemptAt:number;responseCounts:{events:number;meetings:number;actions:number}|null}|null}|null;
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
    feedQualification:{status:string;lastCheckAt:number|null;sourceEpoch:string|null;referenceContracts:number;optionContracts:number;observedExecutableBooks:number;error:string|null;scope?:string[];monitorRunning?:boolean;recovered?:boolean;entriesArmed?:boolean;barCallbacks?:number;
    /** Latest executable quote per held position id (display only; exits use the monitor's own observations). */
    marks?:Record<string,{bid:number;ask:number;at:number;underlying:number|null}>;
    /** MCX book depth unit inferred per product from the live book (LOTS / UNITS / UNKNOWN, with its evidence). */
    mcxDepthUnits?:Record<string,{mode:string;samples:number;nonMultiple:number}>;
    /** Each selected reference's own blockers (first 40). */
    referenceBlockers?:Array<{id:string;name:string;market:string;codes:string[];signalAgeMs?:number|null;spotAgeMs?:number|null}>;lastDecision?:string|null;eventCode?:string};
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
