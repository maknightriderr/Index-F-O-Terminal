import {FRESH_PAPER_EVENT_POLICY} from './fresh-event-policy.js';
import {freshAdapterState} from '../services/fresh-start/adapter-state.js';
import { FRESH_PACK_VERSION, FRESH_STRATEGIES } from '@fno/analytics';
/** Implementation and forward paper activation requested by the user; execution remains gated by operational qualification. */
export const FRESH_CONFIG = Object.freeze({
    eventPolicy:FRESH_PAPER_EVENT_POLICY,version: FRESH_PACK_VERSION, spec: 'FRESH-START-SPEC-1.1', implementationApproved: true,
    approval: 'User requested paper activation and selected INR 500000 virtual capital; 2026-10-31', enabled: true, activationApproved: true, activationRequested: true,
    liveOrdersAllowed: false, capital: 500000 as number | null, baselineTrailing: false,
    strategies: FRESH_STRATEGIES.map(id => ({ id, enabled: true })),
    primarySource: 'ANGEL_EXACT_REFERENCE', automaticEntryFallback: false,
    markets: ['NSE_INDEX_OPTIONS', 'NSE_STOCK_OPTIONS', 'BSE_VERIFIED_OPTIONS', 'MCX_VERIFIED_FUTURES_OPTIONS'],
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
    return freshAdapterState.entriesArmed && freshAdapterState.recovered && freshAdapterState.monitorRunning && FRESH_CONFIG.enabled && FRESH_CONFIG.activationApproved && FRESH_CONFIG.capital != null && FRESH_CONFIG.capital > 0;
}
