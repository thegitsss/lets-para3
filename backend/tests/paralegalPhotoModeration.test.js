const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { Readable } = require("stream");
process.env.S3_BUCKET = "photo-moderation-test";
process.env.S3_REGION = "us-east-1";
process.env.S3_MALWARE_SCAN_REQUIRED = "true";
jest.mock("../utils/email", () => Object.assign(jest.fn(async () => ({ok:true})), {sendProfilePhotoRejectedEmail:jest.fn(async () => ({ok:true}))}));
jest.mock("../utils/stripe", () => ({}));
const mockSend = jest.fn();
jest.mock("@aws-sdk/client-s3", () => {
  class S3Client { constructor() { this.send = mockSend; } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  class HeadObjectCommand { constructor(input) { this.input = input; } }
  class GetObjectTaggingCommand { constructor(input) { this.input = input; } }
  return {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,HeadObjectCommand,GetObjectTaggingCommand};
});
jest.mock("@aws-sdk/s3-request-presigner", () => ({getSignedUrl:jest.fn(async () => "https://synthetic.invalid/object")}));
const User = require("../models/User");
const StorageDeletionTask = require("../models/StorageDeletionTask");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use("/api/users", require("../routes/users"));
app.use("/api/uploads", require("../routes/uploads"));
app.use("/api/admin", require("../routes/admin"));
app.use("/api/public/paralegals", require("../routes/publicParalegalDirectory"));
app.use((error,_req,res,_next) => res.status(500).json({error:error.message}));
// Self-contained synthetic PNG; do not depend on disposable audit artifacts.
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const cookie = user => `token=${jwt.sign({id:String(user._id),role:user.role,status:user.status,email:user.email},process.env.JWT_SECRET,{expiresIn:"1h"})}`;
const stored = user => User.findById(user._id).select("+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey").lean();
let user, admin, oldKey, oldOriginal;
async function upload({flag="1",guarded=true,crop}={}) {
  let operation = request(app).post("/api/uploads/profile-photo").set("Cookie",cookie(user));
  if (guarded) { const read = await request(app).get(`/api/users/me?expectedOwnerId=${user._id}`).set("Cookie",cookie(user)); expect(read.status).toBe(200); operation=operation.field("expectedOwnerId",String(user._id)).field("expectedPhotoRevision",read.body.profilePhotoRevision); }
  if (flag !== null) operation=operation.field("editExisting",flag);
  if (crop !== undefined) operation=operation.field("crop",typeof crop === "string" ? crop : JSON.stringify(crop));
  return operation.attach("file",image,{filename:"crop.png",contentType:"image/png"}).attach("original",image,{filename:"original.png",contentType:"image/png"});
}
async function assertHidden() {
  const directory=await request(app).get("/api/public/paralegals?limit=5"); expect(directory.status).toBe(200); expect(directory.body.items).toEqual([]);
  expect((await request(app).get(`/api/public/paralegals/${user._id}/photo`)).status).toBe(404);
}
async function assertRetainedPending(response) {
  expect(response.status).toBe(200); expect(response.body).toMatchObject({pending:true,status:"pending_review"});
  const current=await stored(user); expect(current.profileImageKey).toBe(oldKey); expect(current.profileImageOriginalKey).toBe(oldOriginal); expect(current.pendingProfileImageKey).not.toBe(oldKey); expect(current.profilePhotoStatus).toBe("pending_review");
  expect(await StorageDeletionTask.countDocuments({ownerId:user._id,key:{$in:[oldKey,oldOriginal]},status:{$in:["pending","held","processing"]}})).toBe(0);
  await assertHidden(); return current;
}
beforeAll(connect,90000);afterAll(closeDatabase);
beforeEach(async()=>{
  await clearDatabase(); mockSend.mockReset().mockImplementation(async command=>command.constructor.name === "GetObjectTaggingCommand" ? {TagSet:[{Key:"GuardDutyMalwareScanStatus",Value:"NO_THREATS_FOUND"}]} : command.constructor.name === "GetObjectCommand" ? {Body:Readable.from(image),ContentType:"image/png",ContentLength:image.length} : {});
  const id=new User()._id; oldKey=`profile-photos/${id}/profile-1700000000000.png`;oldOriginal=`profile-photos/${id}/original-1700000000000.png`;
  user=await User.create({_id:id,firstName:"Dana",lastName:"Young",role:"paralegal",status:"approved",email:"photo-guard@example.test",password:"Password123!",state:"NY",bio:"Experienced paralegal",skills:["Discovery"],practiceAreas:["Litigation"],resumeURL:`paralegal-resumes/${id}/resume.pdf`,profileImageKey:oldKey,profileImage:`/api/public/paralegals/${id}/photo`,avatarURL:`/api/public/paralegals/${id}/photo`,profileImageOriginalKey:oldOriginal,profileImageOriginal:`/api/users/profile-photo/${id}?variant=approved-original`,profilePhotoStatus:"approved",preferences:{hideProfile:false}});
  admin=await User.create({firstName:"Admin",lastName:"Reviewer",role:"admin",status:"approved",email:"photo-admin@example.test",password:"Password123!"});
});
test.each([["1",true],["true",false],["yes",true]])("client editExisting=%s cannot approve newly supplied paralegal bytes (guarded=%s)",async(flag,guarded)=>{await assertRetainedPending(await upload({flag,guarded}));});
test("recropping the authenticated original still requires review",async()=>{
  const original=await request(app).get(`/api/uploads/profile-photo/original?expectedOwnerId=${user._id}`).set("Cookie",cookie(user));expect(original.status).toBe(200);expect(original.body).toEqual(image);await assertRetainedPending(await upload());
});
test("recropping a pending replacement retains the approved asset and retires only superseded pending bytes",async()=>{
  const first=await assertRetainedPending(await upload({flag:null}));const second=await assertRetainedPending(await upload());expect(second.pendingProfileImageKey).not.toBe(first.pendingProfileImageKey);
  const tasks=await StorageDeletionTask.find({ownerId:user._id,status:"pending"}).lean();expect(tasks.map(task=>task.key).sort()).toEqual([first.pendingProfileImageKey,first.pendingProfileImageOriginalKey].sort());
});
test("existing admin approval publishes the pending replacement and retires old approved assets",async()=>{
  const pending=await assertRetainedPending(await upload()); const response=await request(app).post(`/api/admin/profile-photos/${user._id}/approve`).set("Cookie",cookie(admin)).send({});expect(response.status).toBe(200);
  const current=await stored(user);expect(current.profileImageKey).toBe(pending.pendingProfileImageKey);expect(current.pendingProfileImageKey).toBe("");expect(current.profilePhotoStatus).toBe("approved");expect(current.preferences.hideProfile).toBe(false);
  expect((await request(app).get("/api/public/paralegals?limit=5")).body.items.map(item=>item.id)).toContain(String(user._id));expect((await request(app).get(`/api/public/paralegals/${user._id}/photo`)).status).toBe(200);
  const tasks=await StorageDeletionTask.find({ownerId:user._id,status:"pending"}).lean();expect(tasks.map(task=>task.key).sort()).toEqual([oldKey,oldOriginal].sort());
});
test("existing admin rejection discards the replacement and restores approved-photo eligibility",async()=>{
  const pending=await assertRetainedPending(await upload());const response=await request(app).post(`/api/admin/profile-photos/${user._id}/reject`).set("Cookie",cookie(admin)).send({});expect(response.status).toBe(200);
  const current=await stored(user);expect(current).toMatchObject({profileImageKey:oldKey,profileImageOriginalKey:oldOriginal,pendingProfileImageKey:"",profilePhotoStatus:"approved"});expect((await request(app).get(`/api/public/paralegals/${user._id}/photo`)).status).toBe(200);
  const tasks=await StorageDeletionTask.find({ownerId:user._id,status:"pending"}).lean();expect(tasks.map(task=>task.key).sort()).toEqual([pending.pendingProfileImageKey,pending.pendingProfileImageOriginalKey].sort());
});
test("attorney upload retains its existing approved display and admin-review behavior",async()=>{
  await User.updateOne({_id:user._id},{$set:{role:"attorney"}});user=await User.findById(user._id);const result=await upload();expect(result.status).toBe(200);expect(result.body.pending).toBe(false);const current=await stored(user);expect(current.profilePhotoStatus).toBe("approved");expect(current.profileImageKey).toBe(current.pendingProfileImageKey);expect(current.profileImageKey).not.toBe(oldKey);
});

test("framing persists only on the original object and is returned only by the guarded original request", async()=>{
  const crop={v:1,x:.1,y:.2,width:.5,height:.5};
  await assertRetainedPending(await upload({crop}));
  const puts=mockSend.mock.calls.map(([command])=>command).filter(command=>command.constructor.name==='PutObjectCommand');
  expect(puts.filter(command=>command.input.Metadata?.['lpc-crop'])).toHaveLength(1);
  expect(JSON.parse(puts.find(command=>command.input.Metadata?.['lpc-crop']).input.Metadata['lpc-crop'])).toEqual(crop);
  mockSend.mockImplementation(async command=>command.constructor.name==='GetObjectTaggingCommand'?{TagSet:[{Key:'GuardDutyMalwareScanStatus',Value:'NO_THREATS_FOUND'}]}:command.constructor.name==='GetObjectCommand'?{Body:Readable.from(image),ContentType:'image/png',ContentLength:image.length,Metadata:{'lpc-crop':JSON.stringify(crop)}}:{});
  const current=await request(app).get(`/api/users/me?expectedOwnerId=${user._id}`).set('Cookie',cookie(user));
  const original=await request(app).get(`/api/uploads/profile-photo/original?expectedOwnerId=${user._id}&expectedPhotoRevision=${current.body.profilePhotoRevision}`).set('Cookie',cookie(user));
  expect(original.status).toBe(200);expect(JSON.parse(original.headers['x-lpc-photo-crop'])).toEqual(crop);
  expect((await request(app).get(`/api/uploads/profile-photo/original?expectedOwnerId=${admin._id}`).set('Cookie',cookie(user))).status).toBe(403);
  expect((await request(app).get(`/api/uploads/profile-photo/original?expectedOwnerId=${user._id}&expectedPhotoRevision=${'f'.repeat(64)}`).set('Cookie',cookie(user))).status).toBe(409);
  const display=await request(app).get(`/api/users/profile-photo/${user._id}?variant=pending-original`).set('Cookie',cookie(user));
  expect(display.status).toBe(200);expect(display.headers['x-lpc-photo-crop']).toBeUndefined();
});
test.each(['bad-json',JSON.stringify({v:1,x:-.1,y:0,width:.5,height:.5}),JSON.stringify({v:1,x:0,y:0,width:0,height:1}),JSON.stringify({v:1,x:.9,y:0,width:.5,height:1}),JSON.stringify({v:1,x:0,y:0,width:1,height:1,extra:'ignored'})])('invalid crop metadata is rejected before storage: %s',async crop=>{
  const response=await upload({crop});expect(response.status).toBe(400);expect(response.body.code).toBe('INVALID_PHOTO_CROP');
  expect(mockSend.mock.calls.some(([command])=>command.constructor.name==='PutObjectCommand')).toBe(false);
});

async function cropStored({crop={v:1,x:0,y:0,width:1,height:1},revision,owner=String(user._id)}={}) {
 const read=await request(app).get(`/api/users/me?expectedOwnerId=${user._id}`).set('Cookie',cookie(user));
 return request(app).post('/api/uploads/profile-photo/crop').set('Cookie',cookie(user)).send({expectedOwnerId:owner,expectedPhotoRevision:revision || read.body.profilePhotoRevision,crop});
}
async function useStoredPhoto() {
 const bytes=await require('sharp')({create:{width:100,height:100,channels:3,background:'#4d70a8'}}).png().toBuffer();
 mockSend.mockImplementation(async command=>command.constructor.name==='GetObjectTaggingCommand'?{TagSet:[{Key:'GuardDutyMalwareScanStatus',Value:'NO_THREATS_FOUND'}]}:command.constructor.name==='GetObjectCommand'?{Body:Readable.from(bytes),ContentType:'image/png',ContentLength:bytes.length}:{});
 return bytes;
}
test('stored crop preserves approval and visibility without review email',async()=>{
 const original=await useStoredPhoto();const email=require('../utils/email');email.mockClear();
 const result=await cropStored();expect(result.status).toBe(200);expect(result.body).toMatchObject({status:'approved',pending:false});
 const current=await stored(user);expect(current.profileImageKey).not.toBe(oldKey);expect(current.pendingProfileImageKey || '').toBe('');expect(current.profilePhotoStatus).toBe('approved');
 expect((await request(app).get('/api/public/paralegals?limit=5')).body.items.map(item=>item.id)).toContain(String(user._id));expect(email).not.toHaveBeenCalled();
 const puts=mockSend.mock.calls.map(([c])=>c).filter(c=>c.constructor.name==='PutObjectCommand');
 expect(puts.find(c=>c.input.Metadata).input.Body).toEqual(original);
 expect(await require('sharp')(puts.find(c=>!c.input.Metadata).input.Body).metadata()).toMatchObject({width:600,height:600,format:'jpeg'});
});
test('pending crop preserves pending review and approved original without duplicate email',async()=>{
 const pending=await assertRetainedPending(await upload({flag:null}));await useStoredPhoto();require('../utils/email').mockClear();
 const response=await cropStored();expect(response.status).toBe(200);expect(response.body).toMatchObject({pending:true,status:'pending_review'});
 const current=await stored(user);expect(current.profileImageKey).toBe(oldKey);expect(current.profileImageOriginalKey).toBe(oldOriginal);expect(current.pendingProfileImageKey).not.toBe(pending.pendingProfileImageKey);expect(require('../utils/email')).not.toHaveBeenCalled();await assertHidden();
});
test('crop refuses stale revision, other owner, unguarded request and malformed framing before writes',async()=>{
 await useStoredPhoto();expect((await cropStored({revision:'f'.repeat(64)})).status).toBe(409);expect((await cropStored({owner:String(admin._id)})).status).toBe(403);
 expect((await request(app).post('/api/uploads/profile-photo/crop').set('Cookie',cookie(user)).send({crop:{v:1,x:0,y:0,width:1,height:1}})).status).toBe(400);
 expect((await cropStored({crop:{v:1,x:0,y:0,width:2,height:1}})).status).toBe(400);
 expect(mockSend.mock.calls.some(([c])=>c.constructor.name==='PutObjectCommand')).toBe(false);
});
test('blocked stored original cannot be cropped',async()=>{
 await useStoredPhoto();mockSend.mockImplementation(async command=>command.constructor.name==='GetObjectTaggingCommand'?{TagSet:[{Key:'GuardDutyMalwareScanStatus',Value:'THREATS_FOUND'}]}:{});
 expect((await cropStored()).status).toBeGreaterThanOrEqual(400);expect(mockSend.mock.calls.some(([c])=>c.constructor.name==='PutObjectCommand')).toBe(false);
});

test('pending replacements keep one review and one admin email until a decision',async()=>{
 const email=require('../utils/email');email.mockClear();
 const first=await upload();expect(first.status).toBe(200);expect(first.body.replacedPendingPhoto).toBe(false);
 const firstKey=(await stored(user)).pendingProfileImageKey;
 const second=await upload();expect(second.status).toBe(200);expect(second.body.replacedPendingPhoto).toBe(true);
 const latest=await stored(user);expect(latest.pendingProfileImageKey).not.toBe(firstKey);
 const reviewEmails=()=>email.mock.calls.filter(([,subject])=>subject==='Profile photo review submitted');
 expect(reviewEmails()).toHaveLength(1);
 const queue=await request(app).get('/api/admin/profile-photos?status=pending_review').set('Cookie',cookie(admin));
 expect(queue.status).toBe(200);expect(queue.body.items.filter(item=>String(item.id||item._id)===String(user._id))).toHaveLength(1);
 const approval=await request(app).post(`/api/admin/profile-photos/${user._id}/approve`).set('Cookie',cookie(admin)).send({});expect(approval.status).toBe(200);
 expect((await stored(user)).profileImageKey).toBe(latest.pendingProfileImageKey);
 expect((await upload()).status).toBe(200);expect(reviewEmails()).toHaveLength(2);
 const rejection=await request(app).post(`/api/admin/profile-photos/${user._id}/reject`).set('Cookie',cookie(admin)).send({});expect(rejection.status).toBe(200);
 expect((await upload()).status).toBe(200);expect(reviewEmails()).toHaveLength(3);
});

test('overlapping initial uploads send only one admin review email',async()=>{
 const email=require('../utils/email');email.mockClear();
 let release;const barrier=new Promise(resolve=>release=resolve);let puts=0;
 mockSend.mockImplementation(async command=>{if(command.constructor.name==='PutObjectCommand'&&++puts<=2){if(puts===2)release();await barrier;}return {};});
 const results=await Promise.all([upload({guarded:false}),upload({guarded:false})]);
 expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 expect(email.mock.calls.filter(([,subject])=>subject==='Profile photo review submitted')).toHaveLength(1);
 expect((await stored(user)).profilePhotoStatus).toBe('pending_review');
});
