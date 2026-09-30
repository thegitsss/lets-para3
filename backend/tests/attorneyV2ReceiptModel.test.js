const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const run = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict';import * as m from ${JSON.stringify(url("receipt-model"))};import {createApiClient} from ${JSON.stringify(url("api-client"))};import {parseRoute} from ${JSON.stringify(url("routes"))};${source}`], { stdio: "pipe" }); };
const fixture = `const owner='a'.repeat(24),caseId='b'.repeat(24),revision='c'.repeat(64),receipt={type:'payment',id:'pi_example',currency:'USD',issuedAt:null,dateLabel:'Payment date',status:'received',method:'Payment method unavailable',lines:[{label:'Matter amount',amount:40000},{label:'Platform fee (22%)',amount:8800}],total:{label:'Total paid',amount:48800},partyName:'Avery Lane',filename:'Agreement-payment-receipt.pdf'},value={ownerId:owner,caseId,caseTitle:'Agreement',reason:'available',revision,receipt};`;
test("zero receipt presentation accepts one zero total but never erases a positive payment", () => run(fixture+`
  const zero={...receipt,type:'withdrawal',dateLabel:'Withdrawal decision date',status:'no_payout',method:null,lines:[],total:{label:'Total released',amount:0}};
  assert.equal(m.readReceipt({...value,receipt:zero},caseId,owner).receipt,zero);
  for(const changed of [{total:{label:'Total released',amount:1}},{lines:[{label:'Payout',amount:1}]},{status:'payout_recorded'},{stripeMode:'invented'}])assert.throws(()=>m.readReceipt({...value,receipt:{...zero,...changed}},caseId,owner));
  assert.equal(m.readReceipt({...value,receipt:{...receipt,stripeMode:'test'}},caseId,owner).receipt.stripeMode,'test');
  for(const dateLabel of ['Payout date','Payout recorded'])assert.equal(m.readReceipt({...value,receipt:{...receipt,type:'withdrawal',dateLabel,status:'payout_recorded'}},caseId,owner).receipt.dateLabel,dateLabel);
`));
test("receipt projections reject foreign identities, unavailable downloads and malformed financial details", () => run(fixture+`
  assert.equal(m.readReceipt(value,caseId,owner),value);assert.equal(parseRoute('#/matters/'+caseId+'/receipt').name,'matter-receipt');
  assert.throws(()=>m.readReceipt(value,caseId,'other'),e=>e.kind==='authentication');
  for(const change of [{caseId:'other'},{reason:'not_funded'},{revision:''},{receipt:{...receipt,currency:'JPY'}},{receipt:{...receipt,currency:'ZZZ'}},{receipt:{...receipt,currency:'XXX'}},{receipt:{...receipt,currency:'XAU'}},{receipt:{...receipt,issuedAt:'invalid'}},{receipt:{...receipt,total:{label:'Total',amount:-1}}},{receipt:{...receipt,status:'payout_recorded'}},{receipt:{...receipt,filename:'../receipt.pdf'}}])assert.throws(()=>m.readReceipt({...value,...change},caseId,owner));
  assert.equal(m.readReceipt({...value,reason:'not_funded',revision:null,receipt:null},caseId,owner).receipt,null);assert.equal(m.receiptDate(null),'Date unavailable');assert.equal(m.receiptMoney(48800,'USD'),'$488.00');
`));
test("review and PDF requests verify identity and never make financial mutations", () => run(fixture+`
  const calls=[];const bytes=new Blob(['%PDF-1.4 synthetic']);const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});return {ok:true,status:200,headers:new Headers({'content-type':'application/pdf'}),blob:async()=>bytes,json:async()=>path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:value};}});
  assert.equal(await api.readMatterReceipt(caseId,{ownerId:owner}),value);assert.equal(await api.downloadMatterReceipt(caseId,revision,{ownerId:owner}),bytes);assert.equal(calls.length,6);assert.equal(calls[2].path,'/api/auth/me');assert.ok(calls.every(call=>call.method==='GET'));assert.equal(calls[4].headers.Accept,'application/pdf');assert.ok(calls[4].path.includes('revision='+revision));assert.equal(calls[5].path,'/api/auth/me');
`));
test("HTTP failures, HTML and falsely labelled PDF bodies cannot become downloaded receipts", () => run(fixture+`
  for(const mode of ['http','html','fake-pdf']){let gets=0;const api=createApiClient({fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:owner,role:'attorney',status:'approved'}})}:(gets++,{ok:mode!=='http',status:mode==='http'?409:200,headers:new Headers({'content-type':mode==='html'?'text/html':'application/pdf'}),json:async()=>({code:'RECEIPT_CHANGED'}),blob:async()=>new Blob(['<h1>Error</h1>'])})});await assert.rejects(api.downloadMatterReceipt(caseId,revision,{ownerId:owner}));assert.equal(gets,1);}
`));
test("a changed account after the PDF arrives discards the old receipt", () => run(fixture+`
  let identities=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:++identities===1?owner:'f'.repeat(24),role:'attorney',status:'approved'}})}:{ok:true,status:200,headers:new Headers({'content-type':'application/pdf'}),blob:async()=>new Blob(['%PDF-private'])}});await assert.rejects(api.downloadMatterReceipt(caseId,revision,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);
`));
test("API clearing and explicit cancellation discard a delayed PDF", () => run(fixture+`
  for(const mode of ['clear','cancel']){let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r),controller=new AbortController();const api=createApiClient({fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:owner,role:'attorney',status:'approved'}})}:{ok:true,status:200,headers:new Headers({'content-type':'application/pdf'}),blob:async()=>{started();await gate;return new Blob(['%PDF-private']);}}});const result=api.downloadMatterReceipt(caseId,revision,{ownerId:owner,signal:controller.signal});await ready;if(mode==='clear')api.clear();else controller.abort();release();await assert.rejects(result,e=>e.name==='AbortError');}
`));
test("clearing during PDF signature verification also cancels the whole operation", () => run(fixture+`
  let api;const bytes={slice:()=>({text:async()=>{api.clear();return '%PDF-';}})};api=createApiClient({fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:owner,role:'attorney',status:'approved'}})}:{ok:true,status:200,headers:new Headers({'content-type':'application/pdf'}),blob:async()=>bytes}});await assert.rejects(api.downloadMatterReceipt(caseId,revision,{ownerId:owner}),e=>e.name==='AbortError');
`));
