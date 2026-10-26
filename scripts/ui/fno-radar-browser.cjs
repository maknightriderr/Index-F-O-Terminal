// Isolated UI fixtures only. Run against a local production build. No backend required.
const {chromium} = require('playwright');
const path=require('node:path');
const fs=require('node:fs');
const output=process.env.DESK_QA_OUTPUT || '/tmp/fno-desk-qa';
fs.mkdirSync(output,{recursive:true});
const assert=require('node:assert/strict');
let browser;
(async()=>{
const binary=process.env.DESK_CHROMIUM_MODULE ? (await import(process.env.DESK_CHROMIUM_MODULE)).default : null;
browser=await chromium.launch({executablePath:process.env.DESK_CHROMIUM_EXECUTABLE || undefined, args:binary?.args, headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1280},deviceScaleFactor:1,locale:"en-IN"});
const page=await context.newPage();const errors=[];const writes=[];
let failHistory=false;
const historyRequests=[];
page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message)});
const seen=Date.now();
const quotes=[['NIFTY','NSE',24578.2,.42],['BANKNIFTY','NSE',51240.8,-.18],['FINNIFTY','NSE',25892.3,.31],['SENSEX','BSE',80512.36,.36],['CRUDEOIL','MCX',6842,.65],['GOLD','MCX',72358,.21],['INDIAVIX','NSE',13.42,-1.2]].map(([symbol,exchange,ltp,changePercent])=>({symbol,exchange,ltp,changePercent,change:ltp*changePercent/100,open:ltp-30,high:ltp+90,low:ltp-80,close:ltp-40,volume:800000,timestamp:seen,exchangeTimestamp:seen}));
const trade=(symbol,side,entry,last,net)=>({id:symbol,symbol,exchange:'NSE',mode:'INTRADAY',structureType:'NAKED_LONG',side,strike:symbol==='NIFTY'?24500:51200,expiry:'2026-10-29',direction:side==='CE'?'BULLISH':'BEARISH',family:symbol==='NIFTY'?'OB1':'OF1',strategyLabel:symbol==='NIFTY'?'OB1 · Order block':'OF1 · Order flow',logicVersion:'UI-FIXTURE',mintedAt:seen,state:'OPEN',status:'OPEN_TRACKED',includedInPerformance:false,excludedReason:'OPEN',cohort:'POST_B',measurementReliable:true,entry,initialStop:entry-30,currentStop:entry-30,target:entry+60,plannedRiskReward:2,exitPrice:null,exitAt:null,closeReason:null,holdMinutes:28,grossR:null,netR:null,returnPercent:null,estimatedCost:{pct:2,basis:'ESTIMATED_MODEL',costR:.1,record:null},live:{premium:last,observedAt:seen,ageSeconds:30,unrealisedGrossR:net+.1,unrealisedNetR:net,unrealisedPnlInr:null,quantity:null,health:{state:'HEALTHY',at:seen,reason:'UI fixture'},slotTracked:true},disclosure:'UI test fixture'});
const candles=Array.from({length:85},(_,i)=>{const base=24550+Math.sin(i/12)*85+Math.cos(i/4)*12;return {timestamp:new Date(seen-(85-i)*900000).toISOString(),open:base,close:base+Math.sin(i*2)*10,high:base+14,low:base-14,volume:1000+(i%11)*300}});
// A real geometric OB displacement and unfilled FVG in the synthetic OHLC fixture.
[[24520,24525,24510,24515],[24515,24590,24514,24586],[24586,24605,24580,24600],[24600,24615,24590,24610],[24610,24620,24600,24612],[24612,24625,24602,24618]].forEach(([open,high,low,close],i)=>Object.assign(candles[79+i],{open,high,low,close}));
await page.route('**/api/**',async route=>{
const request=route.request();if(!['GET','OPTIONS'].includes(request.method()))writes.push(request.method()+' '+request.url());
const path=new URL(request.url()).pathname;let data;
if(path==='/api/session')data={mode:'OPEN_DEV',authenticated:true,reason:null};
else if(['/api/market/indices','/api/market/all-indices'].includes(path))data=quotes;
else if(path.includes('/historical/')) {
  historyRequests.push(request.url());
  if(failHistory) return route.fulfill({status:503,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({success:false,error:{message:'History unavailable',code:'UI_FIXTURE'}})});
  data=candles;
}
else if(path==='/api/structure/watchlist')data={enabled:true,day:'2026-10-23',rows:[{id:'fixture:NIFTY:MP:OB1:1',symbol:'NIFTY',exchange:'NSE',direction:'BULLISH',entry:24560,stop:24520,t1:{price:24640},rToT1:2,stage:'CONFIRMED',stageAt:seen,score:80,timeframe:'15m',pool:null,zone:null,preview:null}]};
else if(path==='/api/diagnostics/triggers')data={stages:{S1:'PAPER_RESEARCH',OB1:'PAPER_RESEARCH',OF1:'PAPER_RESEARCH'}};
else if(path==='/api/market-scanner')data=null;
else if(path==='/api/diagnostics/measurement')data={schemaReady:true,versions:{strategy:'UI-FIXTURE'},reliability:{measurementsReliableFrom:'2026-10-12T00:00:00Z',tradesSinceReliable:12,eligibleSinceReliable:10,withCostRecord:10},populations:{historicalRows:20,measurementReliableRows:12,netR:'UI TEST FIXTURE: costs estimated'},byCohort:[],reliableSample:{byCohort:[],byFamily:[],byInstrument:[]},costs:{n:10,basis:'ESTIMATED_MODEL',spreadFromQuote:8,spreadFallbackAssumed:2,medianTotalPct:2,medianCostR:.1,medianCostPctOfPlannedGrossProfit:5,reconcilesWithSetupCost:{matches:10,checked:10}}};
else if(path==='/api/paper-trades')data={trades:[trade('NIFTY','CE',186.5,205.5,.53),trade('BANKNIFTY','PE',402,395.8,-.31)],counts:{total:2,open:2,openUntracked:0,closed:0,excludedFromPerformance:2,recorded:2,truncated:false}};
else if(path.includes('/bias-snapshot/'))data=null;
else if(path.includes('/futures/'))data={spotPrice:24578,contracts:[{token:'fixture',symbol:'FIXTURE-FUT',expiryLabel:'current',expiry:'2026-10-29',futuresPrice:24580,basis:2,premiumDiscount:.01,premiumDiscountType:'PREMIUM',oi:1000,changeOi:100,volume:500,dte:3,interpretation:'LONG_BUILDUP'}]};
else if(path==='/api/instruments/fno')data=['RELIANCE','TCS','INFY','ITC'].map(symbol=>({symbol,exchange:'NSE'}));
else if(path==='/api/instruments')data=[{symbol:new URL(request.url()).searchParams.get('q'),exchange:'NSE',segment:'CM',instrumentType:'EQ',token:'cash-fixture'}];
else if(path==='/api/instruments/fno-scanner')data=[['RELIANCE','BULLISH',1],['TCS','BEARISH',-1],['INFY','NEUTRAL',0]].map(([symbol,direction,relativeStrength])=>({symbol,exchange:'NSE',price:24578,changePercent:relativeStrength,relativeStrength,direction,score:70,confidence:70,atmSpreadPct:1,volume:10000,futuresOi:100000,futuresChangeOi:1000,futuresChangeOiPercent:1,oiInterpretation:'LONG_BUILDUP',pcr:1,atmIv:20,ceIv:20,peIv:20,ivRank:null,ivPercentile:null,ivSkew:0,atmGamma:.01,atmTheta:-2,atmVega:3,timestamp:seen}));
else if(['/api/market/chart-patterns','/api/fii-dii/history','/api/alerts'].includes(path))data=[];
else if(path==='/api/fii-dii')data=null;
else return route.fulfill({status:503,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({success:false,error:{message:'Unavailable in isolated UI fixture',code:'UI_FIXTURE'}})});
return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({success:true,data,meta:{readOnly:true,source:'LAST_KNOWN',asOf:seen,timestamp:seen}})});
});
await page.goto(process.env.DESK_QA_URL || 'http://localhost:3000',{waitUntil:'networkidle'});
await page.getByRole('heading',{name:'Setup spotlight',exact:true}).waitFor();
await page.evaluate(()=>{const label=document.createElement('div');label.id='ui-fixture-label';label.textContent='UI TEST FIXTURE · SAMPLE DATA';label.style.cssText='position:fixed;bottom:0;left:0;z-index:9999;padding:5px 12px;background:#0c1520;color:#fff;font:12px sans-serif';document.body.append(label)});

for(const theme of ['dark','light']) {
 await page.getByRole('radio',{name:`${theme==='dark'?'Dark':'Light'} theme`,exact:true}).click();
 await page.getByRole('button',{name:'All pages',exact:true}).click();
 await page.getByRole('dialog').getByRole('searchbox').fill('F&O Explorer');
 await page.getByRole('dialog').getByText('F&O Explorer',{exact:true}).click();
 await page.getByRole('heading',{name:'F&O Market Radar',exact:true}).waitFor();
 await page.getByRole('button',{name:'Inspect RELIANCE',exact:true}).waitFor();
 await page.getByRole('button',{name:'Inspect TCS',exact:true}).waitFor();
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  const size=await page.locator('#main-content').evaluate(el=>({w:el.clientWidth,s:el.scrollWidth}));
  assert.ok(size.s<=size.w,`${theme} radar overflow`);
  await page.screenshot({path:path.join(output,`radar-${theme}-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
 const violations=await page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'rule',values:['color-contrast','button-name','select-name','label']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})));
 assert.deepEqual(violations,[]);
 await page.getByRole('button',{name:'Inspect RELIANCE',exact:true}).click();
 await page.getByRole('heading',{name:'RELIANCE price structure',exact:true}).waitFor();
 await page.getByRole('button',{name:'15m',exact:true}).click();
 await page.getByRole('button',{name:/Order blocks \([1-9]/}).waitFor();
 await page.getByRole('button',{name:/FVG \([1-9]/}).waitFor();
 assert.ok(historyRequests.some(u=>u.includes('cash-fixture') && u.includes('segment=CM')));
 await page.getByRole('button',{name:'Futures',exact:true}).click();
 await page.waitForTimeout(500);
 assert.ok(historyRequests.some(u=>u.includes('/fixture?') && u.includes('segment=FO')));
 await page.getByRole('button',{name:'Spot',exact:true}).click();
 await page.screenshot({path:path.join(output,`stock-${theme}.png`),fullPage:true});
 console.log(theme,'radar lists, stock click, cash chart OB/FVG, responsive layout and radar accessibility PASS');
}
assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
console.log('No browser errors or API writes');
await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exit(1)});
