const { execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url'), path = require('node:path');
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import * as m from ${JSON.stringify(url('application-inventory-model'))}; import { applicationProfileHref } from ${JSON.stringify(url('application-model'))}; import { createApiClient } from ${JSON.stringify(url('api-client'))};
const owner='a'.repeat(24),caseId='b'.repeat(24),applicantId='c'.repeat(24);
const item={applicationId:'d'.repeat(24),applicantId,name:'Synthetic',profileAvailable:true,blocked:false,assigned:false,starred:false,resumeRecorded:false,linkedInRecorded:false,status:'withdrawn',matterStatus:null,appliedAt:null,withdrawnAt:null,coverLetter:'Saved letter',profileSnapshot:null,history:[],invitations:[],warnings:[]};
const filters=m.applicationFilters(), counts=Object.fromEntries(m.APPLICATION_STATUSES.map(key=>[key,key==='withdrawn'?1:0]));
const value={ownerId:owner,caseId,caseTitle:'Matter',caseStatus:'open',archived:false,selectedApplicantId:null,filters,counts,total:1,page:1,pageSize:25,pages:1,complete:true,revision:'e'.repeat(64),warnings:[],applications:[item]};
${source}`], { stdio: 'pipe' }); };
test('strict filters keep whole-inventory search page status and order while rejecting invalid or repeated links', () => check(`
 const query=new URLSearchParams({appPage:'81',appSort:'oldest',appStatus:'withdrawn',appSearch:' Élodie ',applicantId:applicantId.toUpperCase()});
 assert.deepEqual(m.applicationFilters(query),{page:81,sort:'oldest',status:'withdrawn',search:'Élodie',applicantId});
 for(const raw of ['appPage=0','appPage=1000001','appSort=madeup','appStatus=pending','appSearch=%00','applicantId=bad','appPage=1&appPage=2','appSearch='+ 'a'.repeat(201)]) assert.throws(()=>m.applicationFilters(new URLSearchParams(raw)));
`));
test('candidate return retains the list context and exact applicant; returning to all removes only the selection', () => check(`
 const selected={...filters,page:4,sort:'starred',status:'withdrawn',search:'Élodie',applicantId};
 const query=m.applicationQuery(selected,new URLSearchParams({view:'applications',page:'3'}));
 const href=applicationProfileHref(item,caseId,false,'#/matters/'+caseId+'/applications?'+query);
 const back=new URLSearchParams(href.split('?')[1]).get('returnTo');
 assert.deepEqual(m.applicationFilters(new URLSearchParams(back.split('?')[1])),selected);
 const all=m.applicationQuery({...selected,applicantId:''},query);assert.equal(all.has('applicantId'),false);assert.equal(all.get('appPage'),'4');assert.equal(all.get('page'),'3');
`));
test('counts paging completeness and echoed filter mismatches fail rather than showing stale or false empty records', () => check(`
 assert.equal(m.readApplicationInventory(value,caseId,owner,filters).total,1);
 for(const patch of [{total:0},{pages:2},{page:2},{pageSize:100},{counts:{...counts,withdrawn:0}},{counts:{...counts,madeup:1}},{filters:{...filters,sort:'name'}},{complete:false},{revision:'bad'},{applications:[]}]) assert.throws(()=>m.readApplicationInventory({...value,...patch},caseId,owner,filters));
 assert.throws(()=>m.readApplicationInventory(value,caseId,caseId,filters),e=>e.kind==='authentication');
 const incomplete={...value,complete:false,warnings:['posting_missing']};assert.equal(m.readApplicationInventory(incomplete,caseId,owner,filters).complete,false);
 const late={...filters,page:81};assert.equal(m.readApplicationInventory({...value,filters:late,page:81,applications:[]},caseId,owner,late).total,1);
`));
test('selected history bypasses filters without losing their return context and is limited to the selected person', () => check(`
 const selected={...filters,page:81,status:'submitted',applicantId};
 const response={...value,filters:selected,selectedApplicantId:applicantId};assert.equal(m.readApplicationInventory(response,caseId,owner,selected).page,1);
 assert.throws(()=>m.readApplicationInventory({...response,total:2},caseId,owner,selected));
 assert.throws(()=>m.readApplicationInventory({...response,applications:[{...item,applicantId:owner}]},caseId,owner,selected));
`));
test('inventory uses no-store GET and verifies the owner before and after each read', () => check(`
 const calls=[];let account=owner,lost=0;
 const api=createApiClient({onAuthenticationLost:()=>lost++,fetchImpl:async(path,options)=>{calls.push({path,...options});return{ok:true,status:200,json:async()=>path==='/api/auth/me'?{user:{id:account,role:'attorney',status:'approved'}}:value};}});
 await api.readApplicationInventory(caseId,{...filters,page:81,search:'Élodie'},{ownerId:owner});assert.equal(calls.length,3);assert.ok(calls[1].path.includes('/application-inventory?'));assert.ok(calls[1].path.includes('page=81'));assert.equal(calls[1].cache,'no-store');assert.equal(calls[1].method,'GET');
 account=caseId;await assert.rejects(api.readApplicationInventory(caseId,filters,{ownerId:owner}),e=>e.kind==='authentication');assert.equal(lost,1);assert.equal(calls.length,4);
`));
test('account changes after a read and canceled requests withhold application inventory', () => check(`
 let count=0;const api=createApiClient({fetchImpl:async path=>({ok:true,status:200,json:async()=>path==='/api/auth/me'?{user:{id:++count===1?owner:caseId,role:'attorney',status:'approved'}}:value})});
 await assert.rejects(api.readApplicationInventory(caseId,filters,{ownerId:owner}),e=>e.kind==='authentication');
 const controller=new AbortController();controller.abort();await assert.rejects(api.readApplicationInventory(caseId,filters,{ownerId:owner,signal:controller.signal}),e=>e.name==='AbortError');
`));
