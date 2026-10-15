'use strict';
// Collection only: Playwright --list never runs global setup/webServer/tests.
// The expected union comes from the unchanged original configs, not counts in
// the proposed group manifest. Its exact additional files are explicit below.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const backend=path.resolve(__dirname,'..'),root=path.dirname(backend),manifest=require('../tests/playwright/acceptance/groups.json'),pkg=require('../package.json');
const output=path.resolve(process.env.LPC_BROWSER_GROUP_VERIFY_OUTPUT||path.join(backend,'test-results/critical-group-verification'));
fs.mkdirSync(output,{recursive:true});
const originalAdapters={
 'test:playwright:attorney-v2':'tests/playwright/attorney-v2/playwright.config.js',
 'test:playwright:paralegal-support':'playwright.paralegal-support.config.js',
 'test:playwright:director':'playwright.director.config.js',
 'test:playwright:financial-lifecycle':'tests/playwright/financial-lifecycle/playwright.config.js',
 'test:playwright:shared-matter':'tests/playwright/shared-matter/playwright.config.js',
 'test:playwright:admin-solo':'tests/playwright/admin-solo/playwright.config.js',
};
const additional=[
 'admin-solo/payment-attention-recovery-actual.spec.js',
 'admin-solo/inbox-note-authority-actual.spec.js','admin-solo/inbox-status-triage-authority-actual.spec.js',
 'admin-solo/inbox-reply-authority-actual.spec.js','admin-solo/information-request-authority-actual.spec.js',
 'admin-solo/routine-native-takeover-actual.spec.js','financial-lifecycle/financial-native-recovery-actual.spec.js',
 'financial-lifecycle/financial-authority-actual.spec.js','financial-lifecycle/financial-claim-transaction-actual.spec.js',
 'financial-lifecycle/posting-lock-records-actual.spec.js','director-entry/late-state-new-viewer-actual.spec.js',
 'director-entry/state-authority-actual.spec.js','director-entry/profile-outreach-authority-actual.spec.js',
];
const scripts=[...pkg.scripts['test:playwright:critical'].matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)].map(m=>m[1]);
if(scripts.length!==15||new Set(scripts).size!==15)throw Error('Keep all15 declared critical scopes.');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const approvedCalendarRegression={path:'tests/playwright/attorney-v2/calendar-press-regression.spec.js',sha256:'977552abc8772bf14281e608c2eb0a5f2922a0bb4689694a5228eabfade89e2b'};
if(sha(fs.readFileSync(path.join(backend,approvedCalendarRegression.path)))!==approvedCalendarRegression.sha256)throw Error('Approved additive calendar regression source changed.');
const safeEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',EMAIL_DISABLE:'true',MONGOMS_RUNTIME_DOWNLOAD:'false',AWS_EC2_METADATA_DISABLED:'true'};
function collect(name,config,env={}){return new Promise((resolve,reject)=>{
 const target=path.join(output,name+'.json'),stderr=[];const fd=fs.openSync(target,'w');
 const child=spawn(process.execPath,[path.join(backend,'node_modules/playwright/cli.js'),'test','--list','--reporter=json','-c',config],{cwd:backend,env:{...safeEnv,...env},stdio:['ignore',fd,'pipe']});
 child.stderr.on('data',b=>stderr.push(b));child.once('error',reject);child.once('close',(code,signal)=>{fs.closeSync(fd);if(code!==0||signal)return reject(Error('Collection failed '+name+': '+Buffer.concat(stderr).toString().slice(0,300)));
  try{const bytes=fs.readFileSync(target),r=JSON.parse(bytes);if(r.errors?.length)throw Error('Collection errors '+name);const rows=[];
   function walk(s){for(const spec of s.specs||[]){const source=path.relative(root,path.resolve(r.config.rootDir,spec.file));for(const t of spec.tests)rows.push({source,line:spec.line,column:spec.column,title:spec.title,engine:t.projectName,expectedStatus:t.expectedStatus,timeout:t.timeout,origin:name});}for(const x of s.suites||[])walk(x);}
   for(const s of r.suites||[])walk(s);resolve({name,path:target,sha256:sha(bytes),rows});
  }catch(e){reject(e);}
 });
});}
async function parallel(tasks){const queue=[...tasks],results=[];async function worker(){while(queue.length){const task=queue.shift();results.push(await task());}}await Promise.all([worker(),worker()]);return results;}
const key=r=>JSON.stringify([r.source,r.line,r.column,r.title,r.engine]);
// Reviewed manual browser contexts explicitly own 1366x900. Fail closed if
// those callback/config bytes drift; equal titles alone cannot authorize dedup.
const reviewedDuplicatePins={"tests/playwright/financial-lifecycle/journey.spec.js":"2b26a5c4a1ebafd4410bf92893bc502d164eddda02fa3e668d3f3ab405eff72b","tests/playwright/financial-lifecycle/exception.spec.js":"5c0ae7a5ab5d2e730cae8bfffd2adbf0a4eeaa9c065a0ee727883b4a293e3462","tests/playwright/financial-lifecycle/submission-journey.spec.js":"9fd9f8867fac496285e4637acf5cf2c0a3a36917a7fd7465fef21c81f24b7a45","tests/playwright/financial-lifecycle/playwright.config.js":"6e3070755f08b4811c379e0737075558396853f1cb70f507e325eeb05aeef200","tests/playwright/shared-matter/playwright.config.js":"356ac93f9f21d6277ed564621c210ad7dc056619f6528235c30f9324767fc0a8"};
for(const [file,hash]of Object.entries(reviewedDuplicatePins))if(sha(fs.readFileSync(path.join(backend,file)))!==hash)throw Error('Shared/financial duplicate source contract changed: '+file);

(async()=>{
 const original=await parallel(scripts.map(s=>()=>{const config=originalAdapters[s]||pkg.scripts[s].match(/\s-c\s+([^\s]+)/)?.[1];if(!config)throw Error('No original config '+s);return collect('original-'+s.replaceAll(':','-'),path.join(backend,config));}));
 const extraConfig=path.join(output,'additional.config.cjs');
 fs.writeFileSync(extraConfig,`const path=require('node:path');const base=require(${JSON.stringify(path.join(backend,'tests/playwright/financial-lifecycle/playwright.config.js'))});module.exports={...base,testDir:${JSON.stringify(path.join(backend,'tests/playwright'))},testMatch:${JSON.stringify(additional)},reporter:[['json']]};\n`);
 const extra=await collect('additional',extraConfig);
 const expected=new Map(),duplicates=[];for(const result of [...original,extra])for(const r of result.rows){const k=key(r);if(expected.has(k))duplicates.push([expected.get(k),r]);else expected.set(k,r);}
 const allowedFiles=['backend/tests/playwright/financial-lifecycle/journey.spec.js','backend/tests/playwright/financial-lifecycle/exception.spec.js','backend/tests/playwright/financial-lifecycle/submission-journey.spec.js'];
 for(const [a,b]of duplicates){if(!allowedFiles.includes(a.source)||a.timeout!==b.timeout||a.expectedStatus!=='passed'||b.expectedStatus!=='passed'||![a.origin,b.origin].some(x=>x.includes('financial-lifecycle'))||![a.origin,b.origin].some(x=>x.includes('shared-matter')))throw Error('Unqualified duplicate '+key(a));}
 if(duplicates.length!==114)throw Error('Financial/shared equivalence inventory changed; explicitly review source/config compatibility.');
 const actual=await parallel(manifest.groups.map(g=>()=>collect('group-'+g.name,path.join(backend,'tests/playwright/acceptance/group.config.cjs'),{LPC_BROWSER_GROUP:g.name,LPC_BROWSER_GROUP_OUTPUT:path.join(output,'artifacts',g.name)})));
 const seen=new Map();for(const result of actual){const group=manifest.groups.find(g=>'group-'+g.name===result.name);if(result.rows.length!==group.expectedIdentities)throw Error('Group count mismatch '+group.name);for(const r of result.rows){const k=key(r);if(seen.has(k))throw Error('Group repeats '+k);seen.set(k,r);}}
 const missing=[...expected.keys()].filter(k=>!seen.has(k)),extraRows=[...seen.keys()].filter(k=>!expected.has(k));
 if(missing.length||extraRows.length)throw Error('Group identity union differs: '+missing.length+' missing, '+extraRows.length+' extra.');
 for(const [k,r]of seen){const before=expected.get(k);if(r.expectedStatus!=='passed'||before.expectedStatus!=='passed'||r.timeout>before.timeout)throw Error('Group weakens status or callback deadline '+k);}

 if(seen.size!==5945||seen.size!==manifest.expectedUniqueCriticalIdentities)throw Error('Critical union count changed.');
 const summary={status:'EXACT_ORIGINAL_PLUS_ADDITIONAL_GROUPED_COLLECTION_UNION_VERIFIED',collectionOnly:true,executed:0,originalRawIdentities:original.reduce((n,r)=>n+r.rows.length,0),additional:extra.rows.length,qualifiedSharedFinancialDuplicates:duplicates.length,uniqueCritical:seen.size,groups:actual.map(r=>({name:r.name,count:r.rows.length,path:r.path,sha256:r.sha256})),baselineReports:original.map(({rows:_rows,...r})=>r),additionalReport:{path:extra.path,sha256:extra.sha256},reviewedDuplicatePins,manifestSha256:sha(fs.readFileSync(path.join(backend,'tests/playwright/acceptance/groups.json'))),rows:[...seen.values()],missing,extra:extraRows,limits:['Only collection equality is verified; no test pass, current release/device/provider acceptance.','Shared/financial context/fixture equivalence remains explicitly source-pinned in release coverage evidence; config default context dimensions are not equated by title.']};
 fs.writeFileSync(path.join(output,'verified-union.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({status:summary.status,groups:actual.length,uniqueCritical:seen.size,additional:extra.rows.length,duplicates:duplicates.length,output}));
})().catch(error=>{fs.writeFileSync(path.join(output,'failed.json'),JSON.stringify({status:'COLLECTION_VERIFICATION_FAILED',message:error.message},null,2)+'\n');console.error(error.message);process.exitCode=1;});
