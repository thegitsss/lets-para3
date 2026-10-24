'use strict';
const {test,expect}=require('../posting-refresh-actual-fixture.cjs');
const fs=require('node:fs/promises');
async function setup(page,foundationServer,info){
 const mongoose=require('mongoose');if(mongoose.connection.name!==foundationServer.ownedDatabaseName)throw Error('Unowned Files-refresh database');
 const ownerId=foundationServer.actorId,para=await foundationServer.createActor('paralegal',{},true),Case=mongoose.models.Case,CaseFile=mongoose.models.CaseFile;
 const doc=await Case.create({attorney:ownerId,attorneyId:ownerId,title:'Filing review',details:'Synthetic confidential filing review.',practiceArea:'contract law',state:'New York',paralegal:para.id,paralegalId:para.id,status:'in progress',escrowStatus:'funded',escrowIntentId:'pi_synthetic_files_refresh',tasks:[{title:'Review',completed:false}]});
 const original=await CaseFile.create({caseId:doc._id,userId:para.id,originalName:'Original filing.txt',storageKey:`cases/${doc.id}/documents/original.txt`,mimeType:'text/plain',size:40,version:1,uploadedByRole:'paralegal',securityStatus:'not_required'});
 const corrected=await CaseFile.create({caseId:doc._id,userId:para.id,originalName:'Corrected filing.txt',storageKey:`cases/${doc.id}/documents/corrected.txt`,mimeType:'text/plain',size:40,version:1,uploadedByRole:'paralegal',securityStatus:'not_required'});
 const before={matter:await Case.collection.findOne({_id:doc._id}),original:await CaseFile.collection.findOne({_id:original._id}),corrected:await CaseFile.collection.findOne({_id:corrected._id})},http=[];
 page.on('request',request=>{const u=new URL(request.url());if(u.pathname.startsWith(`/api/cases/${doc.id}/files`))http.push({method:request.method(),path:u.pathname,query:u.search,body:request.method()==='POST'?request.postDataJSON():null});});
 await page.route('**/attorney-v2.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><link rel="stylesheet" href="/assets/styles/attorney-v2.css"></head><body><button id="outside">Outside files</button><main></main></body></html>'}));
 await page.goto('/attorney-v2.html');
 await page.evaluate(async({caseId,ownerId})=>{
  const {createWorkspaceFiles}=await import('/assets/scripts/attorney-v2/workspace-files.mjs'),{createApiClient}=await import('/assets/scripts/attorney-v2/api-client.mjs');
  const actual=createApiClient(),evidence=window.fileRefreshEvidence={reads:0,writes:[],receipts:[],heldSignals:[]};
  const api={...actual,
   async readWorkspaceFiles(id,options){
    evidence.reads++;let held=false;
    if(window.holdFileRead){window.holdFileRead=false;held=true;await new Promise(resolve=>window.releaseFileRead=resolve);}
    // Preserve the original deliberately non-cooperative dependency boundary:
    // its late reply must not replace a newer native selection. No browser API
    // is replaced; the delivered payload is the actual authorized server DTO.
    const value=await actual.readWorkspaceFiles(id,held?{...options,signal:undefined}:options);
    evidence.receipts.push({held,caseId:value.caseId,ownerId:value.ownerId,selection:value.selection,selectedId:value.selectedFile?.id,names:value.files.map(file=>file.name)});
    if(held)evidence.heldSignals.push({aborted:options.signal.aborted,delivered:true});
    return value;
   },
   async updateWorkspaceFile(id,fileId,input,options){evidence.writes.push({fileId,status:input.status});return actual.updateWorkspaceFile(id,fileId,input,options);}
  };
  const controller=new AbortController(),panel=createWorkspaceFiles(caseId,{api,signal:controller.signal,ownerId,route:{query:new URLSearchParams()},privateState:{fileReviews:new Map()}});
  document.querySelector('main').append(panel);await panel.readiness;
 },{caseId:doc.id,ownerId});
 const panel=page.locator('[data-workspace-files]'),detail=panel.getByRole('region',{name:'Document review'});await expect(panel).toHaveAttribute('data-state','ready');
 return{caseId:doc.id,ownerId,originalId:original.id,correctedId:corrected.id,Case,CaseFile,before,http,panel,detail,info};
}
async function finish(f,page,expectedApproval=false,renamed=false){
 const {decryptCaseFilePayload}=require('../../../utils/dataEncryption'),after={matter:await f.Case.collection.findOne({_id:new(require('mongoose').Types.ObjectId)(f.caseId)}),original:await f.CaseFile.collection.findOne({_id:new(require('mongoose').Types.ObjectId)(f.originalId)}),corrected:await f.CaseFile.collection.findOne({_id:new(require('mongoose').Types.ObjectId)(f.correctedId)})};
 const plain={original:decryptCaseFilePayload(after.original),corrected:decryptCaseFilePayload(after.corrected)},evidence=await page.evaluate(()=>window.fileRefreshEvidence),writes=f.http.filter(r=>r.method==='POST'),audits=await require('mongoose').models.AuditLog.collection.find({case:new(require('mongoose').Types.ObjectId)(f.caseId),action:'case.file.status.update'}).toArray();
 expect(evidence.receipts.every(r=>r.caseId===f.caseId&&r.ownerId===f.ownerId)).toBe(true);
 for(const key of ['escrowIntentId','escrowStatus','totalAmount','currency','paymentReleased','paralegal','paralegalId','attorney','attorneyId'])expect(after.matter[key]).toEqual(f.before.matter[key]);
 if(expectedApproval){expect(writes).toHaveLength(1);expect(writes[0].path).toBe(`/api/cases/${f.caseId}/files/${f.correctedId}/review`);expect(writes[0].body).toMatchObject({status:'approved',expectedOwnerId:f.ownerId});expect(plain.corrected.status).toBe('approved');expect(plain.corrected.version).toBe(1);expect(plain.corrected.approvedAt).toBeTruthy();expect(after.original).toEqual(f.before.original);expect(audits).toHaveLength(1);expect(String(audits[0].meta.fileId)).toBe(f.correctedId);}
 else{expect(writes).toEqual([]);expect(audits).toEqual([]);expect(after.matter).toEqual(f.before.matter);expect(after.corrected).toEqual(f.before.corrected);expect(plain.original.originalName).toBe(renamed?'Saved original filing.txt':'Original filing.txt');}
 await fs.writeFile(f.info.outputPath('files-refresh-actual.json'),JSON.stringify({caseId:f.caseId,ownerId:f.ownerId,originalId:f.originalId,correctedId:f.correctedId,before:f.before,after,plain,evidence,http:f.http,audits,expectedApproval,renamed,boundary:'Actual managed owner/session and saved encrypted records; standalone production component. Held dependency deliberately ignores its cancellation signal; native fetch is unchanged and actual same-owner DTO is returned. No file download/provider storage claim.'},null,2));
}
async function approve(f,page){
 await f.detail.getByRole('button',{name:'Approve document',exact:true}).click();await expect(f.detail.locator('[data-file-confirm]')).toContainText('Approve “Corrected filing.txt”, version 1?');
 expect(await page.evaluate(()=>window.fileRefreshEvidence.writes)).toEqual([]);expect(f.http.filter(r=>r.method==='POST')).toEqual([]);
 await f.detail.getByRole('button',{name:'Confirm approval',exact:true}).click();await expect(f.panel).toContainText('Document approved.');expect(await page.evaluate(()=>window.fileRefreshEvidence.writes)).toEqual([{fileId:f.correctedId,status:'approved'}]);
}

test('a background file refresh during a selection press cannot leave the earlier document selected',async({page,foundationServer},info)=>{
 const f=await setup(page,foundationServer,info);await f.panel.getByRole('button',{name:'Original filing.txt',exact:true}).click();await expect(f.detail.getByRole('heading',{name:'Original filing.txt',exact:true})).toBeVisible();
 const next=f.panel.getByRole('button',{name:'Corrected filing.txt',exact:true});await next.hover();await page.mouse.down();
 const beforeReads=await page.evaluate(()=>window.fileRefreshEvidence.reads);
 try{await f.panel.evaluate(element=>element.sync());expect(await page.evaluate(()=>window.fileRefreshEvidence.reads)).toBe(beforeReads);}finally{await page.mouse.up();}
 await expect(f.detail.getByRole('heading',{name:'Corrected filing.txt',exact:true})).toBeVisible();await approve(f,page);await finish(f,page,true);
});

for(const interaction of ['native press','idle refresh'])test(`an in-flight background file read preserves document selection: ${interaction}`,async({page,foundationServer},info)=>{
 const f=await setup(page,foundationServer,info);await f.panel.getByRole('button',{name:'Original filing.txt',exact:true}).click();await expect(f.detail.getByRole('heading',{name:'Original filing.txt',exact:true})).toBeVisible();
 await page.locator('#outside').focus();await page.evaluate(()=>{window.holdFileRead=true;window.pendingFileRefresh=document.querySelector('[data-workspace-files]').sync();});await expect.poll(()=>page.evaluate(()=>window.fileRefreshEvidence.reads)).toBe(2);
 try{if(interaction==='native press'){await f.panel.getByRole('button',{name:'Corrected filing.txt',exact:true}).hover();await page.mouse.down();await page.mouse.up();}else{const original=await f.CaseFile.findById(f.originalId);original.originalName='Saved original filing.txt';await original.save();}}
 finally{await page.evaluate(()=>window.releaseFileRead());}
 await page.evaluate(()=>window.pendingFileRefresh);
 if(interaction==='idle refresh'){await expect(f.panel.getByRole('button',{name:'Saved original filing.txt',exact:true})).toBeVisible();await expect(f.detail.getByRole('heading',{name:'Saved original filing.txt',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.fileRefreshEvidence.writes)).toEqual([]);await finish(f,page,false,true);return;}
 expect(await page.evaluate(()=>window.fileRefreshEvidence.heldSignals)).toEqual([{aborted:true,delivered:true}]);await expect(f.detail.getByRole('heading',{name:'Corrected filing.txt',exact:true})).toBeVisible();await approve(f,page);await finish(f,page,true);
});
