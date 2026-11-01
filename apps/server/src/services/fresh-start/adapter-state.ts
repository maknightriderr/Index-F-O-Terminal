import {FRESH_MARKETS,type FreshMarket} from './markets.js';
export interface FreshMarketReadiness {market:FreshMarket;universe:number;selected:number;references:number;optionContracts:number;observedExecutableBooks:number;eligibleReferences:number;sessionOpen:boolean;blockers:string[];}
export const freshAdapterState={status:'NOT_STARTED',lastCheckAt:null as number|null,sourceEpoch:null as string|null,referenceContracts:0,optionContracts:0,observedExecutableBooks:0,error:null as string|null,recovered:false,scannerRunning:false,monitorRunning:false,entriesArmed:false,barCallbacks:0,lastDecision:null as string|null,eventCode:'PAPER_EVENT_DATA_UNVERIFIED',scope:[...FRESH_MARKETS] as string[],entryBlockers:['ADAPTER_NOT_STARTED'] as string[],
 marketReadiness:FRESH_MARKETS.map(market=>({market,universe:0,selected:0,references:0,optionContracts:0,observedExecutableBooks:0,eligibleReferences:0,sessionOpen:false,blockers:['DISCOVERY_NOT_STARTED']})) as FreshMarketReadiness[],
 discovery:{at:null as number|null,totalReferences:0,unmapped:0,selected:0,historyCache:0,historyLimit:40,historyRequestsPerCycle:4,subscriptionLimit:250,windowMinutes:30},
 eventSources:null as ReturnType<import('./event-source.js').FreshEventSource['view']>|null,
 requiredEventConfiguration:[] as string[],
};
export function freshProductionState(){return {...freshAdapterState,scope:[...freshAdapterState.scope],entryBlockers:[...freshAdapterState.entryBlockers],marketReadiness:freshAdapterState.marketReadiness.map(m=>({...m,blockers:[...m.blockers]})),discovery:{...freshAdapterState.discovery},requiredEventConfiguration:[...freshAdapterState.requiredEventConfiguration]};}
