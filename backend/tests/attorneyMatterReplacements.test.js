process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_uploads";
process.env.S3_BUCKET = "synthetic-upload-bucket";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const mockSend = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockSend }) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server"), { clearDatabase } = require("./helpers/db");
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), User = require("../models/User"), Upload = require("../models/MatterFileUpload");
const AuditLog = require("../models/AuditLog"), Notification = require("../models/Notification"), Notice = require("../models/MatterFileNotification");
const account = require("../services/attorneyAccountBoundary"), { decryptCaseFilePayload } = require("../utils/dataEncryption");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/uploads", require("../routes/uploads"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let mongo, owner, other, para, doc;
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } }); await mongoose.connect(mongo.getUri("attorney-uploads")); await Promise.all(Object.values(mongoose.models).map(model => model.init())); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); mockSend.mockReset(); mockSend.mockResolvedValue({});
  [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@uploads.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  doc = await Case.create({ attorney: owner._id, attorneyId: owner._id, title: "Lease documents", details: "Read the lease.", practiceArea: "contract law", state: "New York", paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_uploads" });
  await Case.collection.updateOne({ _id: doc._id }, { $set: { retainedUnknown: { evidence: "PRESERVE" } } });
});
const read = (requestId, user = owner, extra = {}) => request(app).get(`/api/uploads/case/${doc._id}/upload-review`).query({ expectedOwnerId: String(user._id), ...(requestId ? { requestId } : {}), ...extra }).set("Cookie", cookie(user));
const review = async () => { const response = await read(); expect(response.status).toBe(200); return response.body; };
const send = (revision, requestId = crypto.randomUUID(), { user = owner, name = "Lease.txt", bytes = Buffer.from("Lease exhibit B."), type = "text/plain", extra = {} } = {}) => {
  let result = request(app).post(`/api/uploads/case/${doc._id}/reviewed-upload`).set("Cookie", cookie(user)).field("expectedOwnerId", String(user._id)).field("reviewedRevision", revision).field("requestId", requestId);
  for (const [key, value] of Object.entries(extra)) result = result.field(key, value);
  return result.attach("file", bytes, { filename: name, contentType: type });
};

let file;
beforeEach(async()=>{file=await CaseFile.create({caseId:doc._id,userId:para._id,originalName:'Lease.txt',storageKey:`cases/${doc._id}/documents/original.txt`,previewKey:`cases/${doc._id}/previews/original.pdf`,previewMimeType:'application/pdf',previewSize:100,mimeType:'text/plain',size:30,version:3,uploadedByRole:'paralegal',status:'approved',approvedAt:new Date('2026-09-01'),revisionNotes:'Earlier instructions',revisionRequestedAt:new Date('2026-08-30'),securityStatus:'not_required',history:[{storageKey:`cases/${doc._id}/documents/old.txt`,replacedAt:new Date('2026-08-01')}]});await CaseFile.collection.updateOne({_id:file._id},{$set:{retainedUnknown:{source:'PRESERVE'},'history.0.retainedUnknown':{source:'KEEP_HISTORY'}}});});
const readReplacement=(requestId,user=owner,fileId=file._id)=>request(app).get(`/api/uploads/case/${doc._id}/replacement-review/${fileId}`).query({expectedOwnerId:String(user._id),...(requestId?{requestId}:{})}).set('Cookie',cookie(user));
const replacementReview=async()=>{const value=await readReplacement();expect(value.status).toBe(200);return value.body;};
const replace=(value,requestId=crypto.randomUUID(),options={})=>{const user=options.user||owner;return request(app).post(`/api/uploads/case/${doc._id}/reviewed-replacement/${options.fileId||file._id}`).set('Cookie',cookie(user)).field('expectedOwnerId',String(user._id)).field('reviewedRevision',value.revision).field('reviewedFileRevision',value.target.reviewRevision).field('requestId',requestId).attach('file',options.bytes||Buffer.from('Replacement exhibit C'),{filename:options.name||'Lease.txt',contentType:'text/plain'});};
test('replacement preserves identity, unknown metadata and older contents while clearing approval and stale preview',async()=>{
 const before=await CaseFile.collection.findOne({_id:file._id}),matterBefore=await Case.collection.findOne({_id:doc._id}),value=await replacementReview(),requestId=crypto.randomUUID();const result=await replace(value,requestId);expect(result.status).toBe(200);expect(result.body.file).toMatchObject({id:String(file._id),name:'Lease.txt',version:4,status:'attorney_revision',uploadedByRole:'attorney',canReview:false});expect(await CaseFile.countDocuments()).toBe(1);
 const raw=await CaseFile.collection.findOne({_id:file._id}),saved=decryptCaseFilePayload(raw);expect(raw.retainedUnknown).toEqual(before.retainedUnknown);expect(raw.history[0]).toEqual(before.history[0]);expect(raw.history[1].storageKey).toBe(before.storageKey);expect(raw.createdAt).toEqual(before.createdAt);expect(saved.previewKey).toBe('');expect(saved.previewSize).toBe(0);expect(saved.approvedAt).toBeNull();expect(saved.revisionNotes).toBe('');expect(saved.revisionRequestedAt).toBeNull();expect(saved.storageKey).not.toBe(decryptCaseFilePayload(before).storageKey);expect(saved.history).toHaveLength(2);
 const operation=await Upload.collection.findOne({requestId});expect(operation.kind).toBe('replacement');expect(require('../utils/dataEncryption').decryptString(operation.retiredPreviewKey)).toBe(decryptCaseFilePayload(before).previewKey);expect(JSON.stringify(result.body)).not.toMatch(/storageKey|retiredPreviewKey|claimToken|PRESERVE/);
 for(const user of [owner,para]){const shared=await request(app).get(`/api/uploads/case/${doc._id}?presentation=matter`).set('Cookie',cookie(user));expect(shared.status).toBe(200);expect(shared.body.files[0]).toMatchObject({version:4,status:'attorney_revision'});}
 const matterAfter=await Case.collection.findOne({_id:doc._id});for(const key of ['status','escrowStatus','escrowIntentId','paymentReleased','retainedUnknown','files'])expect(matterAfter[key]).toEqual(matterBefore[key]);expect((await replace(value,requestId)).body.file.id).toBe(String(file._id));expect(mockSend).toHaveBeenCalledTimes(1);
});
test('stale reviewed target and an unrelated file cannot be replaced',async()=>{
 const value=await replacementReview();await CaseFile.collection.updateOne({_id:file._id},{$set:{version:4}});expect((await replace(value)).status).toBe(409);expect((await replace(value,crypto.randomUUID(),{fileId:new mongoose.Types.ObjectId()})).status).toBe(409);expect(mockSend).not.toHaveBeenCalled();
});
test('a target replaced during storage prevents this attempt from overwriting its winner',async()=>{
 const value=await replacementReview();mockSend.mockImplementationOnce(async()=>CaseFile.collection.updateOne({_id:file._id},{$set:{version:4,originalName:'Other replacement.txt'}}));expect((await replace(value)).status).toBe(409);expect((await CaseFile.findById(file._id)).originalName).toBe('Other replacement.txt');expect((await Upload.findOne()).status).toBe('unconfirmed');
});
test('a target write winning inside the transaction rolls back the Matter guard and replacement receipt',async()=>{
 const value=await replacementReview(),before=await Case.collection.findOne({_id:doc._id}),original=CaseFile.collection.updateOne.bind(CaseFile.collection);let once=false;jest.spyOn(CaseFile.collection,'updateOne').mockImplementation(async(query,change,opts)=>{if(opts?.session&&!once){once=true;await original({_id:file._id},{$set:{version:5}});}return original(query,change,opts);});expect((await replace(value)).status).toBe(503);expect((await CaseFile.findById(file._id)).version).toBe(5);expect(await Case.collection.findOne({_id:doc._id})).toEqual(before);expect((await Upload.findOne()).status).toBe('unconfirmed');
});
test('lost replacement confirmation recovers the exact file and never writes a second replacement',async()=>{
 const value=await replacementReview(),requestId=crypto.randomUUID(),start=mongoose.startSession.bind(mongoose);jest.spyOn(mongoose,'startSession').mockImplementation(async(...args)=>{const session=await start(...args),commit=session.commitTransaction.bind(session);session.commitTransaction=async()=>{await commit();throw new Error('Lost replacement acknowledgement');};return session;});expect((await replace(value,requestId)).status).toBe(503);expect((await readReplacement(requestId)).body.upload.file).toMatchObject({id:String(file._id),version:4});expect((await replace(value,requestId)).status).toBe(200);expect(mockSend).toHaveBeenCalledTimes(1);expect((await CaseFile.findById(file._id)).history).toHaveLength(2);
});
test('original upload recovery names a later replacement without treating newer bytes as its proof',async()=>{
 const value=await review(),requestId=crypto.randomUUID(),uploaded=await send(value.revision,requestId,{name:'Second.txt'});expect(uploaded.status).toBe(200);file=await CaseFile.findById(uploaded.body.file.id);const replacement=await replacementReview();expect((await replace(replacement,crypto.randomUUID(),{name:'Second replaced.txt'})).status).toBe(200);const recovered=await read(requestId);expect(recovered.body.upload).toMatchObject({status:'recorded',changedSinceUpload:true,file:{id:String(file._id),name:'Second replaced.txt'}});expect((await CaseFile.collection.findOne({_id:file._id})).clientUploadId).toBe(requestId);expect((await send(value.revision,requestId,{name:'Second.txt'})).body.changedSinceUpload).toBe(true);expect(mockSend).toHaveBeenCalledTimes(2);
});
test('deleted replacement target stays unavailable when its recorded request is replayed',async()=>{
 const value=await replacementReview(),requestId=crypto.randomUUID();expect((await replace(value,requestId)).status).toBe(200);await CaseFile.deleteOne({_id:file._id});const recovery=await readReplacement(requestId);expect(recovery.body).toMatchObject({canUpload:false,target:null,upload:{status:'recorded',file:null,retryAllowed:false}});expect((await replace(value,requestId)).body.file).toBeNull();expect(await CaseFile.countDocuments()).toBe(0);expect(mockSend).toHaveBeenCalledTimes(1);
});
test.each([{status:'paused'},{archived:true},{paymentReleased:true},{completionClaimStatus:'claimed'},{paralegalAccessRevokedAt:new Date()}])('Matter restriction %j prevents replacing bytes',async patch=>{
 await Case.collection.updateOne({_id:doc._id},{$set:patch});const value=await replacementReview();expect(value.canUpload).toBe(false);expect((await replace(value)).status).toBe(403);expect(mockSend).not.toHaveBeenCalled();
});
test('account revocation after storage prevents replacement and retains the original document',async()=>{
 const value=await replacementReview(),before=await CaseFile.collection.findOne({_id:file._id});mockSend.mockImplementationOnce(async()=>User.collection.updateOne({_id:owner._id},{$set:{authVersion:1}}));expect((await replace(value)).status).toBe(403);expect(await CaseFile.collection.findOne({_id:file._id})).toEqual(before);
});
test('wrong roles, owners and request reuse across targets or modes cannot replace files',async()=>{
 const value=await replacementReview(),requestId=crypto.randomUUID();for(const user of [other,para])expect((await replace(value,crypto.randomUUID(),{user})).status).toBe(403);expect((await replace(value,requestId)).status).toBe(200);expect((await read(requestId)).status).toBe(409);expect((await readReplacement(requestId,owner,new mongoose.Types.ObjectId())).status).toBe(409);expect((await replace(value,requestId,{bytes:Buffer.from('Other replacement bytes')})).status).toBe(409);expect(mockSend).toHaveBeenCalledTimes(1);
});
test('replacement recovery preserves earlier text reference formats instead of normalizing the file',async()=>{
 await CaseFile.collection.updateOne({_id:file._id},{$set:{caseId:String(doc._id),userId:String(para._id)}});const value=await replacementReview(),requestId=crypto.randomUUID();expect((await replace(value,requestId)).status).toBe(200);expect((await readReplacement(requestId)).body.upload.file.id).toBe(String(file._id));expect((await CaseFile.collection.findOne({_id:file._id})).caseId).toBe(String(doc._id));
});
test('two replacement attempts preserve the winning target and retain the losing attempt for recovery',async()=>{
 const value=await replacementReview(),firstId=crypto.randomUUID(),secondId=crypto.randomUUID();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});mockSend.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;entered();}));const first=replace(value,firstId).then(response=>response);await ready;const second=await replace(value,secondId,{name:'Winner.txt'});expect(second.status).toBe(200);release({});expect((await first).status).toBe(409);expect(decryptCaseFilePayload(await CaseFile.findById(file._id)).originalName).toBe('Winner.txt');expect((await readReplacement(firstId)).body.upload).toEqual({status:'unconfirmed',file:null,retryAllowed:true});expect((await readReplacement(secondId)).body.upload.file.name).toBe('Winner.txt');expect(await CaseFile.countDocuments()).toBe(1);expect(mockSend).toHaveBeenCalledTimes(2);
});

test('a replacement audit failure rolls back the replacement and permits one explicit retry',async()=>{
 const value=await replacementReview(),requestId=crypto.randomUUID(),prior=await CaseFile.collection.findOne({_id:file._id});
 const failure=jest.spyOn(AuditLog,'create').mockRejectedValueOnce(new Error('Synthetic audit failure'));
 expect((await replace(value,requestId)).status).toBe(503);failure.mockRestore();
 expect(await CaseFile.collection.findOne({_id:file._id})).toEqual(prior);
 expect(await AuditLog.countDocuments({action:'case.file.replace'})).toBe(0);
 const result=await replace(value,requestId);expect(result.status).toBe(200);
 expect(await AuditLog.findOne({action:'case.file.replace'})).toMatchObject({actor:owner._id,targetType:'case',targetId:String(doc._id),meta:{fileId:String(file._id)}});
 expect(await Notification.countDocuments()).toBe(0);expect(await Notice.countDocuments()).toBe(0);
 expect((await replace(value,requestId)).status).toBe(200);expect(await AuditLog.countDocuments({action:'case.file.replace'})).toBe(1);
});
