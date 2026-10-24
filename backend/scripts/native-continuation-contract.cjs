'use strict';
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const key=row=>JSON.stringify([row.source,row.line,row.column,row.title,row.engine]);
const unique=rows=>{const result=new Map();for(const row of rows){const id=key(row);assert(!result.has(id),'Repeated browser identity');result.set(id,row);}return result;};
function nativeRows(report,sourcePrefix='backend/tests/playwright/'){
 assert(Array.isArray(report.suites)&&Array.isArray(report.errors),'Actual Playwright JSON report required');
 const rows=[];
 function walk(suite){for(const spec of suite.specs||[])for(const test of spec.tests||[])rows.push({source:sourcePrefix+spec.file,title:spec.title,engine:test.projectName,line:spec.line,column:spec.column,expectedStatus:test.expectedStatus,timeout:test.timeout,status:test.status,results:test.results||[]});for(const child of suite.suites||[])walk(child);}
 for(const suite of report.suites)walk(suite);unique(rows);return{rows,errors:report.errors};
}
function actualPass(row){return row.expectedStatus==='passed'&&row.status==='expected'&&row.results.length===1&&row.results[0].status==='passed'&&row.results[0].retry===0&&Array.isArray(row.results[0].errors)&&row.results[0].errors.length===0;}
function binding(observed,expected,label){assert.deepEqual(observed,expected,label+' applicability mismatch');}
function validatePlan(plan,observed){
 assert.equal(plan.schemaVersion,1,'Unsupported continuation schema');
 assert.equal(plan.mode,'source-bound-browser-continuation','Explicit continuation mode required');
 assert.equal(hash(observed.planBytes),observed.approvedPlanSha256,'Approved exact plan hash required');
 assert.equal(plan.repository,'thegitsss/lets-para3','Explicit approved repository required');
 assert(Number.isSafeInteger(plan.priorRunId)&&plan.priorRunId>0&&Number.isSafeInteger(plan.priorAttempt)&&plan.priorAttempt>0,'Prior run/attempt required');
 assert(/^[a-f0-9]{40}$/.test(plan.priorHead),'Pinned prior head required');
 for(const name of ['candidateSourcesSha256','runtimeProductsSha256','packageLockSha256','runtimeVersions','environmentSha256','effectiveConfigSha256','buildSourceRecipeSha256','builtOutputsSha256'])binding(observed[name],plan.bindings[name],name);
 assert(Array.isArray(observed.unknownChangedPaths)&&observed.unknownChangedPaths.length===0,'Unknown changed behavior cannot reuse');
 assert(Array.isArray(observed.catalog)&&observed.catalog.length>0,'Observed actual current collection required');
 const required=unique(observed.catalog);assert.equal(required.size,plan.expectedIdentities,'Complete current catalog required');
 assert.equal(hash([...required.keys()].sort()),plan.currentCatalogSha256,'Exact current catalog mismatch');
 const execute=new Set(plan.executeIds);assert.equal(execute.size,plan.executeIds.length,'Duplicate execution selection');
 for(const id of execute)assert(required.has(id),'Unknown execution identity');
 for(const row of required.values()){assert.equal(row.expectedStatus,'passed','Skipped or expected-failure requirement');assert(Number.isSafeInteger(row.line)&&row.line>0&&Number.isSafeInteger(row.column)&&row.column>0&&typeof row.source==='string'&&typeof row.engine==='string'&&row.engine.length>0,'Exact source/line/column/engine required');assert(/^[a-f0-9]{64}$/.test(observed.callbackHashes[key(row)]||''),'Actual current callback source missing');}
 const invalidated=new Set(plan.invalidatedIds);assert.equal(invalidated.size,plan.invalidatedIds.length,'Repeated invalidation identity');
 for(const id of invalidated)assert(execute.has(id),'Changed or unknown behavior must execute');
 for(const id of [...observed.changedCallbackIds,...observed.changedRuntimeAffectedIds])assert(invalidated.has(id),'Affected callback omitted from invalidation');
 const reuse=new Map();for(const entry of plan.reuse){assert(required.has(entry.currentId),'Unknown reuse identity');assert(!reuse.has(entry.currentId)&&!execute.has(entry.currentId),'Repeated or re-executed reused identity');assert(!invalidated.has(entry.currentId),'Changed behavior cannot reuse');assert.equal(entry.priorCallbackSha256,entry.currentCallbackSha256,'Changed callback cannot reuse');assert.equal(entry.currentCallbackSha256,observed.callbackHashes[entry.currentId],'Current callback source mismatch');assert.equal(entry.priorCallbackSha256,observed.priorCallbackHashes[entry.priorId],'Prior callback source mismatch');assert.equal(entry.proofClass,required.get(entry.currentId).proofClass,'Proof class cannot be promoted');assert.equal(entry.proofClass,observed.priorProofClasses[entry.priorId],'Prior fixture proof class mismatch');assert(/^[a-f0-9]{64}$/.test(entry.currentCallbackSha256),'Exact callback source required');reuse.set(entry.currentId,entry);}
 assert.equal(execute.size+reuse.size,required.size,'Missing current browser outcome');
 for(const id of required.keys())assert(execute.has(id)||reuse.has(id),'Uncovered current browser identity');
 return{required,execute,reuse};
}
function verifyGroupContinuation(plan,observed,priorReports,currentReport){
 const selection=validatePlan(plan,observed),qualified=[];
 const artifacts=new Map(priorReports.map(report=>[report.artifactId,report]));assert.equal(artifacts.size,priorReports.length,'Duplicate prior artifact');
 for(const [id,entry]of selection.reuse){const artifact=artifacts.get(entry.artifactId);assert(artifact,'Missing prior raw report');assert.equal(artifact.runId,plan.priorRunId,'Wrong prior run');assert.equal(artifact.attempt,plan.priorAttempt,'Wrong prior attempt');assert.equal(artifact.head,plan.priorHead,'Wrong prior source');assert.equal(hash(artifact.bytes),entry.reportSha256,'Prior raw report hash mismatch');assert.equal(artifact.archiveSha256,entry.archiveSha256,'Prior archive binding mismatch');assert(artifact.archiveDigestAndCrcVerified===true,'Prior archive verification required');assert.equal(artifact.errors.length,0,'Prior report-level errors cannot qualify reuse');const parsed=nativeRows(JSON.parse(artifact.bytes.toString()),artifact.sourcePrefix),rows=unique(parsed.rows),row=rows.get(entry.priorId);assert.equal(parsed.errors.length,0,'Prior raw report errors');assert(row&&actualPass(row),'Prior case is not an actual retry-free native pass');const target=selection.required.get(id);assert.equal(row.expectedStatus,target.expectedStatus,'Changed expected status');assert.equal(row.timeout,target.timeout,'Changed callback deadline');qualified.push({identity:id,origin:'reused-actual-terminal-report',priorIdentity:entry.priorId,priorRunId:plan.priorRunId,priorAttempt:plan.priorAttempt,priorHead:plan.priorHead,artifactId:entry.artifactId,reportSha256:entry.reportSha256,proofClass:entry.proofClass,callbackSha256:entry.currentCallbackSha256});}
 if(selection.execute.size){assert(currentReport,'Missing current native report');assert.equal(currentReport.errors.length,0,'Current report-level errors');const parsed=nativeRows(JSON.parse(currentReport.bytes.toString()),currentReport.sourcePrefix);assert.equal(parsed.errors.length,0,'Current raw report errors');const current=unique(parsed.rows);assert.equal(current.size,selection.execute.size,'Current execution selection differs');for(const [id,row]of current){assert(selection.execute.has(id),'Repeated/unselected current execution');assert(actualPass(row),'Current case must actually pass once without skips or retry');const expected=selection.required.get(id);assert.equal(row.timeout,expected.timeout,'Original callback deadline required');qualified.push({identity:id,origin:'executed-current-native-report',currentReportSha256:hash(currentReport.bytes),proofClass:expected.proofClass,callbackSha256:observed.callbackHashes[id]});}}
 else assert(!currentReport||nativeRows(JSON.parse(currentReport.bytes.toString()),currentReport.sourcePrefix).rows.length===0,'Unneeded current callbacks were repeated');
 assert.equal(new Set(qualified.map(row=>row.identity)).size,selection.required.size,'Qualified union identity mismatch');
 return{schemaVersion:1,status:'SOURCE_BOUND_QUALIFIED_BROWSER_UNION',syntheticPlaywrightReport:false,expectedIdentities:selection.required.size,reusedIdentities:selection.reuse.size,executedCurrentIdentities:selection.execute.size,missing:[],qualified,bindings:plan.bindings,priorRunId:plan.priorRunId,priorAttempt:plan.priorAttempt,priorHead:plan.priorHead,limits:['Individual source-bound qualifications are combined; this is not a single new all-green Playwright run.','Original raw failures and each fixture proof class remain unchanged.']};
}
module.exports={hash,key,unique,nativeRows,actualPass,validatePlan,verifyGroupContinuation};
