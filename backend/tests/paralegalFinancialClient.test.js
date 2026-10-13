const { execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url'), path = require('node:path');
const moduleUrl = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/utils/${name}.mjs`)).href;
const run = source => void execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import * as f from ${JSON.stringify(moduleUrl('paralegal-financials'))}; import * as h from ${JSON.stringify(moduleUrl('paralegal-history'))}; ${fixture} ${source}`], { stdio: 'pipe' });
const fixture = `
const owner='a'.repeat(24), caseId='b'.repeat(24), revision='c'.repeat(64);
const group={currency:'EUR',stripeMode:'test',count:1,total:8100,month:8100,last30:8100,undated:0};
const report={ownerId:owner,revision,asOf:'2026-09-10T00:00:00.000Z',monthStart:'2026-09-01T00:00:00.000Z',last30Start:'2026-08-11T00:00:00.000Z',currencies:[group],states:{recorded:1,needs_review:0,pending:0,failed:0,reversed:0},count:1,requiresReview:0,undated:0};
const selection='d'.repeat(64), receipt={receiptId:selection,receiptRevision:revision,payoutState:'recorded',paymentAmount:81,currency:'EUR',stripeMode:'test',recordedAt:'2026-09-01T00:00:00Z',receiptAvailable:true,href:'/api/payments/receipt/paralegal/'+caseId+'?'+new URLSearchParams({receiptId:selection,expectedOwnerId:owner,receiptRevision:revision})};
const item={caseId,title:'Retained assignment',workState:'withdrawn',completedAt:'2026-09-01T00:00:00Z',...receipt,receipts:[receipt]};
const page={ownerId:owner,revision,items:[item],page:{total:1,limit:100,offset:0,hasMore:false,nextCursor:null}};
const auth={user:{id:owner,role:'paralegal',status:'approved'}};
`;
test('earnings reject wrong owners, dates, units, counts and invented period totals', () => run(`
  assert.equal(f.readEarningsReport(report,owner),report);
  for (const change of [{ownerId:caseId},{monthStart:'2026-09-02T00:00:00Z'},{count:2},{currencies:[group,group]},{currencies:[{...group,stripeMode:'unknown'}]},{currencies:[{...group,currency:'ZZZ'}]},{currencies:[{...group,month:8200}]},{currencies:[{...group,undated:1}],undated:1}]) assert.throws(()=>f.readEarningsReport({...report,...change},owner));
  assert.equal(f.readEarningsReport({...report,undated:1,currencies:[{...group,undated:1,month:null,last30:null}]},owner).currencies[0].month,null);
  assert.equal(f.payoutMoney(null,'USD'),'Unavailable');
`));
test('estimates require matching assignment, fee and currency groups and expose unavailable evidence', () => run(`
  const estimate={ownerId:owner,revision,items:[{caseId,currency:'USD',stripeMode:'test',grossCents:30000,feeCents:5400,netCents:24600,state:'estimate'}],currencies:[{currency:'USD',stripeMode:'test',netCents:24600,count:1,requiresReview:0}],requiresReview:0};
  assert.equal(f.readExpectedCompensation(estimate,owner),estimate);
  for(const change of [{ownerId:caseId},{requiresReview:1},{currencies:[]},{items:[estimate.items[0],estimate.items[0]]},{items:[{...estimate.items[0],netCents:32800}]},{currencies:[{...estimate.currencies[0],netCents:32800}]}])assert.throws(()=>f.readExpectedCompensation({...estimate,...change},owner));
  assert.equal(f.readExpectedCompensation({...estimate,items:[{...estimate.items[0],currency:null,stripeMode:'unknown',netCents:null,state:'needs_review'}],currencies:[],requiresReview:1},owner).requiresReview,1);
`));
test('history rejects missing pages, foreign receipt links, ambiguous zeroes and repeated choices', () => run(`
  assert.equal(h.readHistoryPage(page,owner),page);
  for(const change of [{ownerId:caseId},{page:{...page.page,total:2}},{page:{...page.page,nextCursor:revision+':1'}},{items:[{...item,receipts:[receipt,receipt]}]},{items:[{...item,paymentAmount:null}]},{items:[{...item,receipts:[{...receipt,href:'/api/payments/receipt/paralegal/'+caseId}]}]},{items:[{...item,receipts:[{...receipt,payoutState:'no_payout'}]}]}])assert.throws(()=>h.readHistoryPage({...page,...change},owner));
`));
test('all history pages retain source revision and verify the final signed-in account', () => run(`
  const second={...item,caseId:'e'.repeat(24),receipts:[{...receipt,href:receipt.href.replace(caseId,'e'.repeat(24))}],href:receipt.href.replace(caseId,'e'.repeat(24))}; let reads=0;
  const api={get:async path=>path==='/api/auth/me'?auth:++reads===1?{...page,page:{total:2,limit:1,offset:0,hasMore:true,nextCursor:revision+':1'}}:{...page,items:[second],page:{total:2,limit:1,offset:1,hasMore:false,nextCursor:null}}};
  assert.equal((await h.loadParalegalHistory(api,owner)).items.length,2);assert.equal(reads,2);
  await assert.rejects(h.loadParalegalHistory({get:async path=>path==='/api/auth/me'?{user:{...auth.user,id:caseId}}:page},owner),e=>e.status===403);
`));
test('incomplete, repeated or changed subsequent history pages never return partial success', () => run(`
  for(const mode of ['changed','repeated','failed']){let reads=0;await assert.rejects(h.loadParalegalHistory({get:async()=>{if(++reads===1)return {...page,page:{total:2,limit:1,offset:0,hasMore:true,nextCursor:revision+':1'}};if(mode==='failed')throw Error('503');return {...page,revision:mode==='changed'?'d'.repeat(64):revision,page:{total:2,limit:1,offset:1,hasMore:false,nextCursor:null}};}},owner));assert.equal(reads,2);}
`));
test('receipt downloads check current identity before and after verified PDF bytes', () => run(`
  const calls=[],blob=new Blob(['%PDF-1.4 synthetic'],{type:'application/pdf'}),api={get:async path=>(calls.push(path),auth),blob:async path=>(calls.push(path),blob)};
  assert.equal(await h.downloadParalegalReceipt(api,receipt,caseId,owner),blob);assert.deepEqual(calls,['/api/auth/me',receipt.href,'/api/auth/me']);
`));
test('foreign late identities, false PDFs, failures and canceled late bodies cannot download', () => run(`
  for(const mode of ['owner','html','false-pdf','failed','canceled']) { let reads=0;const controller=new AbortController(); const api={get:async()=>({user:{...auth.user,id:mode==='owner'&&++reads===2?caseId:owner}}),blob:async()=>{if(mode==='failed')throw Object.assign(Error('changed'),{status:409});if(mode==='canceled')controller.abort();return new Blob([mode==='false-pdf'?'<html>error':'%PDF-1.4 synthetic'],{type:mode==='html'?'text/html':'application/pdf'});}};await assert.rejects(h.downloadParalegalReceipt(api,receipt,caseId,owner,{signal:controller.signal}));}
`));

test('history accepts the bounded review state and earlier responses without it, but rejects invented states', () => run(`
  assert.equal(h.readHistoryPage(page,owner),page);
  for (const reviewState of [null,'open']) assert.equal(h.readHistoryPage({...page,items:[{...item,reviewState}]},owner).items[0].reviewState,reviewState);
  for (const reviewState of ['resolved','paid',true,{},0]) assert.throws(()=>h.readHistoryPage({...page,items:[{...item,reviewState}]},owner));
`));


test('termination history keeps its review separate from completion and rejects inconsistent context', () => run(`
  const value={...item,workState:'needs_review',reviewState:'open',reviewKind:'termination'};
  assert.equal(h.readHistoryPage({...page,items:[value]},owner).items[0].reviewKind,'termination');
  assert.equal(h.historyWorkLabel(value.workState,value.reviewKind),'Termination review');
  for (const change of [{reviewKind:'paid'},{reviewState:null},{workState:'completed'},{reviewKind:true}]) assert.throws(()=>h.readHistoryPage({...page,items:[{...value,...change}]},owner));
`));
