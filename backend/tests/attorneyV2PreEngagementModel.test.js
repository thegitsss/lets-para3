const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("pre-engagement-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {createPrivateState} from ${JSON.stringify(url("private-state"))};
 const owner='a'.repeat(24),caseId='b'.repeat(24),applicantId='c'.repeat(24), revision='d'.repeat(64);
 const value={caseId,ownerId:owner,applicantId,caseTitle:'Matter',name:'Applicant',revision,reason:'ready',canRequest:true,canReview:false,canApprove:false,selectedRequest:false,request:null};
 ${source}`], { stdio: "pipe" }); };
test("pre-engagement binds exact parties and fails closed for malformed or contradictory states", () => check(`
 assert.equal(m.readPreEngagement(value,caseId,owner,applicantId).canRequest,true);
 for(const patch of [{ownerId:caseId},{caseId:owner},{applicantId:owner},{revision:'bad'},{canRequest:'true'},{canApprove:true},{canReview:true},{selectedRequest:true},{request:{}},{reason:'unknown'}]) assert.throws(()=>m.readPreEngagement({...value,...patch},caseId,owner,applicantId));
 for(const key of ['cases/'+owner+'/pre-engagement/a.pdf','cases/'+caseId+'/pre-engagement/../a.pdf','cases/'+caseId+'/pre-engagement/%2e%2e/a.pdf','https://example.test/file.pdf'])assert.equal(m.preEngagementKey(key,caseId),null);
 assert.equal(m.preEngagementKey('cases/'+caseId+'/pre-engagement/a.pdf',caseId),'cases/'+caseId+'/pre-engagement/a.pdf');
`));
test("request validation requires the actual conflict details and the same applicant's reusable agreement", () => check(`
 assert.ok(m.requestProblem({confidentiality:false,conflicts:false,details:''},value));
 assert.ok(m.requestProblem({confidentiality:true,conflicts:false,details:''},value));
 assert.ok(m.requestProblem({confidentiality:false,conflicts:true,details:' '},value));
 assert.equal(m.requestProblem({confidentiality:false,conflicts:true,details:'Synthetic parties'},value),'');
 const saved={...value,selectedRequest:true,request:{status:'requested',documents:[{kind:'attorney',key:'saved'}]}};
 assert.equal(m.requestProblem({confidentiality:true,conflicts:false,details:''},saved),'');
 assert.ok(m.requestProblem({confidentiality:true,conflicts:false,details:''},{...saved,selectedRequest:false}));
 assert.ok(m.requestProblem({confidentiality:true,conflicts:false,details:'',file:{size:11*1024*1024,name:'oversize.pdf'}},value));
`));
test("private drafts and unconfirmed actions are erased on account loss; simply reading does not mark unsaved work", () => check(`
 const state=createPrivateState();state.preEngagement.set(caseId,{draft:{dirty:false}});assert.equal(state.hasUnsaved(),false);
 state.preEngagement.get(caseId).draft.dirty=true;assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.preEngagement.size,0);
 state.preEngagement.set(caseId,{pending:{action:'approve'}});assert.equal(state.hasUnsaved(),true);state.clear();assert.equal(state.hasUnsaved(),false);
`));
test("multipart requests verify the owner, attach CSRF and exact review, and never retry lost writes", () => check(`
 const calls=[];const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});if(options.method==='POST')throw new Error('lost response');return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:{csrfToken:'synthetic'}));}});
 const file=new File(['%PDF-synthetic'],'agreement.pdf',{type:'application/pdf'});
 await assert.rejects(api.requestPreEngagement(caseId,applicantId,{reviewedRevision:revision,confidentialityAgreementRequired:true,file},{ownerId:owner}));
 const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].headers['X-CSRF-Token'],'synthetic');assert.equal(writes[0].headers['Content-Type'],undefined);assert.equal(writes[0].body.get('expectedOwnerId'),owner);assert.equal(writes[0].body.get('reviewedRevision'),revision);assert.equal(await writes[0].body.get('confidentialityFile').text(),'%PDF-synthetic');
`));
test("late account changes discard saved responses and revoked document references never yield a link", () => check(`
 let reads=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:++reads>1?caseId:owner,role:'attorney',status:'approved'}}:path==='/api/csrf'?{csrfToken:'synthetic'}:{success:true}))});
 await assert.rejects(api.reviewPreEngagement(caseId,applicantId,{reviewedRevision:revision,action:'approve'},{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);
 const calls=[];const documents=createApiClient({fetchImpl:async(path)=>{calls.push(path);return new Response(JSON.stringify(path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:value));}});
 await assert.rejects(documents.openPreEngagementDocument(caseId,applicantId,revision,'private-key',{ownerId:owner}),e=>e.status===409);assert.equal(calls.some(path=>path.startsWith('/api/uploads/')),false);
`));
