const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
process.env.STRIPE_SECRET_KEY='sk_test_support_read_race_local_only';process.env.EMAIL_DISABLE='true';
const User=require('../models/User'),Conversation=require('../models/SupportConversation'),Message=require('../models/SupportMessage');
const service=process.env.LPC_SUPPORT_ORIGINAL_READ==='1'?require('../services/support/conversationServiceOriginalFixture'):require('../services/support/conversationService');
let user,conversation;
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
beforeAll(connect,240000);beforeEach(async()=>{await clearDatabase();user=await User.create({firstName:'Synthetic',lastName:'Reader',email:`read-${crypto.randomUUID()}@example.test`,password:'Synthetic read passphrase1!',role:'paralegal',status:'approved',emailVerified:true});conversation=await Conversation.create({userId:user._id,role:user.role,status:'open',welcomeSentAt:new Date(),metadata:{support:{turnCount:0,activeTask:'OLD_CONTEXT'}}});});afterEach(()=>jest.restoreAllMocks());afterAll(closeDatabase);
const send=()=>service.createConversationMessage({conversationId:String(conversation._id),user,text:'Explain account preferences.',requestId:crypto.randomUUID(),assistantReplyOverride:{reply:'Synthetic current answer.',primaryAsk:'general_support',category:'general_support',activeTask:'ANSWER',needsEscalation:false,grounded:true}});
test('a history open begun before a completed send cannot overwrite its current conversational state',async()=>{
 const entered=latch(),release=latch();let held=false;const save=Conversation.prototype.save;
 jest.spyOn(Conversation.prototype,'save').mockImplementation(async function(...args){if(this.isModified('metadata')&&Object.hasOwn(this.metadata?.support||{},'welcomePrompt')&&!held){held=true;entered.resolve();await release.promise;}return save.apply(this,args);});
 // The corrected service uses a conditional field update instead of saving
 // its older document. Hold that actual persistence boundary as well.
 const exec=mongoose.Query.prototype.exec;
 jest.spyOn(mongoose.Query.prototype,'exec').mockImplementation(async function(...args){
  if(this.model===Conversation&&this.op==='updateOne'&&Object.hasOwn(this.getUpdate()?.$set||{},'metadata.support.welcomePrompt')&&!held){held=true;entered.resolve();await release.promise;}
  return exec.apply(this,args);
 });
 const opened=service.getOrCreateOpenConversation({user});let timer;
 try {await Promise.race([entered.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Welcome persistence boundary was not reached')),8000);})]);await send();}
 finally {clearTimeout(timer);release.resolve();await opened;}
 const saved=await Conversation.findById(conversation._id).lean();expect(saved.metadata.support.turnCount).toBe(1);expect(saved.metadata.support.lastAssistantReply).toBe('Synthetic current answer.');
});
test('retention rechecks current activity after selecting an expired conversation',async()=>{
 await Conversation.updateOne({_id:conversation._id},{$set:{lastMessageAt:new Date(Date.now()-service.SUPPORT_CONVERSATION_RETENTION_MS-1000)}});
 const entered=latch(),release=latch();let held=false;const exec=mongoose.Query.prototype.exec;
 jest.spyOn(mongoose.Query.prototype,'exec').mockImplementation(async function(...args){const result=await exec.apply(this,args);if(this.model===Conversation&&this.op==='find'&&this.getFilter().lastMessageAt?.$lt&&!held){held=true;entered.resolve();await release.promise;}return result;});
 const prune=service.pruneExpiredSupportHistory({force:true});await entered.promise;await send();release.resolve();await prune;
 expect(await Conversation.exists({_id:conversation._id})).not.toBeNull();expect(await Message.countDocuments({conversationId:conversation._id})).toBe(2);
});
