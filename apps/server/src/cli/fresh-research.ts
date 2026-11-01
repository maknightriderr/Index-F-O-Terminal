import {z} from 'zod';
import {readFile,open,stat,unlink} from 'node:fs/promises';
import {getSessionWindow} from '@fno/shared';
import {FRESH_RESEARCH_PROTOCOL,freshProtocolDigest} from '../config/fresh-research.js';
import {readFreshResearchInventory,registerFreshResearchProtocol} from '../services/fresh-start/research-inventory.js';
import {exportFreshResearchContexts} from '../services/fresh-start/research-export.js';
import {replayFreshResearch} from '../services/fresh-start/research-replay.js';
import {runFreshResearch} from '../services/fresh-start/research-runner.js';
import {sql} from '../lib/db.js';
import type {FreshDb} from '../services/fresh-start/store.js';
async function main(){
 const [command,input,output,destination]=process.argv.slice(2);
 if(command==='protocol'){console.log(JSON.stringify({...FRESH_RESEARCH_PROTOCOL,digest:freshProtocolDigest()},null,2));return;}
 if(command==='inventory'){console.log(JSON.stringify(await readFreshResearchInventory(),null,2));return;}
 if(command==='register'){await registerFreshResearchProtocol();console.log(JSON.stringify({registered:true,id:FRESH_RESEARCH_PROTOCOL.id,digest:freshProtocolDigest()}));return;}
 if(!['report','replay','export-contexts'].includes(command)||!input||!output||command==='export-contexts'&&!destination)throw Error('Usage: fresh-research protocol | inventory | register | report|replay INPUT.json NEW_OUTPUT.json | export-contexts FROM_ISO TO_ISO NEW_OUTPUT.json');
 const now=Date.now(),day=new Date(now).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
 if((['NSE','BSE','MCX'] as const).some(exchange=>{const s=getSessionWindow(exchange,day);return s&&now>=s.open&&now<s.close;}))throw Error('RESEARCH_BATCH_BLOCKED_DURING_MARKET_SESSION');
 let raw:unknown;
 if(command==='export-contexts'){
  const iso=z.string().datetime({offset:true});
  raw=await exportFreshResearchContexts(sql as unknown as FreshDb,Date.parse(iso.parse(input)),Date.parse(iso.parse(output)),now);
 }else{
  if((await stat(input)).size>10*1024*1024)throw Error('RESEARCH_INPUT_TOO_LARGE');
  const bytes=await readFile(input);if(bytes.length>10*1024*1024)throw Error('RESEARCH_INPUT_TOO_LARGE');
  raw=JSON.parse(bytes.toString('utf8'));
 }
 const target=command==='export-contexts'?destination!:output;
 // Reserve an exclusive output before claiming inspection; remove only our new file on failure.
 const file=await open(target,'wx',0o600);let complete=false;
 try{
  const result=command==='export-contexts'?raw:command==='replay'?replayFreshResearch(raw):await runFreshResearch(sql as unknown as FreshDb,raw,now);
  await file.writeFile(JSON.stringify(result,null,2)+'\n');complete=true;
  console.log(JSON.stringify({saved:target,command,promoted:false}));
 }finally{await file.close();if(!complete)await unlink(target);}

}
main().catch((error:unknown)=>{const message=error instanceof Error?error.message:'';const code=/^[A-Z][A-Z0-9_]{0,100}$/.test(message)?message:'RESEARCH_COMMAND_FAILED';console.error(JSON.stringify({code,message:'Check protocol maturity, schema, cohort/data format, inspection receipt and output path. Trading configuration is unchanged.'}));process.exitCode=1;}).finally(()=>void (sql as any).end?.());
