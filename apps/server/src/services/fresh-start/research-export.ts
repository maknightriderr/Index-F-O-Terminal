import {FRESH_PACK_VERSION} from '@fno/analytics';
import type {FreshDb} from './store.js';
/** Bounded signal contexts only; never exports trade outcomes or declares complete historical coverage. */
export async function exportFreshResearchContexts(db:FreshDb,from:number,to:number,now=Date.now()){
 if(![from,to,now].every(Number.isFinite)||from>=to||to>now)throw Error('INVALID_EXPORT_WINDOW');
 return db.begin(async tx=>{
  await tx.unsafe('SET TRANSACTION READ ONLY');await tx.unsafe("SET LOCAL statement_timeout='2000ms'");
  const rows=await tx.unsafe('SELECT id,version,input,result FROM fresh_evaluations WHERE version=$1 AND at >= $2 AND at < $3 AND NOT (input ? \'trimmedAt\') ORDER BY at,id LIMIT 101',[FRESH_PACK_VERSION,new Date(from).toISOString(),new Date(to).toISOString()]);
  if(rows.length>100)throw Error('EXPORT_WINDOW_TOO_LARGE');
  if(!rows.length)throw Error('NO_RECORDED_CONTEXTS_IN_WINDOW');
  if(Buffer.byteLength(JSON.stringify(rows),'utf8')>10*1024*1024)throw Error('EXPORT_WINDOW_TOO_LARGE');
  return rows;
 });
}
