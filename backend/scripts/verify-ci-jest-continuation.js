'use strict';
const assert=require('node:assert/strict');
const {hash,expectedJestArgs,validateOwnedCleanup,verifyShard}=require('./verify-ci-jest-shards');
const {REQUIRED_SUBSETS}=require('./verify-ci-jest-coverage');
const same=(a,b)=>assert.deepEqual(a,b),sort=rows=>[...rows].sort();
// Finite reviewed dev-only security patch. All runtime lock nodes are identical;
// unknown dependency changes still fail the original strict source boundary.
const REVIEWED_DEVELOPMENT_PATCH={"reviewedEvidenceSha256":"9cdb3c4683e3091a1fa51bc66023d9bfa4e2e760d51a5bd395b7d2c3035efc73","files":{"backend/package.json":["85fb2d78de31f8276eb7654b7c54666bb341c9da46511fffc8758f5224aaded4","26de288d63b2be442019c78e0bb38d2a38db166ae8d3685092c630e319932038"],"backend/package-lock.json":["a5100240a796274e7fa20f690afa8ad796982f96923772318e3ae63358ff05d5","d67037ecc3bab02c1f41812e5692adea11be7d5706b946f62cff549e4f004bc8"]}};
function dependencyApplicability(prior,current,bridge){
 const paths=Object.keys(REVIEWED_DEVELOPMENT_PATCH.files),changed=paths.some(p=>prior.files[p]!==current.files[p]);
 if(!changed){assert.equal(bridge.reviewedDevelopmentDependencyChange,undefined,'Unnecessary dependency exception');return;}
 same(bridge.reviewedDevelopmentDependencyChange,REVIEWED_DEVELOPMENT_PATCH,'Exact reviewed development-only dependency bridge required');
 for(const p of paths)same([prior.files[p],current.files[p]],REVIEWED_DEVELOPMENT_PATCH.files[p],'Unknown dependency source cannot reuse');
}
function validateBridge(prior,current,discovered,bridge,approvedBridgeSha256){
 assert.equal(hash(JSON.stringify(bridge)),approvedBridgeSha256,'Exact externally approved source bridge required');
 assert.equal(bridge.schemaVersion,1);assert.equal(bridge.mode,'explicit-source-bound-jest-continuation');
 assert.equal(bridge.priorCommit,prior.commit);assert.equal(bridge.currentCommit,current.commit);
 assert.equal(bridge.priorSourceSha256,hash(JSON.stringify(prior)));assert.equal(bridge.currentSourceSha256,hash(JSON.stringify(current)));
 assert.equal(prior.files['backend/jest.config.js'],current.files['backend/jest.config.js'],'Original Jest config must remain exact');
 dependencyApplicability(prior,current,bridge);
 assert.equal(prior.files['.node-version'],current.files['.node-version'],'Changed runtime needs fresh coverage');
 const required=new Set(discovered);assert.equal(required.size,discovered.length,'Repeated current suite');
 const paths=new Set([...Object.keys(prior.files),...Object.keys(current.files)]),changed=[...paths].filter(p=>prior.files[p]!==current.files[p]);
 assert.equal(new Set(bridge.changes.map(x=>x.path)).size,bridge.changes.length,'Duplicate source disposition');
 same(sort(bridge.changes.map(x=>x.path)),sort(changed));const affected=new Set();
 for(const entry of bridge.changes){assert.equal(entry.beforeSha256,prior.files[entry.path]||null);assert.equal(entry.afterSha256,current.files[entry.path]||null);assert(/^[a-f0-9]{64}$/.test(entry.reviewedEvidenceSha256||''),'Exact reviewed conservation/impact evidence required');assert(Array.isArray(entry.affectedSuites));
  if(entry.path.startsWith('backend/tests/')&&entry.path.endsWith('.test.js')){const name=entry.path.slice(8);if(required.has(name))assert(entry.affectedSuites.includes(name),'Changed suite must execute');}
  if(entry.kind==='product-change')assert(entry.affectedSuites.length>0,'Unknown product impact cannot reuse');
  else assert(['test-fixture','reviewed-equivalent','documentation-only','ci-control','browser-only-product'].includes(entry.kind),'Unclassified changed source');
  if(entry.kind==='browser-only-product')assert(entry.path.startsWith('frontend/')&&entry.backendRuntimeImpact==='none-reviewed'&&entry.browserAcceptanceRequired===true,'Browser-only applicability cannot conceal backend runtime or certify browser behavior');
  if(entry.kind==='documentation-only')assert(entry.path.endsWith('.md'),'Documentation classification cannot conceal runtime source');
  if(entry.kind==='test-fixture')assert(entry.path.startsWith('backend/tests/'),'Test fixture classification cannot conceal product source');
  if(entry.kind==='ci-control')assert(entry.path.startsWith('.github/')||entry.path.startsWith('backend/scripts/')||entry.path.startsWith('docs/security/')||entry.path==='.gitleaksignore','CI classification cannot conceal product source');
  for(const file of entry.affectedSuites){assert(required.has(file),'Unknown affected suite');affected.add(file);}
 }
 return affected;
}
function exactRaw(input){for(const name of ['results.json','results.xml','mongo.jsonl','http.jsonl'])assert.equal(hash(input.raw[name]),input.record.rawSHA256[name],'Raw report changed');same(input.report,JSON.parse(input.raw['results.json']));for(const name of ['mongo','http'])same(input[name],input.raw[name+'.jsonl'].toString().trim().split('\n').filter(Boolean).map(JSON.parse));}
function priorShardEnvelope(plan,input){
 exactRaw(input);const {record,report,mongo,http}=input,assignment=plan.shards.find(s=>s.id===record.shardId);assert(assignment,'Unknown old shard');
 assert.equal(record.executionId,plan.executionId);assert.equal(record.planId,plan.planId);assert.equal(record.planSHA256,input.planSha256);same(record.sourceBefore,plan.source);same(record.sourceAfter,plan.source);same(record.suites,assignment.suites);
 same(record.command,expectedJestArgs(record.backendRoot,record.outputRoot,assignment.suites));assert.equal(record.observerSHA256,plan.source.files['backend/scripts/ci-jest-owned-observer.cjs']);assert.equal(record.harnessStateReleased,true);
 assert([0,1].includes(record.terminal.code)&&record.terminal.signal===null,'Aborted or unknown terminal process cannot lend proof');
 assert(input.actualArchiveDigestAndCrcVerified===true&&/^[a-f0-9]{64}$/.test(input.archiveSha256||''),'Actual source-bound archived report required');
 for(const name of ['results.json','results.xml','mongo.jsonl','http.jsonl'])assert.equal(hash(input.raw[name]),record.rawSHA256[name],'Raw report changed');
 const cleanup=validateOwnedCleanup(mongo,http),files=report.testResults.map(s=>s.name.slice(record.backendRoot.length+1));same(sort(files),sort(assignment.suites));assert.equal(new Set(files).size,files.length);assert.equal(report.numTotalTestSuites,files.length);
 const rows=new Map();for(const suite of report.testResults){const file=suite.name.slice(record.backendRoot.length+1);assert(file.startsWith('tests/'));
  const callbacks=suite.assertionResults||[];const passed=suite.status==='passed'&&!suite.testExecError&&callbacks.length>0&&callbacks.every(c=>c.status==='passed'&&c.invocations===1&&!c.failureMessages?.length&&!c.retryReasons?.length);
  rows.set(file,{suite,passed,cleanup,archiveSha256:input.archiveSha256,rawReportSha256:record.rawSHA256['results.json'],shardId:record.shardId});
 }
 return rows;
}
function prepareSelection(priorPlan,priorInputs,current,discovered,bridge,approvedBridgeSha256){
 const {planId,...originalPayload}=priorPlan;assert.equal(hash(JSON.stringify(originalPayload)),planId,'Prior actual plan content changed');same(priorPlan.required,REQUIRED_SUBSETS);const affected=validateBridge(priorPlan.source,current,discovered,bridge,approvedBridgeSha256);assert.equal(priorInputs.length,8);assert.equal(new Set(priorInputs.map(x=>x.record.shardId)).size,8);
 const old=new Map();for(const input of priorInputs)for(const[file,row]of priorShardEnvelope(priorPlan,input)){assert(!old.has(file));old.set(file,row);}
 same(sort(old.keys()),sort(priorPlan.suites));const execute=[],reuse=[];
 for(const file of discovered){const original=old.get(file);if(!original||!original.passed||affected.has(file)||priorPlan.source.files['backend/'+file]!==current.files['backend/'+file])execute.push(file);else reuse.push(file);}
 return{execute:sort(execute),reuse:sort(reuse),old,affected:sort(affected)};
}
function verifyContinuation({priorPlan,priorInputs,current,discovered,bridge,currentPlan,currentInputs,currentPlanSha256,approvedBridgeSha256,now}){
 const selected=prepareSelection(priorPlan,priorInputs,current,discovered,bridge,approvedBridgeSha256);same(sort(currentPlan.suites),selected.execute);same(currentPlan.source,current);same(currentPlan.required,REQUIRED_SUBSETS);assert.equal(currentPlan.originalConfigSHA256,current.files['backend/jest.config.js']);for(const input of currentInputs)exactRaw(input);assert(currentInputs.length>0,'Missing actual current execution');
 const runFiles=currentPlan.shards.flatMap(s=>s.suites);same(sort(runFiles),selected.execute);assert.equal(new Set(runFiles).size,runFiles.length);assert.equal(currentInputs.length,currentPlan.shards.length);assert.equal(new Set(currentInputs.map(x=>x.record.shardId)).size,currentInputs.length);
 const qualified=currentInputs.map(i=>verifyShard(currentPlan,i.record,i.report,i.mongo,i.http,current,currentPlanSha256,now)),executed=qualified.flatMap(s=>s.suites);same(sort(executed),selected.execute);
 const files=[...selected.reuse,...executed];same(sort(files),sort(discovered));assert.equal(new Set(files).size,files.length);
 const proofs=selected.reuse.map(file=>{const row=selected.old.get(file);return{file,origin:'source-bound-prior-actual-shard',sourceSha256:current.files['backend/'+file],archiveSha256:row.archiveSha256,rawReportSha256:row.rawReportSha256,passedCallbacks:row.suite.assertionResults.length,priorShard:row.shardId,priorCommit:priorPlan.source.commit};});
 for(const s of qualified)for(const file of s.suites)proofs.push({file,origin:'executed-current-original-suite',sourceSha256:current.files['backend/'+file],passedCallbacks:s.identities.filter(i=>i.file===file).length,currentShard:s.id,currentCommit:current.commit});
 return{schemaVersion:1,status:'SOURCE_BOUND_COMPLETE_ORIGINAL_JEST_UNION',syntheticJestReport:false,singleCompleteJestExecution:false,currentSource:current,priorCommit:priorPlan.source.commit,completeSuites:files.length,reusedSuites:selected.reuse.length,executedCurrentSuites:executed.length,proofs,limits:['Original failed reports remain failed; current qualified union has explicit source and origin per suite.','Only reviewed exact source/dependency/config applicability permits prior-suite reuse.','Every contributing actual process must close normally; no pending, failed or retried callback qualifies.']};
}
module.exports={validateBridge,priorShardEnvelope,prepareSelection,verifyContinuation,dependencyApplicability,REVIEWED_DEVELOPMENT_PATCH};

const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const PLAN_FILE='backend/tests/ci-jest-continuation-plan.json';
function context(current){
 const root=path.resolve(__dirname,'../..');
 return validateExecutionContext(current,process.env,JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),cp.execFileSync('git',['status','--porcelain=v1','--untracked-files=normal'],{cwd:root,encoding:'utf8'}).trim(),fs.readFileSync(path.join(root,PLAN_FILE)));
}
function validateExecutionContext(current,env,event,dirty,bytes){
 const approved=env.LPC_JEST_CONTINUATION_PLAN_SHA256||'';assert(/^[a-f0-9]{64}$/.test(approved),'Exact reviewed continuation SHA required');assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(env.GITHUB_SHA,current.commit);assert.equal(event.inputs?.execution_scope,'backend-source');assert.equal(event.inputs?.continuation_plan_sha256,approved);assert.equal(dirty,'','Dirty candidate cannot continue');assert.equal(hash(bytes),approved,'Continuation source plan bytes differ');const spec=JSON.parse(bytes);assert.equal(spec.schemaVersion,1);assert.equal(spec.mode,'whole-file-source-bound-backend-continuation');assert.equal(spec.currentCommit,'@checked-out-head');return{spec,approved};
}
function bridgeFor(spec,approved,prior,current){
 const changes=spec.changes.map(e=>({...e,afterSha256:e.path===PLAN_FILE&&e.afterSha256==='@approved-plan'?approved:e.afterSha256}));
 return{schemaVersion:1,mode:'explicit-source-bound-jest-continuation',priorCommit:prior.commit,currentCommit:current.commit,priorSourceSha256:hash(JSON.stringify(prior)),currentSourceSha256:hash(JSON.stringify(current)),changes};
}
function validateContinuationPlan(plan,current,discovered){
 const {spec,approved}=context(current);assert.equal(plan.continuation.specSha256,approved);same(plan.source,current);assert.equal(plan.schemaVersion,2);const {planId,...payload}=plan;assert.equal(planId,hash(JSON.stringify(payload)));same(sort(plan.continuation.currentDiscovery),sort(discovered));same(plan.required,REQUIRED_SUBSETS);assert.equal(plan.originalConfigSHA256,current.files['backend/jest.config.js']);
 const selected=plan.continuation.execute,reuse=plan.continuation.reuse;assert(selected.length>=8);assert.equal(new Set([...selected,...reuse]).size,discovered.length);same(sort([...selected,...reuse]),sort(discovered));same(sort(plan.suites),sort(selected));assert.equal(plan.shards.length,8);same(plan.shards.map(s=>s.id),[1,2,3,4,5,6,7,8]);const assigned=plan.shards.flatMap(s=>{assert(s.suites.length);return s.suites;});same(sort(assigned),sort(selected));assert.equal(new Set(assigned).size,assigned.length);assert.equal(plan.continuation.priorHead,spec.priorHead);assert.equal(plan.continuation.priorRunId,spec.priorRunId);assert.equal(plan.continuation.priorAttempt,spec.priorAttempt);return plan;
}
function prepareContinuation(current,discovered){
 const {spec,approved}=context(current),prior=require('./import-ci-jest-prior').loadPrior(spec),bridge=bridgeFor(spec,approved,prior.plan.source,current),selection=prepareSelection(prior.plan,prior.inputs,current,discovered,bridge,hash(JSON.stringify(bridge)));
 return{specSha256:approved,priorRunId:spec.priorRunId,priorAttempt:spec.priorAttempt,priorHead:spec.priorHead,priorPlanId:prior.plan.planId,priorPlanSha256:spec.priorPlanSha256,currentDiscovery:sort(discovered),execute:selection.execute,reuse:selection.reuse,sourceBridge:bridge,sourceBridgeSha256:hash(JSON.stringify(bridge)),evidenceClass:'Source-bound whole original suite fragments plus actual current affected-suite execution; not a single green full Jest run.'};
}
function verifyContinuationArtifacts(plan,current,discovered,currentInputs,currentPlanSha256){
 validateContinuationPlan(plan,current,discovered);const {spec,approved}=context(current),prior=require('./import-ci-jest-prior').loadPrior(spec),bridge=bridgeFor(spec,approved,prior.plan.source,current);same(bridge,plan.continuation.sourceBridge);
 const result=verifyContinuation({priorPlan:prior.plan,priorInputs:prior.inputs,current,discovered,bridge,currentPlan:plan,currentInputs,currentPlanSha256,approvedBridgeSha256:hash(JSON.stringify(bridge))});
 const required={};for(const[name,files]of Object.entries(REQUIRED_SUBSETS))required[name]=files.map(file=>{const p=result.proofs.find(x=>x.file===file);assert(p,'Required substantive authentication/payment suite absent');return{file,sourceSHA256:current.files['backend/'+file],passedCallbacks:p.passedCallbacks,origin:p.origin};});
 return{...result,completeOriginalCoverageVerified:true,evidenceClass:plan.continuation.evidenceClass,commit:current.commit,executionId:plan.executionId,planId:plan.planId,fullSuites:result.completeSuites,fullCallbacks:result.proofs.reduce((n,p)=>n+p.passedCallbacks,0),required,approvedContinuationSpecSha256:approved,sourceBridgeSha256:plan.continuation.sourceBridgeSha256,priorRunId:spec.priorRunId,priorAttempt:spec.priorAttempt};
}
Object.assign(module.exports,{context,validateExecutionContext,bridgeFor,validateContinuationPlan,prepareContinuation,verifyContinuationArtifacts});
