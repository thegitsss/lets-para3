"use strict";
// Fixed, source-reviewed allocations prevent concurrent jobs exceeding the owner cap.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "../..");
const LIMIT = 10 * 1024 ** 3;
const MIB = 1024 ** 2;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function fail(message) { throw Error(`[artifact-budget] ${message}`); }
function catalog(run, attempt, groups = JSON.parse(fs.readFileSync(path.join(ROOT, "backend/tests/playwright/acceptance/groups.json"))).groups) {
  if (!/^[1-9]\d*$/.test(String(run)) || !/^[1-9]\d*$/.test(String(attempt))) fail("Exact positive run ID and attempt required.");
  if (groups.length !== 32 || new Set(groups.map(g => g.name)).size !== 32 || groups.reduce((n, g) => n + g.expectedIdentities, 0) !== 5933) fail("Complete approved32 browser groups required.");
  const suffix = `${run}-${attempt}`, rows = [];
  const add = (job, key, name, input, maxBytes) => rows.push({job, key: String(key), name: `${name}-${suffix}`, path: input, maxBytes});
  add("runtime-checks", "", "supply-chain-evidence", "backend/test-results/supply-chain", 16*MIB);
  add("runtime-checks", "", "candidate-identity", "backend/test-results/release/candidate.json", 16*MIB);
  add("runtime-checks", "", "jest-plan", "backend/test-results/jest/plan.json", 16*MIB);
  add("backend-coverage", "", "jest-complete-union", "backend/test-results/jest/required-coverage.json", 16*MIB);
  add("browser-collection", "", "browser-collection", "backend/test-results/critical-group-verification/verified-union.json", 16*MIB);
  add("secrets", "", "secret-scan-evidence", "results.sarif", 16*MIB);
  for (let shard=1; shard<=8; shard++) rows.push({job:"backend-tests", key:String(shard), name:`jest-shard-${suffix}-${shard}`, path:`backend/test-results/jest/shards/shard-${shard}`, maxBytes:128*MIB});
  // Public C240 includes complete failed traces (~293MB raw); reserve headroom
  // for all294 identities. Financial actual-record stages receive extra weight.
  const scopes = [{name:"deterministic-and-lifecycle", weight:128}, {name:"public-accessibility", weight:800}, {name:"public-performance", weight:12}];
  const raw = [];
  for (const [job, list] of [["browser-checks",scopes],["browser-role-journeys",groups.map(g=>({name:g.name,weight:g.expectedIdentities*(g.name==="financial-lifecycle"?3:g.adapter==="actual-shared"?2:1)}))]]) {
    for (const g of list) {
      add(job,g.name,`browser-${g.name}`,"backend/test-results/junit",4*MIB);
      // Keep the existing artifact name for consumers; now complete raw evidence always.
      const row={job,key:g.name,name:`browser-failure-${g.name}-${suffix}`,path:"backend/test-results",weight:g.weight};
      raw.push(row);
    }
  }
  const available=LIMIT-rows.reduce((n,r)=>n+r.maxBytes,0)-raw.length*16*MIB;
  const totalWeight=raw.reduce((n,r)=>n+r.weight,0);
  for(const r of raw) { const {weight,...row}=r; rows.push({...row,maxBytes:16*MIB+Math.floor(available*weight/totalWeight)}); }
  if(rows.length!==84 || new Set(rows.map(r=>r.name)).size!==84 || rows.reduce((n,r)=>n+r.maxBytes,0)>LIMIT) fail("Invalid finite allocation.");
  return rows;
}
function inventory(root,input) {
  root=fs.realpathSync(root);
  const target=path.resolve(root,input);
  if(!target.startsWith(root+path.sep)||/[\n\r*?\[\]{}]/.test(input)) fail("Only reviewed literal paths within checkout are allowed.");
  let cursor=root;
  for(const piece of path.relative(root,target).split(path.sep)) { cursor=path.join(cursor,piece); if(fs.lstatSync(cursor).isSymbolicLink()) fail("Symbolic links are forbidden."); }
  const files=[];
  function walk(p) {
    const st=fs.lstatSync(p), rel=path.relative(root,p).split(path.sep).join("/");
    if(st.isSymbolicLink()) fail("Symbolic links are forbidden.");
    if(Buffer.byteLength(rel)>4096) fail("ZIP entry name exceeds4096 bytes.");
    if(st.isDirectory()) { files.push({path:rel,type:"directory",bytes:0,sha256:null});for(const name of fs.readdirSync(p).sort()) walk(path.join(p,name)); }
    else if(st.isFile()) { const bytes=fs.readFileSync(p); const after=fs.statSync(p); if(st.size!==after.size||st.mtimeMs!==after.mtimeMs||bytes.length!==st.size) fail("Evidence changed during inventory."); files.push({path:rel,type:"file",bytes:bytes.length,sha256:sha(bytes)}); }
    else fail("Only regular evidence files are allowed.");
  }
  walk(target);
  if(!files.some(r=>r.type==="file")) fail("Required complete evidence is missing or empty.");
  return files;
}
function bound(files) {
  // Deliberately loose: DEFLATE expansion1%, every possible ZIP header/name/extra/
  // comment under256KiB per member,128KiB end/ZIP64 overhead. All directories,
  // including empty/hidden directories, are counted conservatively as members.
  return Math.ceil(files.reduce((n,r)=>n+r.bytes,0)*1.01)+files.length*256*1024+128*1024;
}
function guard({root=ROOT,job,key="",name,input,run,attempt,record}) {
  const row=catalog(run,attempt).find(r=>r.job===job&&r.key===String(key)&&r.name===name&&r.path===input);
  if(!row) fail("Unreviewed artifact name, scope or path.");
  const files=inventory(root,input), upperBoundBytes=bound(files);
  if(upperBoundBytes>row.maxBytes) fail(`Complete evidence upper bound${upperBoundBytes} exceeds allocation${row.maxBytes}; preserve evidence and investigate, never truncate.`);
  const proof={schemaVersion:1,repository:process.env.GITHUB_REPOSITORY,headSha:process.env.GITHUB_SHA,runId:String(run),attempt:String(attempt),artifact:row,upperBoundBytes,rawBytes:files.reduce((n,r)=>n+r.bytes,0),files,retentionDays:1,compressionLevel:9,completeEvidence:true};
  if(record) { const absolute=path.resolve(record);if(absolute.startsWith(path.resolve(root)+path.sep)) fail("Budget record must remain outside measured checkout.");fs.writeFileSync(absolute,JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600}); }
  return proof;
}
function main(args) {
  const options={};for(let i=0;i<args.length;i+=2){if(!/^--(job|key|artifact|path|record|run|attempt)$/.test(args[i])||args[i+1]===undefined)fail("Invalid exact command arguments.");if(Object.hasOwn(options,args[i].slice(2)))fail("Duplicate argument."); options[args[i].slice(2)]=args[i+1];}
  const proof=guard({job:options.job,key:options.key,name:options.artifact,input:options.path,record:options.record,run:options.run||process.env.GITHUB_RUN_ID,attempt:options.attempt||process.env.GITHUB_RUN_ATTEMPT});
  console.log(JSON.stringify({artifact:proof.artifact.name,files:proof.files.length,rawBytes:proof.rawBytes,upperBoundBytes:proof.upperBoundBytes,maxBytes:proof.artifact.maxBytes}));
}
if(require.main===module) { try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;} }
module.exports={catalog,inventory,bound,guard,LIMIT};
