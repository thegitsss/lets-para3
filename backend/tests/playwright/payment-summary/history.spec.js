const { test, expect, fixture: legacy } = require('./legacy-fixture'), fs = require('node:fs/promises'), AxeBuilder = require('@axe-core/playwright').default;
const OWNER = '111111111111111111111111', id = n => n.toString(16).padStart(24,'0'), hash = n => n.toString(16).padStart(64,'0');
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const row = (n, patch = {}) => ({ id: hash(n), caseId: id(n), caseTitle: `River Street ${n}`, type: 'funding', state: 'recorded', amount: 48800, currency: 'USD', recordedAt: '2026-01-03T00:00:00.000Z', basis: 'original_payment', receiptId: 'payment', paralegalName: null, ...patch });
function summary(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.currency) continue;
    if (!groups.has(r.currency)) groups.set(r.currency,{currency:r.currency,originalFunding:0,paralegalPayouts:0,refunds:0,fundingRecords:0,payoutRecords:0,refundRecords:0,fundingUnverified:0,payoutsUnverified:0,refundsUnverified:0});
    const g = groups.get(r.currency), fields = {funding:['originalFunding','fundingRecords','fundingUnverified'],payout:['paralegalPayouts','payoutRecords','payoutsUnverified'],refund:['refunds','refundRecords','refundsUnverified']}[r.type];
    if (fields) { if(r.state==='recorded'){g[fields[0]]+=r.amount;g[fields[1]]++;}else g[fields[2]]++; }
  }
  return {currencies:[...groups.values()],requiresReview:rows.filter(r=>['needs_review','unconfirmed','requires_action'].includes(r.state)).length,pending:rows.filter(r=>r.state==='pending').length,undated:rows.filter(r=>!r.recordedAt).length};
}
async function fixture(page, { entries = [row(1),row(2,{currency:'EUR'}),row(3,{type:'refund',state:'unconfirmed',basis:'refund_request',recordedAt:null})], theme = 'light' } = {}) {
  const state = {entries,status:200,csvStatus:200,reads:[],exports:[],invalid:false,csvBody:null,hold:null,revision:hash(999)};
  const filtered = q => state.entries.filter(r => (!q.get('caseId') || r.caseId===q.get('caseId')) && r.caseTitle.toLowerCase().includes((q.get('q')||'').toLowerCase()) && (!q.get('view') || q.get('view')==='all' || q.get('view')==='review' && ['needs_review','unconfirmed','requires_action'].includes(r.state) || r.type===q.get('view')));
  const original = await legacy(page,{theme,setup:async session=>{
    state.session=session;
    await page.route('**/api/payments/attorney-financial-history?**', async route=>{
      const q=new URL(route.request().url()).searchParams;state.reads.push(Object.fromEntries(q));expect(q.get('expectedOwnerId')).toBe(OWNER);
      if(state.hold) return state.hold(route);
      if(state.status!==200)return json(route,{},state.status);
      const entries=filtered(q),offset=Number(q.get('cursor')||0),s=summary(entries);if(state.invalid && s.currencies.length)s.currencies[0].originalFunding=1;
      return json(route,{ownerId:OWNER,revision:state.revision,view:q.get('view')||'all',q:q.get('q')||'',caseId:q.get('caseId'),total:entries.length,entries:entries.slice(offset,offset+50),nextCursor:offset+50<entries.length?String(offset+50):null,summary:s});
    });
    await page.route('**/api/payments/attorney-financial-history/csv?**',async route=>{
      const q=new URL(route.request().url()).searchParams;state.exports.push(Object.fromEntries(q));if(state.csvStatus!==200)return json(route,{},state.csvStatus);
      const quote=v=>`"${String(v).replace(/"/g,'""')}"`;
      const csv='\uFEFF"Matter","Record","Status","Currency","Amount","Amount describes"\r\n'+filtered(q).map(r=>[r.caseTitle,r.type,r.state,r.currency||'',r.amount===null?'':(r.amount/100).toFixed(2),r.basis].map(quote).join(',')).join('\r\n')+'\r\n';
      return route.fulfill({status:200,contentType:'text/csv',body:state.csvBody??csv});
    });
  }});
  const panel=page.locator('[data-financial-history]'); await expect(panel).toHaveAttribute('data-state','ready'); return {...original,state,panel};
}
test('original history has one heading, exact currencies, unconfirmed refunds and real receipt destinations',async({page})=>{
  const {panel,state}=await fixture(page);await expect(page.getByRole('heading',{name:'Financial history',exact:true})).toHaveCount(1);
  await expect(panel).toContainText('€488.00');await expect(panel).toContainText('$488.00');await expect(panel).toContainText('Requested refund; processing not confirmed');await expect(panel).toContainText('Date not recorded');await expect(panel).not.toContainText('Date Paid');
  await expect(panel.locator('[data-financial-record]').first().getByRole('link',{name:'Review original funding receipt'})).toHaveAttribute('href',`/attorney-v2.html#/matters/${id(1)}/receipt?receiptId=payment`);expect(state.session.posts).toEqual([]);
});
test('original history pages and exports the entire505-record filtered selection',async({page})=>{
  const {panel,state}=await fixture(page,{entries:Array.from({length:505},(_,i)=>row(i+1))});await expect(panel).toContainText('50 of 505');
  await panel.getByRole('button',{name:'More records',exact:true}).click();await expect(panel).toContainText('100 of 505');expect(state.reads[1].cursor).toBe('50');
  const pending=page.waitForEvent('download');await panel.getByRole('button',{name:'Download CSV',exact:true}).click();const download=await pending;
  const bytes=await fs.readFile(await download.path(),'utf8');expect(bytes.trim().split(/\r?\n/)).toHaveLength(506);expect(bytes).toContain('River Street 505');expect(state.exports[0].revision).toBe(state.revision);
  await panel.getByLabel('Matter title',{exact:true}).fill('River Street 505');await panel.getByRole('button',{name:'Apply filters',exact:true}).click();await expect(panel).toContainText('1 of 1');await expect(panel.locator('[data-financial-record]')).toHaveCount(1);
});
test('failed, changed and malformed reads clear the earlier history and preserve an explicit retry',async({page})=>{
  const {panel,state}=await fixture(page,{entries:Array.from({length:60},(_,i)=>row(i+1))});state.status=409;await panel.getByRole('button',{name:'More records',exact:true}).click();await expect(panel).toHaveAttribute('data-state','error');await expect(panel.locator('[data-financial-record]')).toHaveCount(0);
  state.status=200;state.invalid=true;await panel.getByRole('button',{name:'Refresh financial history',exact:true}).click();await expect(panel).toHaveAttribute('data-state','error');await expect(panel).not.toContainText('$488.00');
  state.invalid=false;await panel.getByRole('button',{name:'Refresh financial history',exact:true}).click();await expect(panel).toHaveAttribute('data-state','ready');
});
test('a canceled read cannot paint its late private history',async({page})=>{
  const {panel,state}=await fixture(page);let release,arrived;const waiting=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);
  state.hold=async route=>{arrived();await gate;await json(route,{privateData:'PRIVATE_LATE_HISTORY'}).catch(()=>{});};
  await panel.getByRole('button',{name:'Refresh financial history',exact:true}).click();await waiting;await panel.getByRole('button',{name:'Cancel request',exact:true}).click();await expect(panel).toContainText('Financial-history request canceled');release();await expect(page.locator('body')).not.toContainText('PRIVATE_LATE_HISTORY');
});
test('account replacement prevents original-screen history downloads and clears the page',async({page})=>{
  const {panel,state}=await fixture(page),downloads=[];page.on('download',d=>downloads.push(d));state.session.user={...state.session.user,id:'222222222222222222222222',_id:'222222222222222222222222'};
  await panel.getByRole('button',{name:'Download CSV',exact:true}).click();await expect(page).toHaveURL(/\/login.html/);expect(downloads).toEqual([]);expect(state.exports).toEqual([]);
});
for(const theme of ['light','dark']) test(`original ${theme} history remains readable and accessible at desktop and enlarged phone sizes`,async({page},testInfo)=>{
  const {panel}=await fixture(page,{theme,entries:[row(1,{caseTitle:'<img src=x onerror="window.financialXss=true"> River Street '.repeat(3)}),row(2,{currency:'EUR'})]});
  if(theme==='dark') { await expect(page.locator('body')).toHaveClass(/theme-dark/); expect(await page.locator('body').evaluate(element=>getComputedStyle(element).backgroundColor)).toBe('rgb(17, 27, 42)'); expect(await panel.evaluate(element=>getComputedStyle(element.closest('.panel')).backgroundColor)).toBe('rgb(25, 37, 56)'); }
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});if(width===320)await page.addStyleTag({content:'html {font-size:34px !important;}'});
    await panel.getByLabel('Matter title',{exact:true}).focus();await expect(panel.getByLabel('Matter title',{exact:true})).toBeFocused();
    expect((await panel.getByLabel('Record type',{exact:true}).boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await page.evaluate(()=>window.financialXss)).toBeUndefined();
    expect((await new AxeBuilder({page}).include('[data-billing-surface]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await panel.getByRole('heading',{name:'Financial history',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath(`history-${width}.png`)});
    await panel.locator('[data-financial-record]').last().scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath(`history-records-${width}.png`)});
  }
});
