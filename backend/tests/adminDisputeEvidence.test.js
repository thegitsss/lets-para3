const mongoose=require('mongoose');
jest.mock('../utils/s3Client',()=>({createS3Client:jest.fn(()=>({send:jest.fn(async()=>({VersionId:'synthetic-version'}))}))}));
jest.mock('@aws-sdk/s3-request-presigner',()=>({getSignedUrl:jest.fn(async()=> 'https://synthetic.invalid/protected')}));
jest.mock('../utils/fileSecurity',()=>({assertObjectMalwareSafe:jest.fn(async()=>({safe:true}))}));
const User=require('../models/User'),Case=require('../models/Case'),Message=require('../models/Message'),CaseFile=require('../models/CaseFile'),Audit=require('../models/AuditLog');
const {read}=require('../services/adminDisputeEvidence');
const {connect,clearDatabase,closeDatabase}=require('./helpers/db');
const scan=require('../utils/fileSecurity').assertObjectMalwareSafe,sign=require('@aws-sdk/s3-request-presigner').getSignedUrl;
let admin,owner,para,matter,file,req,disputeId;
beforeAll(connect);afterAll(closeDatabase);afterEach(()=>jest.restoreAllMocks());
beforeEach(async()=>{
 await clearDatabase();scan.mockReset().mockResolvedValue({safe:true});sign.mockClear();process.env.S3_BUCKET='synthetic-review';
 [admin,owner,para]=await User.create(['admin','attorney','paralegal'].map(role=>({firstName:'Synthetic',lastName:role,email:`${role}@review.invalid`,password:'SyntheticPassword123!',role,status:'approved'})));
 disputeId=new mongoose.Types.ObjectId().toString();matter=await Case.create({title:'Evidence review',details:'Synthetic',attorney:owner._id,paralegal:para._id,status:'disputed',pausedReason:'dispute',hiredAt:new Date(Date.now()-60000),disputes:[{disputeId,message:'Review needed',raisedBy:owner._id,status:'open'}]});
 file=await CaseFile.create({caseId:matter._id,userId:para._id,originalName:'Confidential.pdf',storageKey:`cases/${matter._id}/documents/scan-required-synthetic.pdf`,mimeType:'application/pdf'});
 await Message.create({caseId:matter._id,senderId:owner._id,senderRole:'attorney',text:'CONFIDENTIAL_REVIEW_BODY'});
 req={user:{id:String(admin._id),role:'admin'},params:{caseId:String(matter._id),disputeId},body:{reason:'Review the disputed submission for the current work-quality decision.',action:'files'},headers:{},method:'POST',originalUrl:'/api/disputes/synthetic/evidence'};
});
test('explicit justified current-dispute reads are logged and omit storage references and private intent',async()=>{
 const files=await read(req);expect(files.files).toMatchObject([{id:String(file._id),name:'Confidential.pdf'}]);expect(JSON.stringify(files)).not.toMatch(/storageKey|scan-required|enc:v1/);
 expect(await Audit.countDocuments({action:'dispute.evidence.read'})).toBe(1);
 const messages=await read({...req,body:{...req.body,action:'messages'}});expect(messages.messages[0].text).toBe('CONFIDENTIAL_REVIEW_BODY');expect(JSON.stringify(messages)).not.toMatch(/notificationIntent|senderId|content/);
 expect(await Audit.countDocuments({action:'dispute.evidence.read'})).toBe(2);
});
test.each(['attorney','missing_reason','resolved','wrong_dispute','disabled_admin','expired_retention'])('evidence is denied for %s',async change=>{
 if(change==='attorney')req.user={id:String(owner._id),role:'attorney'};
 if(change==='missing_reason')req.body.reason='';
 if(change==='resolved')await Case.updateOne({_id:matter._id},{$set:{'disputes.0.status':'resolved'}});
 if(change==='wrong_dispute')req.params.disputeId=new mongoose.Types.ObjectId().toString();
 if(change==='disabled_admin')await User.updateOne({_id:admin._id},{$set:{disabled:true}});
 if(change==='expired_retention')await Case.updateOne({_id:matter._id},{$set:{purgeScheduledFor:new Date(0)}});
 await expect(read(req)).rejects.toBeDefined();expect(sign).not.toHaveBeenCalled();expect(await Audit.countDocuments()).toBe(0);
});
test('failure to retain the justification suppresses confidential reads and links',async()=>{
 jest.spyOn(Audit,'logFromReq').mockRejectedValue(new Error('Synthetic audit failure'));
 await expect(read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).rejects.toThrow('Synthetic audit failure');expect(sign).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();
});
test('a single selected document is scanned and receives a 60-second attachment URL',async()=>{
 const value=await read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}});expect(value).toEqual({url:'https://synthetic.invalid/protected',expiresIn:60});
 expect(scan).toHaveBeenCalledWith(expect.objectContaining({key:`cases/${matter._id}/documents/scan-required-synthetic.pdf`,versionId:'synthetic-version'}));
 expect(sign.mock.calls[0][1].input).toMatchObject({ResponseContentDisposition:'attachment',ResponseContentType:'application/octet-stream',VersionId:'synthetic-version'});expect(sign.mock.calls[0][2]).toEqual({expiresIn:60});
});
test.each(['pending','blocked','error'])('a %s scan does not issue a bearer URL',async status=>{
 scan.mockRejectedValue(Object.assign(new Error('Unsafe synthetic object'),{statusCode:status==='pending'?423:status==='blocked'?422:503}));
 await expect(read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).rejects.toBeDefined();expect(sign).not.toHaveBeenCalled();
});
test('another Matter or a prior assignment document cannot be selected',async()=>{
 const another=new mongoose.Types.ObjectId();await CaseFile.updateOne({_id:file._id},{$set:{caseId:another}});
 await expect(read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).rejects.toMatchObject({status:404});expect(sign).not.toHaveBeenCalled();
});
test('a resolution racing with the scan prevents issuing the link',async()=>{
 scan.mockImplementation(async()=>{await Case.updateOne({_id:matter._id},{$set:{'disputes.0.status':'resolved'}});return {safe:true};});
 await expect(read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).rejects.toMatchObject({status:409});expect(sign).not.toHaveBeenCalled();
});

test('a document replaced during scanning never receives the earlier bearer URL',async()=>{
 scan.mockImplementationOnce(async()=>{await CaseFile.updateOne({_id:file._id},{$set:{storageKey:`cases/${matter._id}/documents/changed.pdf`}});return {safe:true};});
 await expect(read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).rejects.toMatchObject({status:409,publicCode:'EVIDENCE_SOURCE_CHANGED'});
 expect(sign).not.toHaveBeenCalled();
});


test.each([null, 'invalid', 'future'])('an unverified %s assignment date denies confidential reads before audit or signing', async value => {
  await Case.collection.updateOne({_id:matter._id}, value === null ? {$unset:{hiredAt:''}} : {$set:{hiredAt:value === 'future' ? new Date(Date.now()+86400000) : value}});
  for (const action of ['files','messages','preview']) await expect(read({...req,body:{...req.body,action,fileId:String(file._id)}})).rejects.toMatchObject({status:409,publicCode:'EVIDENCE_ASSIGNMENT_UNVERIFIED'});
  expect(await Audit.countDocuments()).toBe(0);expect(sign).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();
});
test('a retained string case reference remains exactly scoped and scan-gated', async () => {
  await CaseFile.collection.updateOne({_id:file._id},{$set:{caseId:String(matter._id)}});
  expect((await read(req)).files).toMatchObject([{id:String(file._id),name:'Confidential.pdf'}]);
  expect(await read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).toEqual({url:'https://synthetic.invalid/protected',expiresIn:60});
  await CaseFile.collection.updateOne({_id:file._id},{$set:{caseId:new mongoose.Types.ObjectId().toString()}});
  await expect(read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).rejects.toMatchObject({status:404});expect(sign).toHaveBeenCalledTimes(1);
});
test('prior-assignment files and messages stay outside the current dispute review', async () => {
  const earlier=new Date(matter.hiredAt.getTime()-1);
  await CaseFile.collection.updateOne({_id:file._id},{$set:{createdAt:earlier}});
  await Message.collection.updateMany({caseId:matter._id},{$set:{createdAt:earlier}});
  expect((await read(req)).files).toEqual([]);expect((await read({...req,body:{...req.body,action:'messages'}})).messages).toEqual([]);
  await expect(read({...req,body:{...req.body,action:'preview',fileId:String(file._id)}})).rejects.toMatchObject({status:404});expect(sign).not.toHaveBeenCalled();
});
