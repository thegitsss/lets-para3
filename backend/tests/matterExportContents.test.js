const { Types } = require("mongoose");
const { execFileSync } = require("child_process");
const path = require("path");
const CaseFile = require("../models/CaseFile"), Message = require("../models/Message"), User = require("../models/User");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { encryptString } = require("../utils/dataEncryption");
const contents = require("../services/matterExportContents");
let caseId, actor, doc;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); caseId = new Types.ObjectId(); actor = new Types.ObjectId(); doc = { _id: caseId, attorney: actor, title: "Agreement <draft>", status: "completed", details: "First line\nSecond line", tasks: [] }; await User.collection.insertOne({ _id: actor, firstName: "Avery", lastName: "Lane", email: "PRIVATE_EMAIL" }); });
test("BSON and historical references decrypt without leaking private fields or deleted messages", async () => {
  await Message.collection.insertMany([{ _id: new Types.ObjectId(), caseId: String(caseId), senderId: actor, type: "audio", transcript: encryptString("Spoken <draft>\nNext line"), fileKey: encryptString(`cases/${caseId}/voice.webm`), fileName: encryptString("Voice note.webm"), createdAt: new Date("2026-09-01") }, { _id: new Types.ObjectId(), caseId, text: encryptString("DELETED_BODY"), deleted: true }, { _id: new Types.ObjectId(), caseId, senderId: actor, content: { text: "Legacy reply", files: [{ key: `cases/${caseId}/service.pdf`, name: "Receipt of service.pdf" }] } }]);
  await CaseFile.collection.insertOne({ _id: new Types.ObjectId(), caseId: String(caseId), originalName: encryptString("Receipt of service.pdf"), storageKey: encryptString(`cases/${caseId}/service.pdf`), revisionNotes: "PRIVATE_REVISION", history: [{ storageKey: encryptString(`cases/${caseId}/service-prior.pdf`) }] });
  const result = await contents.read({ ...doc, internalNotes: "PRIVATE_NOTE", files: [{ key: `cases/${caseId}/receipt-attorney-v2.pdf`, name: "Platform receipt.pdf" }] });
  expect(result.counts).toEqual({ messages: 2, documents: 3, priorVersions: 1, confidentialityDocuments: 0 }); expect(result.messages[0]).toMatchObject({ senderName: "Avery Lane", transcript: "Spoken <draft>\nNext line" }); expect(result.summary.attorneyName).toBe("Avery Lane");
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_EMAIL|PRIVATE_REVISION|PRIVATE_NOTE|DELETED_BODY|Platform receipt/); expect(result.documents.map(item => item.path)).toContain("Documents/Receipt of service.pdf");
});
test("safe ZIP names cannot overwrite one another or escape the archive directory", async () => {
  doc.files = ["Report.pdf", "report.PDF", "Report-1.pdf", "../Report.pdf", "CON.txt", "\\nested\\file.pdf"].map((name, index) => ({ name, key: `cases/${caseId}/${index}` }));
  const result = await contents.read(doc), paths = result.documents.map(item => item.path); expect(new Set(paths.map(name => name.toLowerCase())).size).toBe(paths.length); expect(paths.every(name => name.startsWith("Documents/") && !name.includes("..") && !name.includes("\\"))).toBe(true); expect(paths).toContain("Documents/document-CON.txt");
});
test("duplicate confidentiality keys retain their classification; other Matter records never join the archive", async () => {
  const key = `cases/${caseId}/nda.pdf`; await CaseFile.collection.insertMany([{ _id: new Types.ObjectId(), caseId, storageKey: key, originalName: "NDA.pdf" }, { _id: new Types.ObjectId(), caseId: new Types.ObjectId(), storageKey: "PRIVATE_OTHER", originalName: "OTHER_MATTER" }]);
  doc.preEngagement = { confidentialityDocument: { key, name: "NDA.pdf" } }; doc.files = [{ key, name: "Duplicate.pdf" }]; const result = await contents.read(doc); expect(result.counts.documents).toBe(1); expect(result.counts.confidentialityDocuments).toBe(1); expect(JSON.stringify(result)).not.toContain("OTHER_MATTER");
});
test.each(["cases/other/file.pdf", "../file.pdf", "cases/CASE/../escape.pdf", "cases/CASE/a\\b.pdf", "cases/CASE/a\u0000b.pdf"])("invalid storage reference %s fails closed", async key => { doc.files = [{ key: key.replace("CASE", String(caseId)), name: "File.pdf" }]; await expect(contents.read(doc)).rejects.toMatchObject({ publicCode: "EXPORT_SOURCE_INVALID" }); });
test("message and file limits refuse the archive instead of returning partial records", async () => {
  await Message.collection.insertMany(Array.from({ length: contents.limits.messages + 1 }, () => ({ _id: new Types.ObjectId(), caseId, text: "Retained" }))); await expect(contents.read(doc)).rejects.toMatchObject({ publicCode: "EXPORT_TOO_LARGE" }); await Message.collection.deleteMany({});
  await CaseFile.collection.insertMany(Array.from({ length: contents.limits.files + 1 }, (_, index) => ({ _id: new Types.ObjectId(), caseId, storageKey: `cases/${caseId}/${index}`, originalName: "File.pdf" }))); await expect(contents.read(doc)).rejects.toMatchObject({ publicCode: "EXPORT_TOO_LARGE" });
});

// A fresh Node process exercises the installed ESM ZIP dependency and real streams.
// Only storage and PDF rendering are substituted; actual PDFs are inspected separately.
function build(mode) {
  const root = path.resolve(__dirname, "..");
  const source = `
    const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Readable}=require('node:stream'),{execFileSync}=require('node:child_process');
    const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)},load=p=>path.join(root,p),mock=(p,exports)=>{require.cache[require.resolve(load(p))]={id:load(p),filename:load(p),loaded:true,exports}};
    process.env.S3_BUCKET='synthetic-archive-bucket';process.env.S3_MALWARE_SCAN_REQUIRED='true';
    const calls=[],controller=new AbortController();let scans=0,validations=0,closed=0,html='';const before=new Set(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('lpc-matter-export-')));
    mock('utils/s3Client.js',{createS3Client:()=>({send:async(command,options)=>{const kind=command.constructor.name;calls.push({kind,input:command.input});assert.ok(options.abortSignal);
      if(mode==='cancel')controller.abort();options.abortSignal.throwIfAborted();
      if(kind==='HeadObjectCommand')return {ContentLength:mode==='oversize'?251*1024*1024:4,ETag:'"original"',VersionId:'version-one'};
      if(kind==='GetObjectTaggingCommand'){scans++;return {TagSet:[{Key:'GuardDutyMalwareScanStatus',Value:mode==='blocked'?'THREATS_FOUND':mode==='pending'?'PENDING':mode==='scan-change'&&scans===2?'THREATS_FOUND':'NO_THREATS_FOUND'}]};}
      if(kind==='GetObjectCommand')return {Body:Readable.from([Buffer.from(mode==='short'?'abc':mode==='long'?'abcde':'DATA')]),ContentLength:4,ETag:mode==='changed'?'"changed"':'"original"',VersionId:'version-one'};
      throw new Error('Unexpected storage operation '+kind);
    }})});
    mock('utils/puppeteerBrowser.js',{launchPuppeteer:async()=>({newPage:async()=>({setContent:async value=>{html=value;},pdf:async()=>{if(mode==='pdf-failure')throw new Error('Synthetic PDF failure');return Buffer.from('%PDF-synthetic renderer');},close:async()=>{}}),close:async()=>{closed++;}})});
    const lifecycle=require(load('services/caseLifecycle.js')),source={summary:{title:'Matter <draft>',attorneyName:'Avery & Lane',paralegalName:'Casey',status:'completed',details:'First line\\nSecond line',tasks:[],currency:'USD',amount:40000},messages:[{id:'message',senderName:'Avery',type:'text',text:'Keep <legal text>\\nNew line',attachments:[]}],documents:[{key:'cases/'+'a'.repeat(24)+'/service.pdf',path:'Documents/Receipt of service.pdf',name:'Receipt of service.pdf',category:'document',recordedAt:null}],counts:{messages:1,documents:1,priorVersions:0,confidentialityDocuments:0}};
    (async()=>{let artifact;
      try{artifact=await lifecycle.buildArchiveZipFile({_id:'a'.repeat(24)},{contents:source,signal:controller.signal,validate:async()=>{validations++;if(mode==='validation'&&validations===2)throw Object.assign(new Error('Changed records'),{publicCode:'EXPORT_CHANGED'});}});
        assert.equal(mode,'success');const result=JSON.parse(execFileSync('python3',['-c','import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({"names":z.namelist(),"document":z.read("Documents/Receipt of service.pdf").decode(),"manifest":json.loads(z.read("Archive_contents.json"))}))',artifact.path],{encoding:'utf8'}));
        assert.equal(result.document,'DATA');assert.deepEqual(result.names.sort(),['Archive_contents.json','Case_Summary.pdf','Documents/Receipt of service.pdf']);assert.equal(result.manifest.documents[0].size,4);assert.ok(!JSON.stringify(result.manifest).includes('cases/'));assert.ok(html.includes('&lt;legal text&gt;'));assert.ok(html.includes('First line\\nSecond line'));assert.equal(validations,2);assert.equal(scans,2);assert.equal(closed,1);
        const get=calls.find(c=>c.kind==='GetObjectCommand');assert.equal(get.input.IfMatch,'"original"');assert.equal(get.input.VersionId,'version-one');assert.ok(calls.filter(c=>c.kind==='GetObjectTaggingCommand').every(c=>c.input.VersionId==='version-one'));await artifact.cleanup();
      }catch(error){if(mode==='success')throw error;const code=error.publicCode||error.code||error.name;const expected={changed:'EXPORT_SOURCE_CHANGED',short:'EXPORT_SOURCE_CHANGED',long:'EXPORT_SOURCE_CHANGED',oversize:'EXPORT_TOO_LARGE',blocked:'FILE_SECURITY_BLOCKED',pending:'FILE_SCAN_PENDING','scan-change':'FILE_SECURITY_BLOCKED',cancel:20,validation:'EXPORT_CHANGED','pdf-failure':'Error'}[mode];assert.equal(code,expected);}
      finally{if(artifact)await artifact.cleanup();}
      assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('lpc-matter-export-')&&!before.has(n)),[]);process.stdout.write('verified');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  expect(execFileSync(process.execPath, ["--eval", source], { encoding: "utf8", timeout: 20000 })).toContain("verified");
}
test.each(["success", "changed", "short", "long", "oversize", "blocked", "pending", "scan-change", "cancel", "validation", "pdf-failure"])("real ZIP preparation %s validates exact sources and cleans temporary files", mode => build(mode));
test.each(["concurrent", "upload-failure", "source-change"])("completion archives: %s retains separate keys and cleans preparation files", mode => {
  const source = `
    const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const root=${JSON.stringify(path.resolve(__dirname, ".."))},mode=${JSON.stringify(mode)},load=p=>path.join(root,p),mock=(file,exports)=>{const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};};
    process.env.S3_BUCKET='synthetic-archive-bucket';const before=new Set(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('lpc-matter-export-'))),uploads=[];let aborted=0,reads=0;
    mock(load('utils/s3Client.js'),{createS3Client:()=>({send:async()=>{throw new Error('Unexpected storage read or delete');}})});
    mock(require.resolve('@aws-sdk/lib-storage'),{Upload:class{constructor(options){this.options=options;uploads.push(options.params);}async done(){const chunks=[];for await(const chunk of this.options.params.Body)chunks.push(chunk);const zip=Buffer.concat(chunks);assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);if(mode==='upload-failure')throw new Error('Synthetic upload failure');}async abort(){aborted++;}}});
    mock(load('utils/puppeteerBrowser.js'),{launchPuppeteer:async()=>({newPage:async()=>({setContent:async()=>{},pdf:async()=>Buffer.from('%PDF-synthetic'),close:async()=>{}}),close:async()=>{}})});
    const contents=require(load('services/matterExportContents.js'));contents.read=async()=>({summary:{title:'Agreement',status:'completed',attorneyName:'Avery Lane',paralegalName:'Casey',tasks:[],amount:null,currency:'USD'},messages:[],documents:[],counts:{messages:0,documents:0,priorVersions:0,confidentialityDocuments:0},revision:mode==='source-change'&&++reads>1?'changed':'original'});
    const {generateArchiveZip}=require(load('services/caseLifecycle.js'));
    (async()=>{const doc={_id:'a'.repeat(24)};
      if(mode==='concurrent'){const results=await Promise.all([generateArchiveZip(doc),generateArchiveZip(doc)]);assert.notEqual(results[0].key,results[1].key);assert.ok(results.every(result=>result.key.startsWith('cases/'+doc._id+'/archive-')&&result.key.endsWith('.zip')));assert.equal(uploads.length,2);}
      else if(mode==='upload-failure'){await assert.rejects(generateArchiveZip(doc),/Synthetic upload failure/);assert.equal(aborted,1);}
      else{await assert.rejects(generateArchiveZip(doc),error=>error.publicCode==='EXPORT_CHANGED');assert.equal(uploads.length,0);}
      assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('lpc-matter-export-')&&!before.has(n)),[]);process.stdout.write('verified');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  expect(execFileSync(process.execPath, ["--eval", source], { encoding: "utf8", timeout: 20000 })).toContain("verified");
});

test("removed documents and their retained prior versions are excluded", async () => {
  const Removal = require("../models/MatterFileRemoval"), oldKey = `cases/${caseId}/documents/prior.txt`;
  await Removal.collection.insertOne({ caseId, snapshot: { originalName: encryptString("Lease.txt"), storageKey: encryptString(`cases/${caseId}/documents/REMOVED_CURRENT.txt`), futurePrivate: "PRIVATE_REMOVAL_EVIDENCE", history: [{ storageKey: encryptString(oldKey), replacedAt: new Date("2026-09-01") }] }, removedMirrors: [{ original: "Lease mirror.txt", key: "PRIVATE_CURRENT_MIRROR", history: [{ key: `cases/${caseId}/documents/mirror-prior.txt` }] }] });
  const result = await contents.read(doc); expect(result.counts).toMatchObject({ documents: 0, priorVersions: 0 }); expect(result.documents).toEqual([]); expect(JSON.stringify(result)).not.toMatch(/REMOVED_CURRENT|PRIVATE_REMOVAL|PRIVATE_CURRENT_MIRROR|prior.txt/);
});
test("internal removed-document evidence cannot block available matter records", async () => {
  const Removal = require("../models/MatterFileRemoval");
  await Removal.collection.insertOne({ caseId, snapshot: { originalName: "Lease.txt", history: { unknown: "INVALID_HISTORY" } }, removedMirrors: [] });
  await expect(contents.read(doc)).resolves.toMatchObject({ documents: [], counts: { documents: 0 } });
});

test('download ZIP includes attorney notes, conversation and a separate receipt PDF', () => {
  const source = `
    const assert=require('node:assert/strict'),path=require('node:path'),{execFileSync}=require('node:child_process');
    const root=${JSON.stringify(path.resolve(__dirname, '..'))},mock=(file,exports)=>{const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};};
    const html=[];process.env.S3_BUCKET='synthetic-archive-bucket';
    mock(path.join(root,'utils/puppeteerBrowser.js'),{launchPuppeteer:async()=>({newPage:async()=>({setContent:async text=>html.push(text),pdf:async()=>Buffer.from('%PDF-test-record'),close:async()=>{}}),close:async()=>{}})});
    (async()=>{const {buildArchiveZipFile}=require(path.join(root,'services/caseLifecycle.js'));
      const artifact=await buildArchiveZipFile({_id:'b'.repeat(24)},{contents:{summary:{title:'Matter',status:'completed',attorneyName:'Avery',paralegalName:'Casey',tasks:[],amount:65000,currency:'USD'},messages:[{id:'one',senderName:'Casey',senderRole:'paralegal',text:'Completed work',attachments:[]}],documents:[],attorneyNotes:'Private attorney note <safe>',receipts:[{path:'Receipts/payment-payment.pdf',payload:{title:'Payment receipt',receiptId:'pi_test',lineItems:[],totalAmount:'$780.00'}}],counts:{messages:1,documents:0,receipts:1,notes:1}}});
      try{const result=JSON.parse(execFileSync('python3',['-c','import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.read("Receipts/payment-payment.pdf").startswith(b"%PDF-");print(json.dumps({"names":z.namelist(),"manifest":json.loads(z.read("Archive_contents.json"))}))',artifact.path],{encoding:'utf8'}));assert.ok(result.names.includes('Case_Summary.pdf'));assert.equal(result.manifest.attorneyNotesIncluded,true);assert.deepEqual(result.manifest.receipts,['Receipts/payment-payment.pdf']);assert.ok(html[0].includes('Private attorney note &lt;safe&gt;'));assert.ok(html[0].includes('Completed work'));assert.ok(html[1].includes('Payment receipt'));}finally{await artifact.cleanup();}process.stdout.write('verified');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  expect(execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 20000 })).toContain('verified');
});
