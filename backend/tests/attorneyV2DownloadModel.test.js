const { execFileSync } = require("child_process"), { pathToFileURL } = require("url"), path = require("path");
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const run = source => { execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict';import * as m from ${JSON.stringify(url("download-model"))};import {createApiClient} from ${JSON.stringify(url("api-client"))};import {parseRoute} from ${JSON.stringify(url("routes"))};${source}`], { stdio: "pipe" }); };
const fixture = `const owner='a'.repeat(24),caseId='b'.repeat(24),file={id:'c'.repeat(24),name:'Agreement.txt',revision:'d'.repeat(64),size:12,version:1,uploadedAt:null,securityStatus:'pending'},value={ownerId:owner,caseId,caseTitle:'Matter',access:'available',legacyAttachments:false,files:[file],nextCursor:null};`;
test("file pages reject foreign identities, malformed files, duplicate IDs and misleading cursors", () => run(fixture+`
  assert.equal(m.readDownloads(value,caseId,owner),value);assert.equal(parseRoute('#/matters/'+caseId+'/files').name,'matter-downloads');
  for(const change of [{caseId:'foreign'},{access:'archive_only'},{files:[file,file]},{nextCursor:'e'.repeat(24)},{files:[{...file,revision:''}]},{files:[{...file,size:-1}]},{files:[{...file,uploadedAt:'invalid'}]}])assert.throws(()=>m.readDownloads({...value,...change},caseId,owner));
  assert.throws(()=>m.readDownloads(value,caseId,'other'),e=>e.kind==='authentication');
`));
test("download names and missing metadata are explicit without fabricated dates or versions", () => run(fixture+`
  assert.equal(m.fileName('../unsafe/<file>\\u0000.txt'),'-unsafe--file--.txt');assert.equal(m.fileName('...'),'Matter file');assert.ok(m.fileName('a'.repeat(200)).length<=180);
  assert.match(m.fileDescription({...file,size:null,version:null}),/Size unavailable.*Version unavailable.*Upload date unavailable/);assert.match(m.downloadError({code:'DOWNLOAD_SCAN_PENDING'}),/security check/);
`));
test("file reads and downloads verify the account, use one reviewed GET and verify again before returning bytes", () => run(fixture+`
  const calls=[];const bytes=new Blob(['synthetic']);const api=createApiClient({fetchImpl:async(path,options)=>{calls.push({path,...options});return {ok:true,status:200,headers:new Headers({'content-type':'application/octet-stream'}),blob:async()=>bytes,json:async()=>path==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:value};}});
  assert.equal(await api.readMatterDownloads(caseId,{ownerId:owner}),value);assert.equal(await api.downloadMatterFile(caseId,file.id,file.revision,{ownerId:owner}),bytes);
  assert.equal(calls.length,5);assert.ok(calls.every(call=>call.method==='GET'));assert.ok(calls[3].path.includes('revision='+file.revision));assert.equal(calls[4].path,'/api/auth/me');assert.equal(calls[3].cache,'no-store');
`));
test("HTTP file errors and HTML success responses cannot become downloaded blobs or trigger retries", () => run(fixture+`
  for(const mode of ['pending','html']){let files=0;const api=createApiClient({fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:owner,role:'attorney',status:'approved'}})}:(files++,{ok:mode==='html',status:mode==='html'?200:423,headers:new Headers({'content-type':'text/html'}),json:async()=>({code:'DOWNLOAD_SCAN_PENDING'}),blob:async()=>{throw new Error('must not read bytes');}})});
  await assert.rejects(api.downloadMatterFile(caseId,file.id,file.revision,{ownerId:owner}));assert.equal(files,1);}
`));
test("an account change after transfer rejects the old account's bytes", () => run(fixture+`
  let identities=0,lost=0;const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:++identities===1?owner:'f'.repeat(24),role:'attorney',status:'approved'}})}:{ok:true,status:200,headers:new Headers({'content-type':'application/octet-stream'}),blob:async()=>new Blob(['private'])}});
  await assert.rejects(api.downloadMatterFile(caseId,file.id,file.revision,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);
`));
test("clearing the API during a delayed transfer suppresses late bytes", () => run(fixture+`
  let release,started;const ready=new Promise(r=>started=r),wait=new Promise(r=>release=r);const api=createApiClient({fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:owner,role:'attorney',status:'approved'}})}:{ok:true,status:200,headers:new Headers({'content-type':'application/octet-stream'}),blob:async()=>{started();await wait;return new Blob(['private']);}}});
  const result=api.downloadMatterFile(caseId,file.id,file.revision,{ownerId:owner});await ready;api.clear();release();await assert.rejects(result,e=>e.name==='AbortError');
`));
test("clearing the API between the completed body read and its final identity check also discards the file", () => run(fixture+`
  const api=createApiClient({fetchImpl:async(path)=>path==='/api/auth/me'?{ok:true,json:async()=>({user:{id:owner,role:'attorney',status:'approved'}})}:{ok:true,status:200,headers:new Headers({'content-type':'application/octet-stream'}),blob:async()=>{queueMicrotask(()=>queueMicrotask(()=>api.clear()));return new Blob(['private']);}}});
  await assert.rejects(api.downloadMatterFile(caseId,file.id,file.revision,{ownerId:owner}),e=>e.name==='AbortError');
`));
