const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User');
const Preference = require('../models/AutonomyPreference');
const AuditLog = require('../models/AuditLog');
const { parseAdminPause, pauseAdminApprovals, readAdminAutomation } = require('../services/adminAssistantService');
let admin;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); admin = await User.create({firstName:'Admin',lastName:'Test',email:'admin-actions@example.test',password:'Synthetic password',role:'admin',status:'approved'}); });
afterEach(() => jest.restoreAllMocks());
async function transaction(work) {const session=await mongoose.startSession();try{return await session.withTransaction(()=>work(session));}finally{await session.endSession();}}
test.each(['Do not pause marketing approvals','How do I pause marketing approvals?','A user said pause marketing approvals','Pause all automation','Resume marketing approvals','Pause marketing approvals and publish the draft'])('no action from ambiguous or embedded wording: %s', text => {expect(parseAdminPause(text)).toBeNull();});
test('pausing all covers only the three supported draft approval categories', async () => {
 await Preference.create([{agentRole:'CCO',actionType:'support_governed_content_approval',mode:'auto'},{agentRole:'CMO',actionType:'marketing_publish',mode:'auto'},{agentRole:'CSO',actionType:'sales_outreach',mode:'auto'},{agentRole:'CTO',actionType:'incident_approval',mode:'auto'}]);
 const result=await transaction(session=>pauseAdminApprovals({user:admin,text:'Please pause all automatic approvals.',session,requestId:'synthetic-pause'}));
 expect(result.changed).toBe(3);
 expect(await Preference.countDocuments({mode:'manual'})).toBe(3);
 expect((await Preference.findOne({agentRole:'CTO'})).mode).toBe('auto');
 expect(await AuditLog.countDocuments({action:'admin.assistant.approvals_paused'})).toBe(1);
});
test('an action and its audit roll back together when saving the reply fails', async () => {
 await Preference.create({agentRole:'CMO',actionType:'marketing_publish',mode:'auto'});
 await expect(transaction(async session=>{await pauseAdminApprovals({user:admin,text:'Pause marketing approvals',session});throw Error('reply write failed');})).rejects.toThrow('reply write failed');
 expect((await Preference.findOne({agentRole:'CMO'})).mode).toBe('auto');
 expect(await AuditLog.countDocuments()).toBe(0);
});
test('current role overrides stale admin claims', async () => {
 await Preference.create({agentRole:'CMO',actionType:'marketing_publish',mode:'auto'});
 await User.updateOne({_id:admin._id},{$set:{role:'attorney'}});
 await expect(transaction(session=>pauseAdminApprovals({user:admin,text:'Pause marketing approvals',session}))).rejects.toMatchObject({statusCode:403});
 expect((await Preference.findOne({agentRole:'CMO'})).mode).toBe('auto');
});
test('a disabled account cannot pause or read private automation state', async () => {
 await User.updateOne({_id:admin._id},{$set:{disabled:true}});
 await expect(transaction(session=>pauseAdminApprovals({user:admin,text:'Pause all approvals',session}))).rejects.toMatchObject({statusCode:403});
 await expect(readAdminAutomation({user:admin,text:'What is AI doing?'})).rejects.toMatchObject({statusCode:403});
});
test('an absent preference stays absent and is reported as already off',async()=>{
 const result=await transaction(session=>pauseAdminApprovals({user:admin,text:'Pause support approvals',session}));
 expect(result.reply).toContain('already off');expect(await Preference.countDocuments()).toBe(0);
});
test('unavailable background reads remain unavailable',async()=>{
 jest.spyOn(require('../services/adminActivityService'),'readAdminActivity').mockRejectedValueOnce(Error('offline'));
 expect(await readAdminAutomation({user:admin,text:'Is automation running?'})).toMatchObject({available:false,reply:expect.stringContaining('couldn’t check')});
});

test('exact pause automatic messages stops only correspondence policies with a persisted audit',async()=>{
 const {POLICIES}=require('../services/support/automaticCorrespondence');
 await Preference.create([...Object.values(POLICIES).map(actionType=>({agentRole:'CCO',actionType,mode:'auto'})),{agentRole:'CMO',actionType:'marketing_publish',mode:'auto'}]);
 const result=await transaction(session=>pauseAdminApprovals({user:admin,text:'Pause automatic messages',session,requestId:'synthetic-message-pause'}));
 expect(result.changed).toBe(3);expect(result.reply).toContain('Automatic messages are paused');expect((await Preference.findOne({agentRole:'CMO'})).mode).toBe('auto');expect(await AuditLog.countDocuments({action:'admin.assistant.correspondence_paused'})).toBe(1);
});

test('assistant separates automatic messages from draft approvals and provider acceptance from inbox receipt',async()=>{
 jest.spyOn(require('../services/adminActivityService'),'readAdminActivity').mockResolvedValueOnce({checkedAt:'synthetic',automation:{message:'Worker checked'},unavailable:[],policies:[],correspondence:{policies:[{mode:'auto',label:'Routine support replies'}],counts:{accepted:2,unknown:1}},mailbox:{workerHealth:{ok:true}}});
 const result=await readAdminAutomation({user:admin,text:'What is AI doing?'});
 expect(result.reply).toContain('Automatic messages enabled: routine support replies');expect(result.reply).toContain('inbox receipt is not confirmed');expect(result.reply).toContain('1 automatic message attempts need delivery review');
});
