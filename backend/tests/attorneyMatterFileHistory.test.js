process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_document_review";
process.env.S3_BUCKET = "synthetic-document-review";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const mockStorage = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockStorage }) }));
const { Readable } = require("node:stream");
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server"), { clearDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), User = require("../models/User");
const account = require("../services/attorneyAccountBoundary"), { decryptCaseFilePayload } = require("../utils/dataEncryption");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/uploads", require("../routes/uploads"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let mongo, owner, other, para, doc, file;
beforeAll(async () => { mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } }); await mongoose.connect(mongo.getUri("attorney-files")); await Promise.all(Object.values(mongoose.models).map(model => model.init())); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); }); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); mockStorage.mockReset(); mockStorage.mockResolvedValue({ Body: Readable.from(["Earlier legal document"]), ContentLength: 22 }); [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@files.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  doc = await Case.create({ attorney: owner._id, attorneyId: owner._id, title: "Lease document review", details: "Review the lease.", practiceArea: "contract law", state: "New York", paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_files", tasks: [{ title: "Review", completed: false }] });
  file = await CaseFile.create({ caseId: doc._id, userId: para._id, originalName: "Lease.txt", storageKey: `cases/${doc._id}/documents/lease.txt`, mimeType: "text/plain", size: 40, uploadedByRole: "paralegal", securityStatus: "not_required" });
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { retainedUnknown: { evidence: "PRESERVE" } } });
});
const read = (query = {}, user = owner) => request(app).get(`/api/cases/${doc._id}/files/review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const review = async () => { const result = await read(); expect(result.status).toBe(200); return result.body.files[0]; };
const save = (selected, status = "approved", notes = "", user = owner) => request(app).post(`/api/cases/${doc._id}/files/${selected.id}/review`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), reviewedRevision: selected.reviewRevision, status, notes });

const history = (selected, query = {}, user = owner) => request(app).get(`/api/cases/${doc._id}/files/${file._id}/history`).query({expectedOwnerId:String(user._id),reviewedRevision:selected.reviewRevision,...query}).set("Cookie",cookie(user));
const priorDownload = entry => request(app).get(`/api/cases/${doc._id}/files/${file._id}/history/${entry.index}/download`).query({expectedOwnerId:String(owner._id),revision:entry.revision}).set("Cookie",cookie(owner));
async function seedHistory(count=2){await CaseFile.collection.updateOne({_id:file._id},{$set:{history:Array.from({length:count},(_,index)=>({storageKey:`cases/${doc._id}/documents/earlier-${index}.txt`,replacedAt:new Date(1700000000000+index*1000),retainedUnknown:{index}}))}});return review();}
test("history pages retain exact entries without exposing storage keys or inventing version metadata",async()=>{
 const selected=await seedHistory(31),before=await CaseFile.collection.findOne({_id:file._id}),first=await history(selected);expect(first.status).toBe(200);expect(first.body.entries).toHaveLength(25);expect(first.body.entries[0].index).toBe(30);expect(first.body.nextCursor).toBe('25');expect(first.headers['cache-control']).toBe('private, no-store');expect(JSON.stringify(first.body)).not.toMatch(/storageKey|earlier-|retainedUnknown|originalName|mimeType|version/);
 const second=await history(selected,{cursor:first.body.nextCursor});expect(second.status).toBe(200);expect(second.body.entries).toHaveLength(6);expect(second.body.nextCursor).toBeNull();expect(new Set([...first.body.entries,...second.body.entries].map(entry=>entry.index)).size).toBe(31);expect(await CaseFile.collection.findOne({_id:file._id})).toEqual(before);expect(mockStorage).not.toHaveBeenCalled();
});
test("recorded revision responses are paged by exact links and preserve their individual review status",async()=>{
 const selected=await seedHistory(0);await CaseFile.create(Array.from({length:28},(_,i)=>({caseId:doc._id,userId:para._id,originalName:'Response '+i+'.txt',storageKey:`cases/${doc._id}/documents/response-${i}.txt`,mimeType:'text/plain',version:i+2,revisionOfFileId:file._id,revisionOfVersion:1,revisionRequestAt:new Date('2026-09-01'),uploadedByRole:'paralegal',securityStatus:'not_required',status:i===0?'approved':'pending_review'})));
 const first=await history(selected);expect(first.status).toBe(200);expect(first.body.responses).toHaveLength(25);const second=await history(selected,{responseCursor:first.body.nextResponseCursor});expect(second.body.responses).toHaveLength(3);expect(new Set([...first.body.responses,...second.body.responses].map(file=>file.id)).size).toBe(28);expect(second.body.responses.some(file=>file.status==='approved')).toBe(true);expect((await CaseFile.findById(file._id)).status).toBe('pending_review');
});
test("prior downloads stream only the selected contents and do not alter current security metadata",async()=>{
 const selected=await seedHistory(),listed=await history(selected),before=await CaseFile.collection.findOne({_id:file._id});const result=await priorDownload(listed.body.entries[0]);expect(result.status).toBe(200);expect(result.headers['content-type']).toMatch(/^application\/octet-stream/);expect(result.headers['content-disposition']).toMatch(/^attachment/);expect(result.headers['x-content-type-options']).toBe('nosniff');expect(result.body.toString()).toBe('Earlier legal document');expect(mockStorage.mock.calls[0][0].input.Key).toBe(`cases/${doc._id}/documents/earlier-1.txt`);expect(await CaseFile.collection.findOne({_id:file._id})).toEqual(before);
});
test("changed history invalidates old listing and download selections",async()=>{
 const selected=await seedHistory(),listed=await history(selected);await CaseFile.collection.updateOne({_id:file._id},{$push:{history:{storageKey:`cases/${doc._id}/documents/new-earlier.txt`,replacedAt:new Date()}}});expect((await history(selected)).status).toBe(409);expect((await priorDownload(listed.body.entries[0])).status).toBe(409);expect(mockStorage).not.toHaveBeenCalled();
});
test("account revocation while historical storage responds prevents its bytes being returned",async()=>{
 const selected=await seedHistory(),listed=await history(selected);mockStorage.mockImplementation(async()=>{await User.collection.updateOne({_id:owner._id},{$set:{authVersion:1}});return {Body:Readable.from(['PRIVATE_HISTORY_SENTINEL']),ContentLength:24};});const result=await priorDownload(listed.body.entries[0]);expect(result.status).toBe(403);expect(JSON.stringify(result.body)).not.toContain('PRIVATE_HISTORY_SENTINEL');
});
test.each([{status:'completed'},{status:'disputed'},{paymentReleased:true},{purgedAt:new Date()}])("restriction %j closes history and downloads",async patch=>{
 const selected=await seedHistory(),listed=await history(selected);await Case.collection.updateOne({_id:doc._id},{$set:patch});expect((await history(selected)).status).toBe(403);expect((await priorDownload(listed.body.entries[0])).status).toBe(403);expect(mockStorage).not.toHaveBeenCalled();
});
test("wrong owner, role and invalid history queries fail closed",async()=>{
 const selected=await seedHistory();for(const [user,status] of [[other,404],[para,403]])expect((await history(selected,{},user)).status).toBe(status);for(const query of [{cursor:'-1'},{cursor:'99999'},{responseCursor:'bad'},{preview:'true'},{reviewedRevision:'bad'}])expect([400,409]).toContain((await history(selected,query)).status);expect(mockStorage).not.toHaveBeenCalled();
});

test.each([['THREATS_FOUND',422],['FAILED',503],['',423]])("earlier-object scan %s denies bytes without rewriting the current document",async(tag,status)=>{
 const selected=await seedHistory(),listed=await history(selected),before=await CaseFile.collection.findOne({_id:file._id});process.env.S3_MALWARE_SCAN_REQUIRED='true';mockStorage.mockResolvedValue({TagSet:[{Key:'GuardDutyMalwareScanStatus',Value:tag}]});
 try{expect((await priorDownload(listed.body.entries[0])).status).toBe(status);expect(mockStorage).toHaveBeenCalledTimes(1);expect(mockStorage.mock.calls[0][0].constructor.name).toBe('GetObjectTaggingCommand');expect(await CaseFile.collection.findOne({_id:file._id})).toEqual(before);}finally{process.env.S3_MALWARE_SCAN_REQUIRED='false';}
});
test("a changed history entry while storage responds is not returned as the selected document",async()=>{
 const selected=await seedHistory(),listed=await history(selected);mockStorage.mockImplementation(async()=>{await CaseFile.collection.updateOne({_id:file._id},{$set:{'history.1.storageKey':`cases/${doc._id}/documents/replaced-history.txt`}});return{Body:Readable.from(['OLD_HISTORY_SENTINEL']),ContentLength:20};});const result=await priorDownload(listed.body.entries[0]);expect(result.status).toBe(409);expect(JSON.stringify(result.body)).not.toContain('OLD_HISTORY_SENTINEL');
});
test("out-of-Matter historical keys and inline-preview attempts do not reach storage",async()=>{
 const selected=await seedHistory();await CaseFile.collection.updateOne({_id:file._id},{$set:{'history.1.storageKey':`cases/${other._id}/documents/foreign.txt`}});const current=await review(),listed=await history(current);expect((await priorDownload(listed.body.entries[0])).status).toBe(409);expect(mockStorage).not.toHaveBeenCalled();const inline=await request(app).get(`/api/cases/${doc._id}/files/${file._id}/history/0/download`).query({expectedOwnerId:String(owner._id),revision:listed.body.entries[1].revision,preview:'true'}).set('Cookie',cookie(owner));expect(inline.status).toBe(400);expect(mockStorage).not.toHaveBeenCalled();expect(selected).toBeTruthy();
});
test("ownership changing during the response join prevents historical metadata being returned",async()=>{
 const selected=await seedHistory(),original=CaseFile.collection.find.bind(CaseFile.collection);let joins=0;
 jest.spyOn(CaseFile.collection,'find').mockImplementation((query,...args)=>{const cursor=original(query,...args);if(query.revisionOfFileId&&++joins===2){const read=cursor.toArray.bind(cursor);cursor.toArray=async()=>{const rows=await read();await Case.collection.updateOne({_id:doc._id},{$set:{attorney:other._id,attorneyId:other._id}});return rows;};}return cursor;});
 const response=await history(selected);expect(response.status).toBe(403);expect(response.body.entries).toBeUndefined();expect(mockStorage).not.toHaveBeenCalled();
});
