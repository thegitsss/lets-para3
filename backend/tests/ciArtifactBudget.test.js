const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {catalog,inventory,bound,guard,LIMIT}=require("../scripts/guard-ci-artifact-budget");
const {parseWorkflow,validateWorkflowContract}=require("../scripts/check-ci-workflow");
const workflow=()=>parseWorkflow(fs.readFileSync(path.resolve(__dirname,"../../.github/workflows/quality.yml"),"utf8"));
let root;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),"lpc-artifact-budget-"));});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
test("all83 expanded artifacts have disjoint finite allocations within10GiB, bound to exact attempt",()=>{
 const rows=catalog("12345","2");expect(rows).toHaveLength(83);expect(new Set(rows.map(x=>x.name)).size).toBe(83);expect(rows.reduce((n,r)=>n+r.maxBytes,0)).toBeLessThanOrEqual(LIMIT);
 expect(rows.filter(x=>x.path==="backend/test-results")).toHaveLength(35);
 expect(rows.filter(x=>x.path==="backend/test-results/junit")).toHaveLength(35);
 expect(()=>catalog("0","2")).toThrow(/positive/);
});
test("complete hidden evidence and empty directories are conserved in the ZIP bound",()=>{
 fs.mkdirSync(path.join(root,"backend/test-results/empty"),{recursive:true});fs.writeFileSync(path.join(root,"backend/test-results/.private-proof"),"exact confidential synthetic bytes");
 const files=inventory(root,"backend/test-results");expect(files.some(x=>x.path.endsWith(".private-proof")&&x.type==="file")).toBe(true);expect(files.some(x=>x.path.endsWith("empty")&&x.type==="directory")).toBe(true);
 expect(bound(files)).toBeGreaterThan(files.reduce((n,r)=>n+r.bytes,0));
 const selected=catalog("12345","1").find(x=>x.job==="browser-checks"&&x.key==="public-performance"&&x.path==="backend/test-results");
 const p=guard({root,job:selected.job,key:selected.key,name:selected.name,input:selected.path,run:"12345",attempt:"1"});expect(p.completeEvidence).toBe(true);expect(p.files).toEqual(files);expect(fs.readFileSync(path.join(root,"backend/test-results/.private-proof"),"utf8")).toBe("exact confidential synthetic bytes");
});
test("oversized proof fails before upload without deleting or truncating any evidence",()=>{
 const selected=catalog("12345","1").find(x=>x.name==="candidate-identity-12345-1");fs.mkdirSync(path.join(root,"backend/test-results/release"),{recursive:true});const p=path.join(root,selected.path);fs.writeFileSync(p,Buffer.alloc(selected.maxBytes,7));
 expect(()=>guard({root,job:selected.job,name:selected.name,input:selected.path,run:"12345",attempt:"1"})).toThrow(/exceeds allocation/);expect(fs.statSync(p).size).toBe(selected.maxBytes);expect(fs.readFileSync(p)[0]).toBe(7);
});
test.each(["../escape","backend/test-results/*"])("rejects unreviewed or globbed path %s",p=>{expect(()=>inventory(root,p)).toThrow(/literal paths/);});
test("empty required data, linked parent and linked evidence cannot bypass the boundary",()=>{
 fs.mkdirSync(path.join(root,"backend/test-results"),{recursive:true});expect(()=>inventory(root,"backend/test-results")).toThrow(/missing or empty/);
 fs.symlinkSync(__filename,path.join(root,"backend/test-results/linked"));expect(()=>inventory(root,"backend/test-results")).toThrow(/Symbolic/);
 fs.rmSync(path.join(root,"backend"),{recursive:true});fs.symlinkSync(path.dirname(__filename),path.join(root,"backend"));expect(()=>inventory(root,"backend/ciArtifactBudget.test.js")).toThrow(/Symbolic/);
});
test("wrong artifact scope, attempt or narrowed path is never a smaller accepted upload",()=>{
 expect(()=>guard({root,job:"browser-checks",key:"public-performance",name:"browser-failure-public-performance-12345-2",input:"backend/test-results/junit",run:"12345",attempt:"1"})).toThrow(/Unreviewed/);
});
test.each(["failure-only","seven-days","optional-files","narrowed-path","missing-guard","unguarded-always","new-artifact"])("workflow fails closed for %s evidence drift",kind=>{
 const w=workflow(),j=w.jobs["browser-role-journeys"],s=j.steps.find(x=>x.name==="Upload complete raw browser evidence");
 if(kind==="failure-only")s.if="failure()";
 if(kind==="seven-days")s.with["retention-days"]=7;
 if(kind==="optional-files")s.with["if-no-files-found"]="ignore";
 if(kind==="narrowed-path")s.with.path="backend/test-results/junit";
 if(kind==="missing-guard")j.steps.splice(j.steps.indexOf(s)-1,1);
 if(kind==="unguarded-always")s.if="always()";
 if(kind==="new-artifact")s.with.name="unbudgeted";
 expect(()=>validateWorkflowContract(w)).toThrow();
});
test("an inert or failure-swallowing budget command cannot open an upload gate",()=>{
 const w=workflow(),j=w.jobs["browser-role-journeys"],s=j.steps.find(x=>x.name==="Upload complete raw browser evidence"),g=j.steps[j.steps.indexOf(s)-1];g.run+="; true";
 expect(()=>validateWorkflowContract(w)).toThrow(/exact always/);
});
