'use strict';
const {test,expect,snapshot}=require('../shared-strict-observation.cjs');
const start=require('../../helpers/financialLifecycleBrowserServer');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const formats=require('./fixtures/supported-formats/manifest.json').formats;
let server;
test.beforeAll(async()=>{test.setTimeout(240000);server=await start({port:0,includeSyntheticDownloads:true});});
test.beforeEach(async()=>server.reset());
test.afterAll(async()=>server?.close());
const panel=p=>p.locator('[data-workspace-files]');
const detail=p=>panel(p).getByRole('region',{name:'Document review'});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function api(person,method,url,data){const csrf=await(await person.context.request.get(server.origin+'/api/csrf')).json();const response=await person.context.request[method](server.origin+url,{headers:{'X-CSRF-Token':csrf.csrfToken},...(data?{data}:{})});expect(response.ok(),method+' '+url+' '+response.status()).toBe(true);return response.json();}
async function actor(browser,role){const person=await server.createUser(role,{},true),context=await browser.newContext({viewport:{width:1366,height:900}});context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(30000);await context.addCookies([person.cookie]);await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort('blockedbyclient'));return {...person,context,page:await context.newPage()};}
async function money(id){const doc=await require('../../../models/Case').collection.findOne({_id:new(require('mongoose').Types.ObjectId)(id)});const fields=['escrowIntentId','escrowStatus','totalAmount','lockedTotalAmount','currency','paymentReleased','fundedAt','payoutFinalizedAt','payoutFinalizedType','payoutFinalizedAmount','withdrawalPayoutAmount','payoutHistory','disputeId'];return Object.fromEntries(fields.filter(k=>Object.hasOwn(doc,k)).map(k=>[k,doc[k]]));}
async function download(page,button,format,record,role){const pending=page.waitForEvent('download');await button.click();const value=await pending,bytes=await fs.readFile(await value.path());expect(sha(bytes)).toBe(format.sha256);expect(bytes.length).toBe(format.bytes);expect(value.suggestedFilename()).toBe(format.name);record.downloads.push({role,name:format.name,sha256:sha(bytes),bytes:bytes.length,filename:value.suggestedFilename()});}
test('actual supported file formats retain stored identity and both-role native exact-byte downloads with current preview capability',async({browser},info)=>{
 const record={formats,uploads:[],downloads:[],previews:[],nativePdfRendererClaim:false,providerBoundary:'Synthetic local storage; no scan/provider/encryption or native Office application claim.'};
 let id,financialBefore,people;
 try{
  people={attorney:await actor(browser,'attorney'),paralegal:await actor(browser,'paralegal')};
  const published=await api(people.attorney,'post','/api/cases',{title:'Finite supported-format acceptance',practiceArea:'immigration',state:'CA',totalAmount:400,experience:'5+ years',deadline:'2027-03-14',description:'CONFIDENTIAL synthetic format transport and preview review.',tasks:[{title:'Review supported formats'}]});
  id=String(published.case?._id||published._id||published.id);
  await api(people.paralegal,'post',`/api/jobs/${published.jobId}/apply`,{coverLetter:'I can review the fixture documents.'});
  await api(people.attorney,'post','/api/payments/payment-method/default',{paymentMethodId:'pm_browser_card'});
  const hiring=await api(people.attorney,'get',`/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
  await api(people.attorney,'post',`/api/cases/${id}/hire/${people.paralegal.id}`,{expectedOwnerId:people.attorney.id,reviewedRevision:hiring.revision});
  financialBefore=await money(id);
  const para=people.paralegal.page;await para.goto(`${server.origin}/paralegal-v2.html#/matter/${id}?tab=files`);
  const uploadCounts={};para.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===`/api/uploads/case/${id}`)uploadCounts.total=(uploadCounts.total||0)+1;});
  for(const format of formats){
   const bytes=await fs.readFile(path.join(__dirname,'fixtures/supported-formats',format.name));expect(sha(bytes)).toBe(format.sha256);
   await para.locator('[data-v2-file-input]').setInputFiles({name:format.name,mimeType:format.mimeType,buffer:bytes});
   await para.getByRole('button',{name:'Submit file',exact:true}).click();
   const saved=para.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/uploads/case/${id}`);
   await para.getByRole('dialog',{name:'Submit this file?'}).getByRole('button',{name:'Submit file',exact:true}).click();
   expect((await saved).status()).toBe(201);await expect(para.getByRole('dialog',{name:'Submit this file?'})).toHaveCount(0);record.uploads.push({name:format.name,mimeType:format.mimeType,sha256:format.sha256,status:201});
  }
  expect(uploadCounts.total).toBe(formats.length);
  const inventory=await api(people.paralegal,'get',`/api/uploads/case/${id}?presentation=matter`);
  expect(inventory.files).toHaveLength(formats.length);
  const {decryptCaseFilePayload}=require('../../../utils/dataEncryption'),CaseFile=require('../../../models/CaseFile');
  record.stored=[];
  for(const format of formats){const file=inventory.files.find(row=>row.originalName===format.name);expect(file).toBeTruthy();format.id=String(file.id||file._id);const stored=decryptCaseFilePayload(await CaseFile.findById(format.id).lean());expect(stored.mimeType).toBe(format.mimeType);expect(stored.originalName).toBe(format.name);expect(stored.size).toBe(format.bytes);record.stored.push({id:format.id,name:stored.originalName,mimeType:stored.mimeType,size:stored.size,storageKey:stored.storageKey});}
  expect(new Set(formats.map(x=>x.id)).size).toBe(formats.length);
  record.beforeTransfers=await snapshot();
  const attorney=people.attorney.page;await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${id}/files`);await expect(panel(attorney)).toHaveAttribute('data-state','ready');
  for(const format of formats){
   await panel(attorney).locator(`[data-download-file="${format.id}"]`).getByRole('button').click();await expect(detail(attorney)).toContainText(format.name);
   const type=({ 'application/pdf':'pdf','image/png':'image','image/jpeg':'image','image/gif':'image','text/plain':'text','text/csv':'text' })[format.mimeType]||null;
   const preview=detail(attorney).getByRole('button',{name:'Preview file',exact:true});
   if(!type){await expect(preview).toHaveCount(0);expect(await para.locator(`[data-v2-file-download="${format.id}"]`).locator('..').getByRole('link',{name:'Open',exact:true}).count()).toBe(0);record.previews.push({name:format.name,capability:'download only',noOfficeInlinePromised:true});}
   else if(type==='pdf'){
    const enabled=await attorney.evaluate(()=>navigator.pdfViewerEnabled!==false);
    if(enabled){const response=attorney.waitForResponse(r=>new URL(r.url()).pathname===`/api/cases/${id}/downloads/${format.id}`&&new URL(r.url()).searchParams.get('preview')==='true');await preview.click();const received=await response;expect(received.status()).toBe(200);expect(received.headers()['content-type']).toContain('application/pdf');await expect(detail(attorney).getByTitle(`Preview of ${format.name}`)).toBeVisible();await expect(detail(attorney).locator('iframe')).toHaveAttribute('src',new RegExp(`/api/cases/${id}/downloads/${format.id}.*preview=true`));await expect(panel(attorney)).toContainText('If the pages do not appear, download the document');await detail(attorney).getByRole('button',{name:'Close preview',exact:true}).click();record.previews.push({name:format.name,capability:'protected authenticated PDF frame200 and visible fallback',nativePdfViewerEnabled:true,renderedPagesClaim:false});}
    else{await expect(preview).toHaveCount(0);await expect(detail(attorney)).toContainText('This browser does not display PDF previews');record.previews.push({name:format.name,capability:'native viewer unavailable; download guidance',nativePdfViewerEnabled:false});}
   }else{
    await preview.click();await expect(panel(attorney)).toContainText('Preview ready.');
    if(type==='image'){const image=detail(attorney).getByAltText(format.name);await expect(image).toBeVisible();expect(await image.evaluate(el=>el.complete&&el.naturalWidth>0&&el.naturalHeight>0)).toBe(true);record.previews.push({name:format.name,capability:'native decoded image',geometry:await image.evaluate(el=>({width:el.naturalWidth,height:el.naturalHeight}))});}
    else{await expect(detail(attorney).locator('pre')).toContainText('CONFIDENTIAL SYNTHETIC LPC REVIEW');record.previews.push({name:format.name,capability:'escaped text/CSV contents'});}
    await detail(attorney).getByRole('button',{name:'Close preview',exact:true}).click();
   }
   await download(attorney,detail(attorney).getByRole('button',{name:'Download file',exact:true}),format,record,'attorney');
   await download(para,para.locator(`[data-v2-file-download="${format.id}"]`),format,record,'paralegal');
  }
  expect(record.downloads).toHaveLength(formats.length*2);
  record.storageObjects=server.inspectStoredObjects();
  for(const format of formats){const stored=record.stored.find(x=>x.id===format.id),object=record.storageObjects.find(x=>x.key===stored.storageKey);expect(object).toBeTruthy();expect(object.sha256).toBe(format.sha256);expect(object.bytes).toBe(format.bytes);}
  const outsider=await actor(browser,'attorney');record.denials=[];
  for(const format of formats.filter(x=>['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(x.mimeType))){const response=await outsider.context.request.get(`${server.origin}/api/uploads/case/${id}/${format.id}/download`);expect([403,404]).toContain(response.status());expect(await response.text()).not.toContain('CONFIDENTIAL SYNTHETIC LPC REVIEW');record.denials.push({name:format.name,status:response.status()});}
  record.afterTransfers=await snapshot();expect(await CaseFile.countDocuments({caseId:id})).toBe(formats.length);expect(await money(id)).toEqual(financialBefore);record.uploadWrites=uploadCounts.total;
  for(const page of [attorney,para]){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
  await attorney.screenshot({path:info.outputPath('actual-format-desktop.png'),fullPage:true});
  await para.setViewportSize({width:390,height:844});expect(await para.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await para.screenshot({path:info.outputPath('actual-format-paralegal-390.png'),fullPage:true});
 }finally{
  if(id){record.caseId=id;record.financialBefore=financialBefore;record.financialAfter=await money(id);record.after=await snapshot();record.server=server.evidence();if(financialBefore)expect(record.financialAfter).toEqual(financialBefore);}
  await fs.writeFile(info.outputPath('supported-formats-actual.json'),JSON.stringify(record,null,2));await info.attach('supported-formats-actual.json',{path:info.outputPath('supported-formats-actual.json'),contentType:'application/json'});
 }
});
