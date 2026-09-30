const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { Readable } = require("stream");
const fs = require("fs");
const path = require("path");
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
const image = fs.readFileSync(path.resolve(__dirname,"fixtures/photo-gradient.png"));
const cookie = user => `token=${jwt.sign({id:String(user._id),role:user.role,status:user.status,email:user.email},process.env.JWT_SECRET,{expiresIn:"1h"})}`;
const stored = user => User.findById(user._id).select("+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey").lean();
let user, admin, oldKey, oldOriginal;
async function upload({flag="1",guarded=true}={}) {
  let operation = request(app).post("/api/uploads/profile-photo").set("Cookie",cookie(user));
  if (guarded) { const read = await request(app).get(`/api/users/me?expectedOwnerId=${user._id}`).set("Cookie",cookie(user)); expect(read.status).toBe(200); operation=operation.field("expectedOwnerId",String(user._id)).field("expectedPhotoRevision",read.body.profilePhotoRevision); }
  if (flag !== null) operation=operation.field("editExisting",flag);
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
