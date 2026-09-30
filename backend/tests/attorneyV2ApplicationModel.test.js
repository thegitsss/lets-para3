const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("application-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))}; import {parseRoute} from ${JSON.stringify(url("routes"))};
  const owner='a'.repeat(24),caseId='b'.repeat(24),applicantId='c'.repeat(24);
  const item={applicationId:'d'.repeat(24),applicantId,name:'Synthetic',profileAvailable:true,blocked:false,assigned:false,starred:false,resumeRecorded:false,linkedInRecorded:false,status:'withdrawn',matterStatus:null,appliedAt:null,withdrawnAt:null,coverLetter:'Saved letter',profileSnapshot:null,history:[],invitations:[],warnings:[]};
  const value={ownerId:owner,caseId,caseTitle:'Matter',caseStatus:'open',archived:false,selectedApplicantId:null,cursor:'',next:null,warnings:[],applications:[item]};
  ${source}`], { stdio: "pipe" }); };
test("the client rejects wrong account, Matter, selection, pagination, status and date rather than showing a false empty list", () => check(`
  assert.throws(()=>m.readApplications(value,caseId,'other'),e=>e.kind==='authentication');
  for(const patch of [{caseId:owner},{applications:null},{cursor:'m:0'},{next:'external'},{warnings:['madeup']},{selectedApplicantId:applicantId},{applications:[item,item]}]) assert.throws(()=>m.readApplications({...value,...patch},caseId,owner));
  for(const patch of [{status:'pending'},{appliedAt:'bad'},{applicationId:'external'},{history:[{to:'accepted',from:'unknown',at:'bad'}]},{profileSnapshot:{}},{invitations:[{status:'madeup'}]},{resumeRecorded:'yes'}]) assert.throws(()=>m.readApplications({...value,applications:[{...item,...patch}]},caseId,owner));
  assert.equal(m.readApplications({...value,applications:[]},caseId,owner).applications.length,0);
`));
test("the read model omits arbitrary confidential fields and preserves withdrawn history without profile edits", () => check(`
  const record=m.readApplications({...value,internalNotes:'PRIVATE',applications:[{...item,email:'PRIVATE',syncError:'PRIVATE',coverLetter:'<script>text</script>'}]},caseId,owner);
  assert.ok(!JSON.stringify(record).includes('PRIVATE'));assert.equal(record.applications[0].coverLetter,'<script>text</script>');assert.equal(record.applications[0].status,'withdrawn');assert.equal(m.applicationStatus('unknown'),'Status unavailable');
`));
test("profile links retain the exact applicant and return to its application; unavailable profiles have no link", () => check(`
  const href=m.applicationProfileHref(item,caseId),query=new URLSearchParams(href.split('?')[1]);
  assert.equal(query.get('applicantId'),applicantId);assert.equal(query.get('applicationId'),item.applicationId);assert.equal(query.get('returnTo'),'#/matters/'+caseId+'/applications?applicantId='+applicantId);assert.equal(parseRoute(query.get('returnTo')).name,'matter-applications');
  const original=new URL(m.applicationProfileHref(item,caseId,true),'https://local.test'),back=new URL(original.searchParams.get('returnTo'),original.origin);
  assert.equal(original.pathname,'/profile-paralegal.html');assert.equal(back.pathname,'/dashboard-attorney.html');
  assert.equal(back.searchParams.get('caseId'),caseId);assert.equal(back.searchParams.get('applicantId'),applicantId);assert.equal(back.searchParams.get('openApplicant'),'1');assert.equal(back.searchParams.get('applicationHistory'),'1');
  assert.equal(m.applicationProfileHref({...item,profileAvailable:false},caseId),null);assert.equal(m.applicationProfileHref(item,'bad'),null);
`));
test("only a recorded LinkedIn HTTP(S) address without credentials is exposed as an external link", () => check(`
  for(const address of ['javascript:alert(1)','//linkedin.com/in/person','https://linkedin.com.attacker.test/in/person','https://linkedin.com@attacker.test','https://user:password@linkedin.com/in/person','https://attacker.test/linkedin.com']) {
    assert.equal(m.readApplications({...value,applications:[{...item,linkedInRecorded:true,linkedInReference:address}]},caseId,owner).applications[0].linkedInReference,null);
  }
  const address='https://www.linkedin.com/in/submitted-profile';
  assert.equal(m.readApplications({...value,applications:[{...item,linkedInRecorded:true,linkedInReference:address}]},caseId,owner).applications[0].linkedInReference,address);
  assert.equal(m.readApplications({...value,applications:[{...item,linkedInReference:address}]},caseId,owner).applications[0].linkedInReference,null);
`));
test("every application page verifies the account before and after the read with no-store GET requests", () => check(`
  const calls=[],controller=new AbortController();let account=owner,lost=0;
  const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path,options)=>{calls.push({path,...options});return{ok:true,status:200,json:async()=>path==='/api/auth/me'?{user:{id:account,role:'attorney',status:'approved'}}:value};}});
  await api.readMatterApplications(caseId,{ownerId:owner,signal:controller.signal,cursor:'m:25'});assert.equal(calls.length,3);assert.ok(calls[1].path.includes('cursor=m%3A25'));assert.equal(calls[1].cache,'no-store');assert.equal(calls[1].method,'GET');
  account=caseId;await assert.rejects(api.readMatterApplications(caseId,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);assert.equal(calls.length,4);
`));
test("an account switch after the server read and aborted or malformed pages cannot return application data", () => check(`
  let count=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>({ok:true,status:200,json:async()=>path==='/api/auth/me'?{user:{id:++count===1?owner:caseId,role:'attorney',status:'approved'}}:value})});
  await assert.rejects(api.readMatterApplications(caseId,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);
  await assert.rejects(api.readMatterApplications(caseId,{ownerId:owner,cursor:'m:-1'}),TypeError);
  const controller=new AbortController();controller.abort();await assert.rejects(api.readMatterApplications(caseId,{ownerId:owner,signal:controller.signal}),e=>e.name==='AbortError');
`));
