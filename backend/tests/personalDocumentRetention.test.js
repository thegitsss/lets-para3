const mongoose=require('mongoose');
const User=require('../models/User'),Application=require('../models/Application'),Case=require('../models/Case'),StorageDeletionTask=require('../models/StorageDeletionTask');
const {stagePersonalStorageDeletion,activatePersonalStorageDeletion,processPersonalStorageDeletionTasks}=require('../services/personalStorageDeletion');
const {connect,clearDatabase,closeDatabase}=require('./helpers/db');
const env={S3_BUCKET:'document-retention-test',S3_REGION:'us-east-1'};
beforeAll(connect,90000);afterAll(closeDatabase);beforeEach(clearDatabase);
test.each(['application','legacy-case'])('cleanup retains an older résumé recorded in %s evidence',async kind=>{
 const owner=await User.create({firstName:'Dana',lastName:'Young',email:'retained-document@example.test',password:'Password123!',role:'paralegal',status:'approved'});
 const key=`paralegal-resumes/${owner._id}/resume-1700000000000.pdf`,next=`paralegal-resumes/${owner._id}/resume-1700000000001.pdf`;
 await User.updateOne({_id:owner._id},{$set:{resumeURL:next}});
 if(kind==='application')await Application.collection.insertOne({_id:new mongoose.Types.ObjectId(),paralegalId:owner._id,jobId:new mongoose.Types.ObjectId(),resumeURL:key,status:'withdrawn'});
 else await Case.collection.insertOne({_id:new mongoose.Types.ObjectId(),attorneyId:new mongoose.Types.ObjectId(),status:'completed',applicants:[{paralegalId:owner._id,resumeURL:`https://document-retention-test.s3.us-east-1.amazonaws.com/${key}`,status:'rejected'}]});
 const ids=await stagePersonalStorageDeletion({ownerId:owner._id,keys:[key],reason:'resume_replaced'},{env});await activatePersonalStorageDeletion(ids);
 const s3={send:jest.fn(async()=>({}))};const result=await processPersonalStorageDeletionTasks({}, {env,s3});expect(s3.send).not.toHaveBeenCalled();expect(result.deleted).toBe(0);expect((await StorageDeletionTask.findById(ids[0])).status).toBe('cancelled');
});

test('a reference recorded between held recovery and deletion claim is retained',async()=>{
 const owner=await User.create({firstName:'Dana',lastName:'Young',email:'race-document@example.test',password:'Password123!',role:'paralegal',status:'approved'}),key=`paralegal-resumes/${owner._id}/race.pdf`;
 const ids=await stagePersonalStorageDeletion({ownerId:owner._id,keys:[key],reason:'resume_replaced'},{env});await activatePersonalStorageDeletion(ids);
 const claim=StorageDeletionTask.findOneAndUpdate.bind(StorageDeletionTask);jest.spyOn(StorageDeletionTask,'findOneAndUpdate').mockImplementationOnce(async(...args)=>{await Application.collection.insertOne({paralegalId:owner._id,jobId:new mongoose.Types.ObjectId(),resumeURL:key});return claim(...args);});
 const s3={send:jest.fn(async()=>({}))};expect((await processPersonalStorageDeletionTasks({}, {env,s3})).deleted).toBe(0);expect(s3.send).not.toHaveBeenCalled();jest.restoreAllMocks();
});
test('failed retention query retries without deleting or treating unknown references as absent',async()=>{
 const owner=await User.create({firstName:'Dana',lastName:'Young',email:'query-document@example.test',password:'Password123!',role:'paralegal',status:'approved'}),key=`paralegal-resumes/${owner._id}/query.pdf`;
 const ids=await stagePersonalStorageDeletion({ownerId:owner._id,keys:[key],reason:'resume_replaced'},{env});await activatePersonalStorageDeletion(ids);
 jest.spyOn(Application.collection,'find').mockImplementationOnce(()=>{throw Object.assign(new Error('Synthetic reference query unavailable'),{name:'MongoNetworkError'});});const s3={send:jest.fn(async()=>({}))};expect((await processPersonalStorageDeletionTasks({}, {env,s3})).retried).toBe(1);expect(s3.send).not.toHaveBeenCalled();jest.restoreAllMocks();
});
test('wrong-owner and untrusted URL records do not retain an unreferenced object',async()=>{
 const owner=await User.create({firstName:'Dana',lastName:'Young',email:'unreferenced-document@example.test',password:'Password123!',role:'paralegal',status:'approved'}),key=`paralegal-resumes/${owner._id}/unreferenced.pdf`;
 await Application.collection.insertMany([{paralegalId:new mongoose.Types.ObjectId(),resumeURL:key},{paralegalId:owner._id,resumeURL:`https://untrusted.test/${key}`}]);
 const ids=await stagePersonalStorageDeletion({ownerId:owner._id,keys:[key],reason:'resume_replaced'},{env});await activatePersonalStorageDeletion(ids);const s3={send:jest.fn(async()=>({}))};expect((await processPersonalStorageDeletionTasks({}, {env,s3})).deleted).toBe(1);expect(s3.send).toHaveBeenCalledTimes(1);
});
