const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { spawn } = require("node:child_process");
const request = require("supertest"), mongoose = require("mongoose");
process.env.S3_BUCKET = "synthetic-admission-recovery";
process.env.S3_REGION = "us-east-1";
const mockSend = jest.fn();
jest.mock("@aws-sdk/client-s3", () => ({ ...jest.requireActual("@aws-sdk/client-s3"), S3Client: jest.fn(() => ({ send: mockSend })) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ disabled: true })));
const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const User = require("../models/User"), Task = require("../models/StorageDeletionTask"), AuditLog = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { readReadyState } = require("./helpers/mongoHarnessState");
const { processPersonalStorageDeletionTasks } = require("../services/personalStorageDeletion");
const { currentPolicyMetadata } = require("../utils/legalDocuments");
const app = require("./helpers/testApp").buildTestApp();
const resumePath = path.join(__dirname, "playwright/paralegal-support/fixtures/paralegal-valid.pdf");
const certificatePath = path.join(__dirname, "playwright/paralegal-support/fixtures/paralegal-valid-replacement.pdf");
const resume = fs.readFileSync(resumePath), certificate = fs.readFileSync(certificatePath);
const objects = new Map(); let beforePut, afterPut, puts;
const env = { S3_BUCKET: process.env.S3_BUCKET, S3_REGION: process.env.S3_REGION };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function payload(overrides = {}) {
  const policy = currentPolicyMetadata();
  return { firstName: "Morgan", lastName: "Taylor", email: `admission.${new mongoose.Types.ObjectId()}@example.test`, password: "A unique admission recovery passphrase", role: "paralegal", state: "CA", timezone: "America/Los_Angeles", yearsExperience: "3", paralegalQualification: "certificate", termsAccepted: "true", privacyAcknowledged: "true", termsHash: policy.terms.hash, privacyHash: policy.privacy.hash, ...overrides };
}
function register(body = payload()) {
  let operation = request(app).post("/api/auth/register");
  for (const [key, value] of Object.entries(body)) operation = operation.field(key, String(value));
  return operation.attach("resumeFile", resume, { filename: "resume.pdf", contentType: "application/pdf" }).attach("certificateFile", certificate, { filename: "certificate.pdf", contentType: "application/pdf" });
}
async function reservations() { return Task.find({ reason: "registration_upload_recovery" }).sort({ key: 1 }).lean(); }
async function recoveryNow() { const tasks = await reservations(); expect(tasks).toHaveLength(2); return new Date(Math.max(...tasks.map(t => t.eligibleAt.getTime())) + 1); }
async function processAt(now) {
  const send = jest.fn(async command => { expect(command).toBeInstanceOf(DeleteObjectCommand); expect(command.input.Bucket).toBe(env.S3_BUCKET); objects.delete(command.input.Key); return {}; });
  const result = await processPersonalStorageDeletionTasks({ now, limit: 4 }, { env, s3: { send } }); return { result, send };
}
async function recoverOrphans() {
  const tasks = await reservations(); expect(tasks).toHaveLength(2); expect(tasks.every(t => t.status === "held")).toBe(true);
  expect(await User.countDocuments()).toBe(0);
  expect(mockSend.mock.calls.some(([c]) => c instanceof DeleteObjectCommand)).toBe(false);
  const { result, send } = await processAt(await recoveryNow()); expect(result.deleted).toBe(2); expect(send).toHaveBeenCalledTimes(2); expect(objects.size).toBe(0);
  const keys = tasks.map(t => t.key).sort(); expect(send.mock.calls.map(([c]) => c.input.Key).sort()).toEqual(keys);
  expect((await reservations()).every(t => t.status === "deleted")).toBe(true);
}
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); objects.clear(); beforePut = null; afterPut = null; puts = 0;
  mockSend.mockImplementation(async (command, options) => {
    expect(command).toBeInstanceOf(PutObjectCommand); puts++;
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal); expect(options.abortSignal.aborted).toBe(false);
    const tasks = await reservations(); expect(tasks).toHaveLength(2); expect(tasks.every(t => t.status === "held")).toBe(true);
    expect(tasks.some(t => t.key === command.input.Key && String(t.ownerId) === command.input.Key.split("/")[1])).toBe(true);
    await beforePut?.(command, puts); objects.set(command.input.Key, Buffer.from(command.input.Body)); await afterPut?.(command, puts); return {};
  });
});
afterEach(() => jest.restoreAllMocks());

test("first acknowledged PUT followed by rejected certificate PUT leaves durable recovery for both server-owned keys", async () => {
  const stage = jest.spyOn(Task, "findOneAndUpdate");
  beforePut = async (_command, ordinal) => { if (ordinal === 2) throw new Error("Controlled second PUT rejection"); };
  expect((await register()).status).toBe(500); expect(puts).toBe(2); expect(objects.size).toBe(1);
  expect(stage.mock.calls.slice(0, 2).every(([, , options]) => options.writeConcern?.w === "majority" && options.writeConcern.j === true && options.writeConcern.wtimeout === 10000)).toBe(true); await recoverOrphans();
});

test("a provider PUT stored before its acknowledgement is lost is not replayed or immediately deleted", async () => {
  afterPut = async (_command, ordinal) => { if (ordinal === 1) throw Object.assign(new Error("Controlled lost PUT acknowledgement"), { name: "TimeoutError" }); };
  expect((await register()).status).toBe(500); expect(puts).toBe(1); expect(objects.size).toBe(1); await recoverOrphans();
});

test("save failure retains both uploaded objects under durable held recovery", async () => {
  jest.spyOn(User.prototype, "save").mockRejectedValueOnce(new Error("Controlled metadata save rejection"));
  expect((await register()).status).toBe(500); expect(puts).toBe(2); expect(objects.size).toBe(2); await recoverOrphans();
});

test("lost User insert acknowledgement before commit aborts account and preserves uncancelled tasks", async () => {
  const save = User.prototype.save;
  jest.spyOn(User.prototype, "save").mockImplementationOnce(async function (...args) { await Reflect.apply(save, this, args); throw new Error("Controlled uncommitted insert acknowledgement loss"); });
  expect((await register()).status).toBe(500); expect(objects.size).toBe(2); await recoverOrphans();
});

test("successful registration atomically stores exact document references and cancels its reservations", async () => {
  const body = payload(), response = await register(body); expect(response.status).toBe(200); expect(response.body).toMatchObject({ emailVerified: false, verificationEmailStatus: "not_sent" });
  const user = await User.findOne({ email: body.email }).lean(), tasks = await reservations(); expect(user.status).toBe("pending"); expect(user.termsDocumentHash).toBe(body.termsHash); expect(user.privacyDocumentHash).toBe(body.privacyHash); expect(tasks).toHaveLength(2); expect(tasks.every(t => t.status === "cancelled")).toBe(true);
  expect(objects.get(user.resumeURL)).toEqual(resume); expect(objects.get(user.certificateURL)).toEqual(certificate); expect(await AuditLog.countDocuments({ action: "auth.register", targetId: String(user._id) })).toBe(1);
  // Even an abandoned reservation presented again must not delete live bytes.
  await Task.updateMany({ _id: { $in: tasks.map(t => t._id) } }, { $set: { status: "held", eligibleAt: new Date(0) } });
  const { result, send } = await processAt(new Date()); expect(result.cancelled).toBe(2); expect(result.deleted).toBe(0); expect(send).not.toHaveBeenCalled(); expect(objects.size).toBe(2);
});

test("actual committed transaction with lost acknowledgement reconciles exact account and cancelled tasks without provider replay", async () => {
  const start = mongoose.startSession.bind(mongoose); let commits = 0;
  jest.spyOn(mongoose, "startSession").mockImplementationOnce(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { commits++; await commit(); throw Object.assign(new Error("Controlled post-commit acknowledgement loss"), { errorLabels: ["UnknownTransactionCommitResult"] }); }; return session; });
  const body = payload(), response = await register(body); expect(response.status).toBe(200); expect(commits).toBe(1); expect(puts).toBe(2); expect(await User.countDocuments({ email: body.email })).toBe(1); expect((await reservations()).every(t => t.status === "cancelled")).toBe(true); expect(mockSend.mock.calls.some(([c]) => c instanceof DeleteObjectCommand)).toBe(false);
});

test("expired held reservation cannot attach uploaded bytes even before worker claims it", async () => {
  afterPut = async (_command, ordinal) => { if (ordinal === 2) await Task.updateMany({ reason: "registration_upload_recovery" }, { $set: { eligibleAt: new Date(Date.now() - 1) } }); };
  expect((await register()).status).toBe(500); expect(puts).toBe(2); await recoverOrphans();
});

test("a cleanup claim winning after snapshot read aborts account attachment instead of cancelling a newer task state", async () => {
  const save = User.prototype.save;
  jest.spyOn(User.prototype, "save").mockImplementationOnce(async function (...args) {
    await Reflect.apply(save, this, args);
    // Outside the registration session, this is the same Task write fence used
    // by the existing worker; its complete deletion behavior is checked below.
    await Task.updateMany({ reason: "registration_upload_recovery", status: "held" }, { $set: { status: "pending", eligibleAt: new Date() } });
    return this;
  });
  expect((await register()).status).toBe(500); expect(await User.countDocuments()).toBe(0); expect((await reservations()).every(t => t.status === "pending")).toBe(true);
  const { result, send } = await processAt(new Date()); expect(result.deleted).toBe(2); expect(send).toHaveBeenCalledTimes(2); expect(objects.size).toBe(0);
});

test("changed reservation owner or prefix denies attachment and worker never deletes the foreign key", async () => {
  const foreign = new mongoose.Types.ObjectId();
  afterPut = async (_command, ordinal) => { if (ordinal === 2) { const task = (await reservations())[0]; await Task.updateOne({ _id: task._id }, { $set: { key: `paralegal-resumes/${foreign}/scan-required-resume.pdf`, eligibleAt: new Date(0) } }); } };
  expect((await register()).status).toBe(500); expect(await User.countDocuments()).toBe(0);
  const { result, send } = await processAt(await recoveryNow()); expect(result.blocked).toBe(1); expect(send.mock.calls.every(([c]) => !c.input.Key.includes(String(foreign)))).toBe(true); expect((await reservations()).some(t => t.status === "blocked")).toBe(true);
});

test("incomplete durable reservation creation stops before any provider upload", async () => {
  const update = Task.findOneAndUpdate.bind(Task); let calls = 0;
  jest.spyOn(Task, "findOneAndUpdate").mockImplementation((...args) => { calls++; return calls === 2 ? Promise.reject(new Error("Controlled reservation storage failure")) : update(...args); });
  expect((await register()).status).toBe(500); expect(puts).toBe(0); expect(objects.size).toBe(0); expect(await User.countDocuments()).toBe(0); expect(await Task.countDocuments({ status: "held" })).toBe(1);
});

test("actual producer process death after first PUT leaves server-owned held records recoverable by a fresh worker", async () => {
  const root = path.resolve(__dirname, ".."), state = readReadyState();
  const script = `
    const fs=require('fs'),Module=require('module'),mongoose=require('mongoose');
    const original=Module._load;let put=0,listener;
    Module._load=function(name,parent,main){
      if(name==='@aws-sdk/client-s3'){const sdk=Reflect.apply(original,this,arguments);return{...sdk,S3Client:class{async send(command){if(command.constructor.name!=='PutObjectCommand')throw Error('Only fake PUT admitted');put++;if(put===2){const Task=require(process.cwd()+'/models/StorageDeletionTask');const tasks=await Task.find({reason:'registration_upload_recovery'}).lean();process.stdout.write(JSON.stringify({kind:'ACTUAL_PRODUCER_INTERRUPTION',pid:process.pid,port:listener?.address()?.port,putsAcknowledged:1,tasks:tasks.map(t=>({id:String(t._id),key:t.key,status:t.status,ownerId:String(t.ownerId)}))})+'\\n',()=>process.kill(process.pid,'SIGKILL'));return new Promise(()=>{});}return{};}}};}
      if(name==='../utils/email'||name==='./email')return Object.assign(async()=>({disabled:true}),{});
      return Reflect.apply(original,this,arguments);
    };
    (async()=>{await mongoose.connect(process.argv[1],{dbName:'jest',autoIndex:false,autoCreate:false,maxPoolSize:2,serverSelectionTimeoutMS:5000,socketTimeoutMS:10000});require('./tests/helpers/supertestLoopback').isolateSupertestLoopback();const app=require('./tests/helpers/testApp').buildTestApp(),policy=require('./utils/legalDocuments').currentPolicyMetadata();let r=require('supertest')(app).post('/api/auth/register');listener=r._server;const body={firstName:'Morgan',lastName:'Taylor',email:'interrupted.'+new mongoose.Types.ObjectId()+'@example.test',password:'A unique interrupted admission passphrase',role:'paralegal',state:'CA',yearsExperience:'3',paralegalQualification:'certificate',termsAccepted:'true',privacyAcknowledged:'true',termsHash:policy.terms.hash,privacyHash:policy.privacy.hash};for(const[k,v]of Object.entries(body))r=r.field(k,v);await r.attach('resumeFile',fs.readFileSync(process.argv[2]),{filename:'resume.pdf',contentType:'application/pdf'}).attach('certificateFile',fs.readFileSync(process.argv[3]),{filename:'certificate.pdf',contentType:'application/pdf'});throw Error('Crash control did not terminate');})().catch(e=>{console.error(e.name,e.message);process.exit(2);});
  `;
  const child = spawn(process.execPath, ["-e", script, state.uri, resumePath, certificatePath], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: "test", S3_BUCKET: env.S3_BUCKET, S3_REGION: env.S3_REGION, JWT_SECRET: process.env.JWT_SECRET, DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY, EMAIL_DISABLE: "true", ENABLE_CSRF: "false", APP_BASE_URL: "http://127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const outcome = await new Promise(resolve => { const timer = setTimeout(() => child.kill("SIGKILL"), 10000); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
  const observation = stdout.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row?.kind === "ACTUAL_PRODUCER_INTERRUPTION");
  expect({ outcome, observation, stderr }).toMatchObject({ outcome: { code: null, signal: "SIGKILL" }, observation: { putsAcknowledged: 1, pid: child.pid } }); expect(Number.isInteger(observation.port)).toBe(true);
  const listenerClosed = await new Promise(resolve => { const socket = require("node:net").connect({ host: "127.0.0.1", port: observation.port }); socket.on("connect", () => { socket.destroy(); resolve(false); }); socket.on("error", error => resolve(error.code === "ECONNREFUSED")); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); }); expect(listenerClosed).toBe(true);
  if (process.env.LPC_ADMISSION_EVIDENCE) fs.writeFileSync(path.join(process.env.LPC_ADMISSION_EVIDENCE, "intentional-producer-crash.json"), JSON.stringify({ outcome, observation, listenerClosed, noActualProvider: true }, null, 2));
  expect(observation.tasks).toHaveLength(2); expect(observation.tasks.every(t => t.status === "held")).toBe(true); expect(await User.countDocuments()).toBe(0);
  const { result, send } = await processAt(await recoveryNow()); expect(result.deleted).toBe(2); expect(send.mock.calls.map(([c]) => c.input.Key).sort()).toEqual(observation.tasks.map(t => t.key).sort());
});

test("a changed post-commit reservation cannot be mistaken for an exact recovered signup outcome", async () => {
  const start = mongoose.startSession.bind(mongoose);
  jest.spyOn(mongoose, "startSession").mockImplementationOnce(async () => { const session = await start(), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); const task = (await reservations())[0]; await Task.updateOne({ _id: task._id }, { $set: { reason: "changed_after_commit", key: task.key + ".changed" } }); throw new Error("Controlled changed post-commit source"); }; return session; });
  const body = payload(), response = await register(body); expect(response.status).toBe(500); const user = await User.findOne({ email: body.email }).lean(); expect(user).not.toBeNull(); expect(objects.get(user.resumeURL)).toEqual(resume); expect(objects.get(user.certificateURL)).toEqual(certificate); expect(mockSend.mock.calls.some(([c]) => c instanceof DeleteObjectCommand)).toBe(false);
});
