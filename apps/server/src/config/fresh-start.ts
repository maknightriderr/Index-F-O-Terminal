import { FRESH_PACK_VERSION, FRESH_STRATEGIES } from '@fno/analytics';
/** Implementation approved by the user. Activation is a separate, ungranted approval. */
export const FRESH_CONFIG = Object.freeze({
    version: FRESH_PACK_VERSION, spec: 'FRESH-START-SPEC-1.1', implementationApproved: true,
    approval: 'User: approved hai; 2026-10-30', enabled: false, activationApproved: false,
    liveOrdersAllowed: false, capital: null as number | null, baselineTrailing: false,
    strategies: FRESH_STRATEGIES.map(id => ({ id, enabled: false })),
    primarySource: 'ANGEL_EXACT_REFERENCE', automaticEntryFallback: false,
    markets: ['NSE_INDEX_OPTIONS', 'NSE_STOCK_OPTIONS'],
    requirements: [
        'CAPITAL_CONFIGURATION', 'QUALIFIED_SHARED_FEED_ADAPTER', 'EXACT_CONTRACT_REFERENCE_AND_SOURCE_EPOCH',
        'EXCHANGE_SESSION_EXPIRY_CALENDAR', 'VERIFIED_EVENT_COVERAGE',
        'EXECUTABLE_QUOTE_TIMESTAMP_DEPTH_UNITS', 'PRICING_MODEL_AND_SCENARIOS',
        'CURRENT_EXCHANGE_AND_BROKER_COSTS', 'LEGACY_POSITION_INVENTORY_AND_RISK_GROUPS',
        'HISTORICAL_AND_FORWARD_VALIDATION', 'RESTART_AND_MONITORING_LOAD_VERIFICATION',
        'EXPLICIT_PAPER_ACTIVATION_APPROVAL',
    ],
});
export function freshEntriesEnabled(): boolean {
    return FRESH_CONFIG.enabled && FRESH_CONFIG.activationApproved && FRESH_CONFIG.capital != null && FRESH_CONFIG.capital > 0;
}
