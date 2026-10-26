// Called by trading-desk-browser.cjs with its isolated API fixtures.
const assert=require('node:assert/strict');
const path=require('node:path');
module.exports=async function verifyWorkspaces(page,output){
 await page.evaluate(()=>{if(document.getElementById('ui-fixture-label'))return;const label=document.createElement('div');label.id='ui-fixture-label';label.textContent='UI TEST FIXTURE · SAMPLE DATA';label.style.cssText='position:fixed;bottom:0;left:0;z-index:9999;padding:5px 12px;background:#0c1520;color:#fff;font:12px sans-serif';document.body.append(label)});
 const pages=[
 ['Indices','Indices'],['F&O Explorer','F&O Explorer'],['Corporate Actions','Corporate Actions'],
 ['Paper Trades','Paper Trades'],['Best Setups','Best Setups'],['Option-Buying Leans','Option-Buying Leans'],['Structure Scanner','Structure Scanner'],
 ['Backtesting','Backtesting'],['Loss Attribution','Loss Attribution'],['Signal Diagnostics','Signal Diagnostics'],['Measurement','Measurement'],['Evidence','Evidence'],
 ['Institutional Flow','Institutional Flow Intelligence'],['System Health','System Health'],['Alerts','Alerts'],['System Learning','System Learning']];
 const accessibilityFailures=[];
 const screenshots=new Set(['Paper Trades','Best Setups','F&O Explorer','Signal Diagnostics','Measurement','System Health']);
 const go=async(label,title)=>{
  await page.getByRole('button',{name:'All pages',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('searchbox').fill(label);
  await dialog.getByText(label,{exact:true}).click();
  await page.getByRole('heading',{level:1,name:title,exact:true}).waitFor();
  assert.equal(await page.locator('#main-content').evaluate(el=>el.scrollTop),0,'new workspace starts at top');
  await page.waitForTimeout(120);
 };
 await page.setViewportSize({width:1440,height:1080});
 await page.keyboard.press('Control+k');
 await page.getByRole('dialog').getByRole('searchbox').fill('no-match-zzzz');
 assert.equal(await page.getByText(/No matching pages/).isVisible(),true);
 await page.keyboard.press('Escape');
 await page.getByRole('dialog').waitFor({state:'hidden'});
 console.log('DIRECTORY keyboard search, empty state and Escape PASS');
 for(const theme of ['dark','light']){
  await page.getByRole('radio',{name:`${theme==='dark'?'Dark':'Light'} theme`,exact:true}).click();
  for(const [label,title] of pages){
   await go(label,title);
   assert.equal(await page.locator('.terminal-rail').evaluate(el=>el.clientWidth),95);
   assert.equal(await page.locator('.terminal-page-header').count(),1);
   assert.equal(await page.locator('.terminal-workspace-tabs').count(),1);
   if(screenshots.has(label)){
    await page.screenshot({path:path.join(output,`workspace-${label.toLowerCase().replaceAll(' ','-').replace('&','and')}-${theme}.png`),fullPage:true});
    await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
    const violations=await page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'rule',values:['color-contrast','button-name','select-name','label']}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})));
    console.log('WORKSPACE ACCESSIBILITY',label,theme,JSON.stringify(violations));
    if(violations.length)accessibilityFailures.push({label,theme,violations});
   }
   const desktop=await page.locator('#main-content').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
   assert.ok(desktop.scroll<=desktop.width,`${label} ${theme} desktop overflow ${JSON.stringify(desktop)}`);
   await page.setViewportSize({width:390,height:844});
   const mobile=await page.locator('#main-content').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
   assert.ok(mobile.scroll<=mobile.width,`${label} ${theme} mobile overflow ${JSON.stringify(mobile)}`);
   if(['Paper Trades','System Health'].includes(label)) await page.screenshot({path:path.join(output,`workspace-${label.toLowerCase().replaceAll(' ','-')}-${theme}-mobile.png`),fullPage:true});
   await page.setViewportSize({width:1440,height:1080});
  }
  console.log(`ALL 16 WORKSPACES ${theme}: page navigation, header, context tabs, desktop/mobile overflow PASS`);
 }
 await go('Signal Diagnostics','Signal Diagnostics');
 const research=page.getByRole('navigation',{name:'Diagnostic views'});
 for(const button of await research.getByRole('button').all()){
  await button.click();assert.equal(await button.getAttribute('aria-pressed'),'true');
 }
 console.log('RESEARCH every diagnostic view switch PASS');
 await go('Measurement','Measurement');
 await page.locator('#main-content').evaluate(el=>el.scrollTop=el.scrollHeight);
 await go('Paper Trades','Paper Trades');
 const filter=page.getByRole('group',{name:'Paper trade filters'});
 await filter.getByRole('searchbox').fill('not-a-symbol');
 assert.equal(await page.getByText('NIFTY 24500 CE',{exact:false}).count(),0);
 await filter.getByRole('button',{name:'Clear filters',exact:true}).click();
 await page.getByRole('button',{name:'Expand row details',exact:true}).first().click();
 assert.equal(await page.getByRole('button',{name:'Collapse row details',exact:true}).count(),1);
 console.log('PAPER filters/reset and expandable trade details PASS');
 await page.getByRole('navigation',{name:'Trade Desk workspace pages'}).getByRole('button',{name:'Best Setups',exact:true}).click();
 await page.getByRole('heading',{level:1,name:'Best Setups',exact:true}).waitFor();
 await page.goBack();
 await page.getByRole('heading',{level:1,name:'Paper Trades',exact:true}).waitFor();
 console.log('WORKSPACE tabs and browser back preserve routes PASS');
 assert.deepEqual(accessibilityFailures,[],'Workspace accessibility checks');
};
