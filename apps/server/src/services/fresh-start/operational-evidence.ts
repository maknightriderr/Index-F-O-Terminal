import type {freshAdapterState} from './adapter-state.js';

type State=typeof freshAdapterState;
const code=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(value)?value:'UNAVAILABLE';
const name=(value:unknown)=>typeof value==='string'&&/^[A-Z0-9&_.-]{1,40}$/.test(value)?value:'UNAVAILABLE';
const age=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.round(v):null;
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
    // Tick lateness per exchange segment over the last minute (5 Nov: MCX ticks 2-4 s late read as stale references).
    tickLag:state.tickLag??{},
    // 2.0: the stocks in play now (direction +1 leader / -1 laggard, RS vs NIFTY in % points, futures OI read).
    stocksInPlay:(state.stocksInPlay??[]).slice(0,10).map(x=>({name:name(x.name),direction:x.direction,relativeStrength:x.relativeStrength==null?null:Math.round(x.relativeStrength*100)/100,oi:x.oi==null?null:code(x.oi)})),
    // The token plan and each book slice (7 Nov: MCX showed 0 books during NSE hours), and MCX depth-unit inference.
    bookPlan:state.bookPlan?{capacity:state.bookPlan.capacity,refTokens:state.bookPlan.refTokens,heldTokens:state.bookPlan.heldTokens,slots:state.bookPlan.slots,tokens:state.bookPlan.tokens,slices:state.bookPlan.slices.slice(0,24).map(x=>({name:name(x.name),market:code(x.market),options:x.options,pinned:x.pinned}))}:null,
    mcxDepthUnits:Object.fromEntries(Object.entries(state.mcxDepthUnits??{}).slice(0,12).map(([k,v])=>[name(k),{mode:code(v.mode),samples:v.samples,nonMultiple:v.nonMultiple}])),
    // Which selected references are still waiting, and on what — so a market-wide code is traceable to instruments.
    references:(state.referenceBlockers??[]).filter(r=>r.codes.length).slice(0,24).map(r=>({name:name(r.name),market:code(r.market),codes:codes(r.codes),signalAgeMs:age(r.signalAgeMs),spotAgeMs:age(r.spotAgeMs)})),
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
