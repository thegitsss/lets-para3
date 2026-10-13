const {connect,clearDatabase,closeDatabase}=require('./helpers/db');
const mongoose=require('mongoose');
const Decision=require('../models/MatterRequirementDecision');
const {normalizeRequirements,assertRequirements}=require('../services/matterRequirements');
beforeAll(async()=>{await connect();await Decision.init();});beforeEach(clearDatabase);afterAll(closeDatabase);
test('requirements reject duplicate, blank and oversized values',()=>{
 expect(normalizeRequirements([' Clio proficiency ','Virginia litigation'])).toEqual(['Clio proficiency','Virginia litigation']);
 for(const value of [['same','SAME'],[' '],['\u0000'],['x'.repeat(201)],Array(13).fill('a'),'not-an-array'])expect(()=>normalizeRequirements(value)).toThrow();
});
test('all current requirements must be explicitly confirmed; stale or partial answers fail',async()=>{
 const job={_id:new mongoose.Types.ObjectId(),caseId:new mongoose.Types.ObjectId(),requirements:['Clio']},user=new mongoose.Types.ObjectId();
 for(const answers of [[],[{requirement:'Clio',meets:false}],[{requirement:'Old',meets:true}],[{requirement:'Clio',meets:'true'}]])await expect(assertRequirements(job,null,user,answers)).rejects.toMatchObject({status:400});
 await expect(assertRequirements(job,null,user,[{requirement:'Clio',meets:true}])).resolves.toEqual([{requirement:'Clio',meets:true}]);
 await expect(assertRequirements(job,{requirements:['Virginia']},user,[{requirement:'Clio',meets:true}])).rejects.toMatchObject({status:400});
});
test('confirmed no applies to only that user and Matter, including replacement postings',async()=>{
 const matter=new mongoose.Types.ObjectId(),user=new mongoose.Types.ObjectId();
 await Decision.create({matterKey:String(matter),paralegalId:user,requirements:['Clio']});
 for(let i=0;i<2;i++)await expect(assertRequirements({_id:new mongoose.Types.ObjectId(),caseId:matter,requirements:['Clio']},null,user,[{requirement:'Clio',meets:true}])).rejects.toMatchObject({status:403});
 await expect(assertRequirements({_id:new mongoose.Types.ObjectId(),caseId:matter,requirements:[]},null,new mongoose.Types.ObjectId(),[])).resolves.toEqual([]);
 await expect(assertRequirements({_id:new mongoose.Types.ObjectId(),caseId:new mongoose.Types.ObjectId(),requirements:[]},null,user,[])).resolves.toEqual([]);
});
test('decision uniqueness prevents competing requests creating duplicate exclusions',async()=>{
 const key={matterKey:String(new mongoose.Types.ObjectId()),paralegalId:new mongoose.Types.ObjectId()};
 const results=await Promise.allSettled([Decision.create({...key,requirements:['Clio']}),Decision.create({...key,requirements:['Clio']})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await Decision.countDocuments(key)).toBe(1);
});

const Case=require('../models/Case'),Job=require('../models/Job'),User=require('../models/User');
const {declineRequirements}=require('../services/matterRequirements');
async function fixture(){
 const [owner,para]=await User.create(['owner','para'].map(name=>({firstName:name,lastName:'Requirements',email:`${name}@requirements.test`,password:'Synthetic123!',role:name==='para'?'paralegal':'attorney',status:'approved'})));
 const matter=await Case.create({title:'Requirements matter',details:'Prepare a brief',attorney:owner._id,attorneyId:owner._id,status:'open',totalAmount:50000,requirements:['Clio'],tasks:[{title:'Prepare brief'}],invites:[{paralegalId:para._id,status:'pending'}]});
 const job=await Job.create({title:matter.title,practiceArea:'Civil Litigation',budget:500,attorneyId:owner._id,caseId:matter._id,status:'open',description:'Prepare brief',requirements:['Clio']});
 return {owner,para,matter,job};
}
test('cancel and stale confirmation cannot exclude a user; confirmed No is idempotent and removes the invitation',async()=>{
 const {para,matter,job}=await fixture();const options={jobId:job._id,userId:para._id,requirements:['Clio'],confirmed:true};
 await expect(declineRequirements({...options,confirmed:false})).rejects.toMatchObject({status:400});
 await expect(declineRequirements({...options,requirements:['Old']})).rejects.toMatchObject({status:409});
 expect(await Decision.countDocuments()).toBe(0);
 await expect(declineRequirements(options)).resolves.toEqual({ok:true,unavailable:true});
 await expect(declineRequirements(options)).resolves.toEqual({ok:true,unavailable:true});
 expect(await Decision.countDocuments()).toBe(1);
 expect(await require('../services/receivedInvitationInventory').metadata(String(para._id),[])).toEqual([]);
 await expect(assertRequirements(job,matter,para._id,[{requirement:'Clio',meets:true}])).rejects.toMatchObject({status:403});
});
test('invitation decisions require the invited account and do not change another person’s access',async()=>{
 const {owner,para,matter,job}=await fixture();
 await expect(declineRequirements({caseId:matter._id,userId:owner._id,requirements:['Clio'],confirmed:true})).rejects.toMatchObject({status:403});
 await expect(declineRequirements({caseId:matter._id,userId:para._id,requirements:['Clio'],confirmed:true})).resolves.toMatchObject({unavailable:true});
 await expect(assertRequirements(job,matter,owner._id,[{requirement:'Clio',meets:true}])).resolves.toHaveLength(1);
});
test('an existing application and a closed account prevent a new decision',async()=>{
 const {para,matter,job}=await fixture();
 await Case.updateOne({_id:matter._id},{$push:{applicants:{paralegalId:para._id,status:'pending'}}});
 await expect(declineRequirements({jobId:job._id,userId:para._id,requirements:['Clio'],confirmed:true})).rejects.toMatchObject({status:409});
 await User.updateOne({_id:para._id},{$set:{disabled:true}});
 await expect(declineRequirements({jobId:job._id,userId:para._id,requirements:['Clio'],confirmed:true})).rejects.toMatchObject({status:403});
 expect(await Decision.countDocuments()).toBe(0);
});


test('a confirmed unmet requirement prevents a new invitation as well as an application',async()=>{
 const {para,owner,matter,job}=await fixture();
 await declineRequirements({jobId:job._id,userId:para._id,requirements:['Clio'],confirmed:true});
 await expect(require('../services/invitationService').sendInvitation({caseDoc:matter,paralegalId:para._id,actorId:owner._id})).resolves.toMatchObject({sent:false,reason:'profile_unavailable'});
});
