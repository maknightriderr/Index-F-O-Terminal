// Isolated sample data only; never uses a production account.
const assert = require('node:assert/strict');
const path = require('node:path');
module.exports = async function(page, output) {
  let missing = false;
  const row = { key: 'of1-old', strategy: 'OF1', logicVersion: 'FAMILIES-1.1', sourceVersion: 'OF1-1.0', mode: 'INTRADAY', exchange: 'MCX', population: 'RELIABLE', total: 35, open: 1, excluded: 2, missingCost: 2, measured: 30, profitable: 12, losing: 18, flat: 0, expired: 3, sessions: 3, grossR: -.49, costR: 3.49, profitR: 3, lossR: 6.98, netR: -3.98, expectancyR: -.1327, profitFactor: .43, noLosses: false, status: 'SMALL_SAMPLE' };
  await page.route('**/api/diagnostics/measurement', route => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({success:true, data: { schemaReady: false, ...(missing ? {} : { strategyValidation: { asOf: '2026-10-29T10:00:00Z', complete: false, rowLimit: 20000, loaded: 20000, reliableFrom: '2026-10-11T18:30:00Z', inventory: ['A3','OF1','OB1','INDICATOR','S1'], rows: [row, {...row, key: 'of1-new', sourceVersion: 'OF1-1.2', total: 1, measured: 1, profitable: 1, losing: 0, open: 0, excluded: 0, missingCost: 0, netR: .5, profitR: .5, lossR: 0, noLosses: true, profitFactor: null}] } }) } }) }));
  await page.getByRole('button', {name:'All pages', exact:true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox').fill('Measurement');
  await dialog.getByText('Measurement', {exact:true}).click();
  await page.getByRole('heading', {name:'Strategy Validation',exact:true}).waitFor();
  const table = page.getByRole('region', {name:'Strategy validation results',exact:true});
  assert.equal(await table.locator('tbody tr').count(), 6);
  assert.equal(await table.getByText('−3.98R', {exact:true}).count(), 0); // Formatter uses an ASCII minus, once.
  assert.equal(await table.getByText('-3.98R', {exact:true}).count(), 1);
  await table.getByRole('button', {name:'Expand row details',exact:true}).first().click();
  await table.getByText(/Source version: OF1-1.0/).waitFor();
  await page.getByLabel('Strategy', {exact:true}).selectOption('OB1');
  await table.getByText('No recorded trades', {exact:true}).waitFor();
  await page.getByLabel('Strategy', {exact:true}).selectOption('ALL');
  await page.getByText('Partial history', {exact:true}).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name:'Export table CSV',exact:true}).click()]);
  assert.match(download.suggestedFilename(), /strategy-validation-reliable-partial\.csv$/);
  const csv = require('node:fs').readFileSync(await download.path(), 'utf8');
  assert.ok(csv.includes('OF1-1.0') && csv.includes('OF1-1.2') && csv.includes('-3.98'));
  for (const theme of ['dark','light']) {
    await page.setViewportSize({width:1440,height:1080});
    await page.getByRole('radio', {name:`${theme==='dark'?'Dark':'Light'} theme`,exact:true}).click();
    await page.screenshot({path:path.join(output,`strategy-validation-${theme}.png`),fullPage:true});
    await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
    const violations = await page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'rule',values:['color-contrast','button-name','select-name','label']}})).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})));
    assert.deepEqual(violations,[]);
    await page.setViewportSize({width:390,height:844});
    const layout=await page.locator('#main-content').evaluate(el=>({w:el.clientWidth,s:el.scrollWidth}));
    assert.ok(layout.s<=layout.w,JSON.stringify(layout));
  }
  await page.setViewportSize({width:1440,height:1080});
  missing = true;
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByText('Strategy validation unavailable',{exact:true}).waitFor();
  console.log('Strategy Validation: version separation, net P&L, zero-data inventory, filters, partial/missing API, dark/light accessibility and mobile overflow PASS');
};
