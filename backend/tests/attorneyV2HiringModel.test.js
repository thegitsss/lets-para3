const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("hiring-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))};
const ownerId='a'.repeat(24),caseId='b'.repeat(24),applicantId='c'.repeat(24),revision='d'.repeat(64);const value={ownerId,caseId,applicantId,revision,caseTitle:'Matter',name:'Applicant',reason:'ready',canHire:true,canResume:false,relisted:false,assigned:false,fundingVerified:false,budgetCents:40001,feeCents:8800,chargeCents:48801,remainingCents:null,currency:'usd',card:{id:'pm_synthetic',type:'card',brand:'visa',last4:'4242',exp_month:12,exp_year:2029}}; ${source}`], { stdio: "pipe" }); };
test("only coherent exact-party hiring reviews can offer a charge", () => check(`
 assert.equal(m.readHiringReview(value,caseId,ownerId,applicantId).chargeCents,48801);assert.equal(m.hiringMoney(value,48801),'$488.01');for(const patch of [{ownerId:caseId},{applicantId:ownerId},{chargeCents:48000},{card:null},{feeCents:null},{budgetCents:39999},{canHire:false}])assert.throws(()=>m.readHiringReview({...value,...patch},caseId,ownerId,applicantId));
`));
test("replacement and verified-charge recovery have distinct zero-new-charge confirmations", () => check(`
 const replacement={...value,relisted:true,chargeCents:0,feeCents:0,remainingCents:12000,card:null,fundingVerified:true};assert.equal(m.readHiringReview(replacement,caseId,ownerId,applicantId).canHire,true);assert.throws(()=>m.readHiringReview({...replacement,fundingVerified:false},caseId,ownerId,applicantId));const resume={...value,reason:'reconciliation',canHire:false,canResume:true,card:null,fundingVerified:true};assert.equal(m.readHiringReview(resume,caseId,ownerId,applicantId).canResume,true);assert.throws(()=>m.readHiringReview({...resume,fundingVerified:false},caseId,ownerId,applicantId));
`));
test("success acknowledgements identify the reviewed target, revision, amount and mode", () => check(`
 const ack={caseId,applicantId,reviewedRevision:revision,mode:'hire_and_fund',chargeCents:48801,budgetCents:40001,remainingCents:null};m.confirmHiring({hiringConfirmation:ack},value);for(const patch of [{applicantId:ownerId},{reviewedRevision:'e'.repeat(64)},{chargeCents:40001},{mode:'replacement'}])assert.throws(()=>m.confirmHiring({hiringConfirmation:{...ack,...patch}},value));assert.throws(()=>m.confirmHiring({success:true},value));
`));
test("unconfirmed hiring survives route changes only in tab memory and erases with account protection", () => check(`
 const state=createPrivateState();state.hiring.set(caseId+':'+applicantId,{pending:{caseId,applicantId}});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.hiring.size,0);assert.equal(state.hasUnsaved(),false);
`));
test("reviewed hiring sends one CSRF-bound request and never retries a lost acknowledgement", () => check(`
 const calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});if(options.method==='POST')throw new Error('lost');return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:ownerId,role:'attorney',status:'approved'}}:{csrfToken:'synthetic'}));}});await assert.rejects(api.hireReviewedApplicant(caseId,applicantId,revision,{ownerId}));const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic');assert.deepEqual(JSON.parse(writes[0].body),{expectedOwnerId:ownerId,reviewedRevision:revision});
`));

test("an unresolved earlier withdrawal offers a specific explanation without hiring", () => check(`
 const review={...value,reason:'withdrawal_review_required',canHire:false,relisted:true,chargeCents:0,feeCents:0,remainingCents:12000,card:null,fundingVerified:true};
 assert.equal(m.readHiringReview(review,caseId,ownerId,applicantId).canHire,false);assert.match(m.hiringReason(review),/earlier withdrawal or payout needs review/);assert.throws(()=>m.readHiringReview({...review,canHire:true},caseId,ownerId,applicantId));
 assert.match(m.hiringError({code:'HIRING_WITHDRAWAL_REVIEW_REQUIRED'}),/Refresh the hiring review/);
`));
