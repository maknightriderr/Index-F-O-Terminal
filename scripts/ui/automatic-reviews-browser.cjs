// Isolated UI fixtures: no real model, account, queue or trade writes.
const assert=require('node:assert/strict');
const path=require('node:path');
module.exports=async(page,output)=>{
  await page.clock.install();
  let failed=false, configured=true;
  const completed={signal_id:'11111111-1111-4111-8111-111111111111',symbol:'NIFTY',strategy:'A3',source_version:'v1',logic_version:'rules1',exchange:'NSE',mode:'INTRADAY',status:'COMPLETE',attempts:1,next_attempt_at:'2026-10-30T10:00:00Z',completed_at:'2026-10-30T10:02:00Z',provider:'Fixture AI',model:'fixture',last_error:null,
    evidence:{subject:{},facts:[{id:'PNL',text:'Recorded gross +0.05R; estimated costs 0.10R; net -0.05R.'}],missing:['Linked entry snapshot unavailable.'],issueCodes:['COST_ERASED_GAIN','DATA_GAPS'],grossR:.05,netR:-.05,measured:true},
    review:{summary:'Costs erased the small recorded gain. Entry validity cannot be established from missing snapshot data.',hypotheses:[{explanation:'A small gross gain may be insufficient for the recorded costs.',evidenceIds:['PNL'],experiment:'Compare after-cost outcomes with reviewed winners in an isolated test.'}]}};
  await page.route('**/api/ai-assistant/trade-reviews',route=>failed?route.fulfill({status:503,contentType:'application/json',body:'{"success":false,"error":{"message":"fixture outage"}}'}):route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({success:true,data:{available:true,enabled:true,aiConfigured:configured,version:'AUTO-REVIEW-1.0',activatedAt:'2026-10-30T00:00:00Z',scope:'Initial seven-day backlog and subsequent closes; automatic processing.',counts:{COMPLETE:2,PENDING:1,RETRY:1},recent:[completed,{...completed,signal_id:'22222222-2222-4222-8222-222222222222',status:'RETRY',evidence:null,review:null,last_error:'Automatic retry scheduled'}],repeated:[{strategy:'A3',source_version:'v1',logic_version:'rules1',exchange:'NSE',mode:'INTRADAY',code:'LOW_SAMPLED_MFE',trades:4,measured:4,profitable:1,losing:3,net_r:-1.2}]}})}));
  await page.getByRole('button',{name:'All pages',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('searchbox').fill('Paper Trades');await dialog.getByText('Paper Trades',{exact:true}).click();
  await page.getByRole('heading',{name:'Automatic AI Trade Review',exact:true}).waitFor();
  const table=page.getByRole('region',{name:'Automatic trade reviews',exact:true});
  await table.getByText('COMPLETE',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:/run review|retry review/i}).count(),0);
  await table.getByRole('button',{name:'Expand row details',exact:true}).first().click();
  await table.getByText(/Proposed experiment \(not applied\)/).waitFor();
  await table.getByText(/Missing evidence: Linked entry snapshot/).waitFor();
  failed=true;await page.clock.fastForward(60000);await page.getByText('Review status unavailable',{exact:true}).waitFor();
  failed=false;configured=false;await page.clock.fastForward(60000);await page.getByText(/not configured — jobs stay queued/).waitFor();
  assert.equal(await page.getByText('Review status unavailable',{exact:true}).count(),0);
  for(const theme of ['dark','light']){
    await page.setViewportSize({width:1440,height:1080});
    await page.getByRole('radio',{name:`${theme==='dark'?'Dark':'Light'} theme`,exact:true}).click();
    await page.screenshot({path:path.join(output,`automatic-review-${theme}.png`),fullPage:true});
    await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
    const violations=await page.evaluate(async()=>(await axe.run(document,{runOnly:{type:'rule',values:['color-contrast','button-name','select-name','label']}})).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})));
    assert.deepEqual(violations,[]);
    await page.setViewportSize({width:390,height:844});
    const size=await page.locator('#main-content').evaluate(el=>({w:el.clientWidth,s:el.scrollWidth}));assert.ok(size.s<=size.w,JSON.stringify(size));
  }
  console.log('Automatic reviews: saved evidence and hypotheses, automatic polling/error recovery, missing-provider queue status, no manual review action, dark/light accessibility and mobile overflow PASS');
};
