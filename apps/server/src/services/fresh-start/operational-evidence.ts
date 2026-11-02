import type {freshAdapterState} from './adapter-state.js';

type State=typeof freshAdapterState;
const code=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(value)?value:'UNAVAILABLE';
const name=(value:unknown)=>typeof value==='string'&&/^[A-Z0-9&_.-]{1,40}$/.test(value)?value:'UNAVAILABLE';
const codes=(values:readonly string[])=>[...new Set(values.map(code))].sort().slice(0,32);

/** A safe projection for platform logs, not a second trading/readiness authority. */
export function freshOperationalEvidence(state:State){
  const sources=state.eventSources;
  const source=(value:{status:string;failureCode?:string|null}|null|undefined)=>value?{status:code(value.status),failureCode:value.failureCode==null?null:code(value.failureCode)}:null;
  return {
    event:'freshOperationalEvidence',status:code(state.status),recovered:state.recovered,
    monitorRunning:state.monitorRunning,scannerRunning:state.scannerRunning,entriesArmed:state.entriesArmed,
    eventCode:code(state.eventCode),entryBlockers:codes(state.entryBlockers),
    markets:state.marketReadiness.map(m=>({market:m.market,sessionOpen:m.sessionOpen,eligibleReferences:m.eligibleReferences,observedExecutableBooks:m.observedExecutableBooks,blockers:codes(m.blockers)})),
    sources:{macro:source(sources?.macro),issuer:source(sources?.issuer),freeGlobal:source(sources?.freeGlobal),publicMacro:source(sources?.publicMacro),commodity:(sources?.commodity??[]).map(s=>({product:code(s.product),...source(s)})),officialMacro:(sources?.officialMacro??[]).map(s=>({source:code(s.source),...source(s)}))},
    // Which selected references are still waiting, and on what — so a market-wide code is traceable to instruments.
    references:(state.referenceBlockers??[]).filter(r=>r.codes.length).slice(0,24).map(r=>({name:name(r.name),market:code(r.market),codes:codes(r.codes)})),
    liveOrdersAllowed:false,
  };
}

/** Reuses scan callbacks. Changed snapshots coalesce at <=1/minute; no timer or I/O here. */
export class FreshOperationalReporter {
  private lastSignature:string|null=null;
  private lastAt:number|null=null;
  constructor(private emit:(evidence:ReturnType<typeof freshOperationalEvidence>)=>void,private now:()=>number=Date.now){}
  report(state:State){
    const at=this.now();
    if(!Number.isFinite(at)||this.lastAt!==null&&(at<this.lastAt||at-this.lastAt<60000))return;
    const evidence=freshOperationalEvidence(state),signature=JSON.stringify(evidence);
    if(signature===this.lastSignature)return;
    try{this.emit(evidence);this.lastSignature=signature;this.lastAt=at;}catch{/* Observability never changes trading, recovery or exit decisions. */}
  }
}
