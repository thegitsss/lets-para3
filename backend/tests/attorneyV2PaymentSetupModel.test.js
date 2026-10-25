const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("payment-setup-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))};
const owner='a'.repeat(24),caseId='b'.repeat(24),paralegalId='c'.repeat(24),revision='d'.repeat(64); const card={id:'pm_synthetic',type:'card',brand:'visa',last4:'4242',exp_month:12,exp_year:2029}; ${source}`], { stdio: "pipe" }); };
test("saved hiring returns use exact identifiers and never use earlier arbitrary URLs", () => check(`
 const value={ownerId:owner,revision,pending:{state:'available',caseId,paralegalId,caseTitle:'Matter',paralegalName:'Applicant',fundUrl:'https://outside.example'}};
 assert.equal(m.hiringReturnHref(m.readHiringReturn(value,owner).pending),'#/matters/'+caseId+'/applications?applicantId='+paralegalId);
 assert.equal(m.hiringReturnHref(m.readHiringReturn(value,owner).pending,{current:true}),'/dashboard-attorney.html?caseId='+caseId+'&applicantId='+paralegalId+'&openApplicant=1&continueHire=1#cases:inquiries');
 assert.equal(m.hiringReturnHref({...value.pending,state:'earlier'},{current:true}),null);
 assert.equal(m.hiringReturnHref({...value.pending,state:'earlier'}),null);assert.throws(()=>m.readHiringReturn({...value,ownerId:caseId},owner));assert.throws(()=>m.readHiringReturn({...value,pending:{...value.pending,paralegalId:'bad'}},owner));
`));
test("missing and malformed cards cannot appear saved", () => check(`
 assert.equal(m.readDefaultCard({hasDefault:false,paymentMethod:null}).card,null);assert.equal(m.readDefaultCard({hasDefault:true,paymentMethod:card}).card.last4,'4242');
 for(const value of [{},{hasDefault:true,paymentMethod:null},{hasDefault:false,paymentMethod:card},{hasDefault:true,paymentMethod:{...card,exp_month:13}}])assert.throws(()=>m.readDefaultCard(value));
 assert.equal(m.readDefaultCard({hasDefault:true,paymentMethod:null,devBypass:true}).bypass,true);
`));
test("setup verification requires the exact owner, intent and complete card record", () => check(`
 const value={ownerId:owner,intentId:'seti_synthetic',status:'succeeded',paymentMethod:card};assert.equal(m.readSetup(value,owner,'seti_synthetic').card.id,card.id);
 for(const patch of [{ownerId:caseId},{intentId:'seti_other'},{status:'unknown'},{status:'processing'},{paymentMethod:null}])assert.throws(()=>m.readSetup({...value,...patch},owner,'seti_synthetic'));
`));
test("provider return secrets are removed and query status cannot assert success", () => check(`
 const current=m.consumeSetupReturn('https://lpc.invalid/attorney-v2.html?hiringReturn=current&setup_intent=seti_synthetic&setup_intent_client_secret=private&redirect_status=succeeded#/home');
 assert.deepEqual(current,{present:true,intentId:'seti_synthetic',cleanUrl:'/attorney-v2.html?hiringReturn=current#/payments/setup'});
 const result=m.consumeSetupReturn('https://lpc.invalid/attorney-v2.html?setup_intent=seti_synthetic&setup_intent_client_secret=private&redirect_status=succeeded#/home');
 assert.deepEqual(result,{present:true,intentId:'seti_synthetic',cleanUrl:'/attorney-v2.html#/payments/setup'});assert.equal(m.consumeSetupReturn('https://lpc.invalid/attorney-v2.html?setup_intent=bad/target&redirect_status=succeeded').intentId,null);
`));
test("card drafts and unconfirmed returns remain in memory and erase with account protection", () => check(`
 const state=createPrivateState();state.paymentSetup.intentId='seti_synthetic';state.paymentSetup.pending=true;state.hiringReturn.pending=true;assert.equal(state.hasUnsaved(),true);state.clear();assert.deepEqual(state.paymentSetup,{});assert.deepEqual(state.hiringReturn,{});assert.equal(state.hasUnsaved(),false);
`));
test("setup requests carry CSRF and a stable request key without automatic resubmission", () => check(`
 const calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});if(options.method==='POST')throw new Error('lost');return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:{csrfToken:'synthetic'}));}});
 await assert.rejects(api.startCardSetup('synthetic-request-key',{ownerId:owner}));const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic');assert.equal(writes[0].headers['Idempotency-Key'],'synthetic-request-key');assert.deepEqual(JSON.parse(writes[0].body),{expectedOwnerId:owner});
`));
test("account replacement after a card save discards its acknowledgement", () => check(`
 let reads=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:++reads>1?caseId:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{ok:true,paymentMethod:card}))});await assert.rejects(api.setDefaultCard(card.id,'seti_synthetic',{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);
`));
