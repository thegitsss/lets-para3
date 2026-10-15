const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url("application-resume-model"))}; import {createApiClient} from ${JSON.stringify(url("api-client"))};
  const owner='a'.repeat(24),caseId='b'.repeat(24),applicantId='c'.repeat(24),item={applicationId:'d'.repeat(24),applicantId};
  const value={ownerId:owner,caseId,...item,name:'Application resume.pdf',size:14,revision:'e'.repeat(64)};
  ${source}`], { stdio: "pipe" }); };
test("only an exact account, Matter and application review can create a download control", () => check(`
  assert.deepEqual(m.readApplicationResume({...value,key:'PRIVATE_KEY'},caseId,owner,item),{name:value.name,size:14,revision:value.revision});
  for(const patch of [{ownerId:caseId},{caseId:owner},{applicantId:owner},{applicationId:owner},{applicationId:null},{name:'../private.pdf'},{size:0},{size:10*1024*1024+1},{size:5.5},{revision:'bad'},{revision:['e'.repeat(64)]}]) assert.throws(()=>m.readApplicationResume({...value,...patch},caseId,owner,item));
  assert.ok(m.readApplicationResume({...value,applicationId:null},caseId,owner,{...item,applicationId:null}));
`));
test("reads and downloads use fixed private routes and verify the account before and after each response", () => check(`
  const calls=[],bytes=new Blob(['%PDF-synthetic'],{type:'application/pdf'});
  const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});return new Response(path==='/api/auth/me'?JSON.stringify({user:{id:owner,role:'attorney',status:'approved'}}):path.includes('/download?')?bytes:JSON.stringify(value),{headers:{'Content-Type':path.includes('/download?')?'application/pdf':'application/json'}});}});
  assert.deepEqual(await api.readApplicationResume(caseId,applicantId,{ownerId:owner}),value);
  assert.equal((await api.downloadApplicationResume(caseId,applicantId,value.revision,{ownerId:owner})).size,bytes.size);
  assert.equal(calls.length,6);assert.ok(calls[1].path.includes('/'+applicantId+'/resume?'));assert.ok(calls[4].path.includes('revision='+value.revision));
  calls.forEach(call=>{assert.equal(call.method,'GET');assert.equal(call.cache,'no-store');assert.equal(call.redirect,'error');});
`));
test("lost accounts, aborts and invalid selections cannot return résumé bytes", () => check(`
  let count=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>new Response(path==='/api/auth/me'?JSON.stringify({user:{id:++count===1?owner:caseId,role:'attorney',status:'approved'}}):'%PDF-synthetic',{headers:{'Content-Type':path==='/api/auth/me'?'application/json':'application/pdf'}})});
  await assert.rejects(api.downloadApplicationResume(caseId,applicantId,value.revision,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);
  await assert.rejects(api.readApplicationResume(caseId,'bad',{ownerId:owner}),TypeError);
  await assert.rejects(api.downloadApplicationResume(caseId,applicantId,'bad',{ownerId:owner}),TypeError);
  const controller=new AbortController();controller.abort();await assert.rejects(api.readApplicationResume(caseId,applicantId,{ownerId:owner,signal:controller.signal}),e=>e.name==='AbortError');
`));
test("HTML, fake PDFs and oversized payloads cannot be delivered as résumés", () => check(`
  for(const [content,type] of [['<h1>error</h1>','text/html'],['HTML dressed as PDF','application/pdf'],['%PDF-'+ 'a'.repeat(10*1024*1024),'application/pdf']]){
    const api=createApiClient({fetchImpl:async(path)=>new Response(path==='/api/auth/me'?JSON.stringify({user:{id:owner,role:'attorney',status:'approved'}}):content,{headers:{'Content-Type':path==='/api/auth/me'?'application/json':type}})});
    await assert.rejects(api.downloadApplicationResume(caseId,applicantId,value.revision,{ownerId:owner}),e=>e.kind==='invalid_response');
  }
`));
test("résumé failures identify the document state without echoing server text", () => check(`
  for(const suffix of ['NOT_RECORDED','MISSING','REFERENCE_INVALID','CHANGED','SCAN_PENDING','BLOCKED','SCAN_ERROR','TOO_LARGE','INVALID_FILE']){
    const text=m.applicationResumeError({code:'APPLICATION_REVIEW_RESUME_'+suffix,message:'PRIVATE_INTERNAL_ERROR'});assert.ok(text.length>30);assert.ok(!text.includes('PRIVATE_INTERNAL_ERROR'));
  }
  assert.match(m.applicationResumeError({code:'APPLICATION_REVIEW_RESUME_MISSING'}),/no longer in document storage/);
`));
