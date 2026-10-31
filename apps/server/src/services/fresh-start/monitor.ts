import {getSessionWindow} from '@fno/shared';
import {advanceFreshPosition,type FreshPaperPosition} from '@fno/analytics';
import {FreshSharedFeed} from './feed.js';
import {FreshPaperStore} from './store.js';
type Observation=Parameters<typeof advanceFreshPosition>[1];
type Row=Awaited<ReturnType<FreshPaperStore['recover']>>[number];
export function completeFreshBarsSinceFill(openedAt:number,now:number,sessionOpen:number){
  const first=sessionOpen+Math.ceil((openedAt-sessionOpen)/300000)*300000;
  return Math.max(0,Math.floor((now-first)/300000));
}
/** Each observed exit transition is retained until durable storage acknowledges it. Entry readiness fails closed on persistence errors. */
export class FreshPositionMonitor {
  private rows=new Map<string,Row>();private projected=new Map<string,FreshPaperPosition>();
  private queues=new Map<string,Array<{event:Observation;critical:boolean}>>();private busy=new Set<string>();private failures=new Set<string>();private lastSaved=new Map<string,number>();
  constructor(private feed:FreshSharedFeed,private store:FreshPaperStore,private now:()=>number=Date.now){}
  get healthy(){return this.failures.size===0;}
  watch(rows:Row[]){for(const row of rows){this.rows.set(row.id,row);if(!this.queues.get(row.id)?.length)this.projected.set(row.id,row.state);}for(const id of this.rows.keys())if(!rows.some(r=>r.id===id)&&!this.queues.get(id)?.length){this.rows.delete(id);this.projected.delete(id);this.failures.delete(id);this.queues.delete(id);this.lastSaved.delete(id);}}
  tick(){
    const now=this.now();
    for(const [id,row] of this.rows){
      const p=this.projected.get(id)??row.state,session=getSessionWindow('NSE',p.candidate.session),cutoff=p.sessionCutoff??session?.close;
      if(!session||cutoff==null){this.failures.add(id);continue;}
      const tick=Number(p.contract.evidence?.tickSize),quote=tick>0?this.feed.quote(p.contract.id,tick):null,underlying=this.feed.underlying(p.candidate.instrument);
      const event:Observation={at:now,underlying:underlying?.price??null,underlyingAt:underlying?.at??null,quote,cutoff,barsSinceFill:completeFreshBarsSinceFill(p.openedAt,now,session.open),trail:false,monitorEpoch:this.feed.sourceEpoch};
      const n=advanceFreshPosition(p,event),queue=this.queues.get(id)??[];
      const threshold=.25*Math.abs(p.candidate.referenceEntry-p.candidate.stop),critical=n.state!==p.state||n.currentStop!==p.currentStop||(p.maxUnderlyingFavorable<threshold&&n.maxUnderlyingFavorable>=threshold);
      if(n!==p&&(critical||now-(this.lastSaved.get(id)??0)>=1000)){
        if(queue.length>=16){const replace=queue.findIndex((x,i)=>i>0&&!x.critical);if(replace>=0)queue.splice(replace,1);else{this.failures.add(id);void this.drain(id,row.account_id);continue;}}
        queue.push({event,critical});this.queues.set(id,queue);this.projected.set(id,n);this.lastSaved.set(id,now);
      }
      void this.drain(id,row.account_id);
    }
  }
  private async drain(id:string,accountId:string){
    if(this.busy.has(id))return;this.busy.add(id);
    try{const queue=this.queues.get(id);while(queue?.length){await this.store.observe(accountId,id,queue[0].event);queue.shift();}this.failures.delete(id);}
    catch{this.failures.add(id);}finally{this.busy.delete(id);}
  }
}
