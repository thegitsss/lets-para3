const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
process.env.STRIPE_SECRET_KEY = 'sk_test_support_mutation_local_only';
process.env.EMAIL_DISABLE = 'true';

const Conversation = require('../models/SupportConversation');
const Message = require('../models/SupportMessage');
const User = require('../models/User');
const service = require('../services/support/conversationService');
let user, original;
const observations = [];
const reply = {reply:'Synthetic persisted answer.',category:'general_support',primaryAsk:'general_support',activeTask:'ANSWER',confidence:'high',urgency:'low',needsEscalation:false,actions:[],suggestions:[],grounded:true};
const send = (extra={}) => service.createConversationMessage({conversationId:String(original._id),user,text:'Explain my account preferences.',assistantReplyOverride:reply,requestId:crypto.randomUUID(),...extra});
const restart = (extra={}) => service.restartConversation({conversationId:String(original._id),user,requestId:crypto.randomUUID(),...extra});
const result = async promise => {try{return {ok:true,value:await promise};}catch(error){return{ok:false,error:{message:error.message,code:error.code,statusCode:error.statusCode}};}};
async function record(name,outcomes={}){
 const value={name,outcomes,conversations:await Conversation.find({userId:user._id}).sort({_id:1}).lean(),messages:await Message.find({}).sort({createdAt:1,_id:1}).lean()};observations.push(value);return value;
}
function latch(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}

beforeAll(async()=>{await connect();},240000);
beforeEach(async()=>{await clearDatabase();user=await User.create({firstName:'Synthetic',lastName:'Reporter',email:`support-${crypto.randomUUID()}@example.test`,password:'Synthetic long passphrase1!',role:'paralegal',status:'approved',emailVerified:true});original=await Conversation.create({userId:user._id,role:user.role,status:'open',lastMessageAt:new Date(),metadata:{support:{turnCount:0,activeTask:'PRIOR_CONTEXT'}}});});
afterEach(()=>{jest.restoreAllMocks();if(process.env.LPC_SUPPORT_MUTATION_OBSERVATIONS){fs.mkdirSync(path.dirname(process.env.LPC_SUPPORT_MUTATION_OBSERVATIONS),{recursive:true});fs.writeFileSync(process.env.LPC_SUPPORT_MUTATION_OBSERVATIONS,JSON.stringify(observations,null,2));}});
afterAll(closeDatabase);

test('a lost completed send response can replay the exact request without duplicating persisted messages',async()=>{
 const requestId=crypto.randomUUID(),first=await send({requestId}),second=await result(send({requestId}));const facts=await record('sequential-send-replay',{first,second});
 expect(second.ok).toBe(true);expect(second.value.userMessage.id).toBe(first.userMessage.id);expect(facts.messages.filter(m=>m.sender==='user')).toHaveLength(1);expect(facts.messages.filter(m=>m.sender==='assistant')).toHaveLength(1);
});
test('concurrent identical send requests produce one committed user and assistant pair',async()=>{
 const requestId=crypto.randomUUID(),outcomes=await Promise.all([result(send({requestId})),result(send({requestId}))]);const facts=await record('concurrent-identical-send',{outcomes});
 expect(facts.messages.filter(m=>m.sender==='user')).toHaveLength(1);expect(facts.messages.filter(m=>m.sender==='assistant')).toHaveLength(1);
});
test('a competing distinct send is rejected before persistence and can be explicitly retried after the first result',async()=>{
 const entered=latch(),release=latch();let held=false;const create=Message.create.bind(Message);
 jest.spyOn(Message,'create').mockImplementation(async(...args)=>{const doc=Array.isArray(args[0])?args[0][0]:args[0];if(doc?.sender==='assistant'&&!held){held=true;entered.resolve();await release.promise;}return create(...args);});
 const secondId=crypto.randomUUID(),first=result(send({text:'First preferences question.'}));await entered.promise;
 const second=await result(send({text:'Second preferences question.',requestId:secondId}));release.resolve();const completed=await first;
 expect(second).toMatchObject({ok:false,error:{code:'SUPPORT_CONVERSATION_BUSY',statusCode:409}});expect(completed.ok).toBe(true);
 expect(await Message.countDocuments({sender:'user'})).toBe(1);
 const blockedOutcome=await service.getConversationRequestOutcome({conversationId:String(original._id),userId:user._id,requestId:secondId});
 expect(blockedOutcome).toBeNull(); // The competing request was never admitted or persisted.
 await send({text:'Second preferences question.',requestId:secondId});const facts=await record('serialized-distinct-send',{first:completed,second});
 expect(facts.messages.filter(m=>m.sender==='user')).toHaveLength(2);expect(facts.conversations[0].metadata.support.turnCount).toBe(2);
});

test('a lost completed restart response replays the same successor without another reset or error',async()=>{
 const requestId=crypto.randomUUID(),first=await restart({requestId}),second=await result(restart({requestId}));const facts=await record('restart-replay',{first,second});
 expect(second.ok).toBe(true);expect(second.value.conversation.id).toBe(first.conversation.id);expect(facts.conversations).toHaveLength(2);expect(facts.conversations.filter(c=>c.status==='open')).toHaveLength(1);
});
test('failed successor creation leaves the old conversation and its context active',async()=>{
 jest.spyOn(Conversation,'create').mockRejectedValueOnce(new Error('synthetic successor creation failure'));const outcome=await result(restart());const facts=await record('restart-successor-failure',{outcome});
 expect(outcome.ok).toBe(false);expect(facts.conversations).toHaveLength(1);expect(facts.conversations[0]).toMatchObject({status:'open',metadata:{support:{activeTask:'PRIOR_CONTEXT'}}});
});
test('failed restart welcome persistence does not leave a half-created successor',async()=>{
 jest.spyOn(Message,'create').mockRejectedValueOnce(new Error('synthetic welcome persistence failure'));const outcome=await result(restart());const facts=await record('restart-welcome-failure',{outcome});
 expect(outcome.ok).toBe(false);expect(facts.conversations).toHaveLength(1);expect(facts.conversations[0].status).toBe('open');
});
test('sending to an already restarted conversation does not persist orphan messages before rejecting',async()=>{
 const next=await restart(),before=await Message.countDocuments({conversationId:original._id}),outcome=await result(send());const facts=await record('send-after-restart',{outcome,next});
 expect(outcome.ok).toBe(false);expect(facts.messages.filter(m=>String(m.conversationId)===String(original._id))).toHaveLength(before);expect(facts.conversations.find(c=>String(c._id)===next.conversation.id).status).toBe('open');
});
test('restart cannot pass an unfinished send and move the visible conversation before its answer commits',async()=>{
 const entered=latch(),release=latch(),create=Message.create.bind(Message);let held=false;
 jest.spyOn(Message,'create').mockImplementation(async(...args)=>{if((Array.isArray(args[0])?args[0][0]:args[0])?.sender==='assistant'&&!held){held=true;entered.resolve();await release.promise;}return create(...args);});
 const pending=result(send());await entered.promise;const reset=await result(restart());release.resolve();const sent=await pending;await record('held-send-versus-restart',{reset,sent});
 expect(reset.ok).toBe(false);expect(reset.error.statusCode).toBe(409);expect(sent.ok).toBe(true);
});
test('ordinary sequential sends preserve two complete pairs and two turns',async()=>{
 await send({text:'First preferences question.'});await send({text:'Second preferences question.'});const facts=await record('ordinary-sequential-control');expect(facts.messages.filter(m=>m.sender==='user')).toHaveLength(2);expect(facts.messages.filter(m=>m.sender==='assistant')).toHaveLength(2);expect(facts.conversations[0].metadata.support.turnCount).toBe(2);
});
test('unrelated owners cannot send or restart the retained conversation',async()=>{
 const other={_id:new mongoose.Types.ObjectId(),role:'paralegal'};expect(await send({user:other})).toBeNull();expect(await restart({user:other})).toBeNull();expect(await Message.countDocuments()).toBe(0);expect((await Conversation.findById(original._id)).status).toBe('open');
});


test('another tab can recover the exact interrupted send from the authenticated server receipt',async()=>{
 const requestId=crypto.randomUUID();const create=Message.create.bind(Message);let injected=false;
 jest.spyOn(Message,'create').mockImplementation(async(...args)=>{if(!injected&&args[0][0]?.sender==='assistant'){injected=true;throw Error('Synthetic interrupted answer');}return create(...args);});
 await expect(send({requestId,text:'Recover my original question.'})).rejects.toThrow();
 const activeRecovery=require('../services/support/mutationService').activeRecovery;
 const recovery=await activeRecovery({user,conversationId:String(original._id)});
 expect(recovery).toMatchObject({version:1,ownerId:String(user._id),role:user.role,requestId,action:'send',body:{text:'Recover my original question.'}});
 expect(await activeRecovery({user:{_id:new mongoose.Types.ObjectId(),role:user.role},conversationId:String(original._id)})).toBeNull();
 expect(await activeRecovery({user:{_id:user._id,role:'attorney'},conversationId:String(original._id)})).toBeNull();
 await send({...recovery.body,requestId:recovery.requestId});
 expect(await Message.countDocuments({sender:'user'})).toBe(1);expect(await Message.countDocuments({sender:'assistant'})).toBe(1);
 expect(await activeRecovery({user,conversationId:String(original._id)})).toBeNull();
});
test('another tab can recover a failed restart with its original context',async()=>{
 jest.spyOn(Conversation,'create').mockRejectedValueOnce(Error('Synthetic interrupted restart'));
 const requestId=crypto.randomUUID(),sourcePage='/attorney-v2.html#/help';
 await expect(restart({requestId,sourcePage})).rejects.toThrow();
 const recovery=await require('../services/support/mutationService').activeRecovery({user,conversationId:String(original._id)});
 expect(recovery).toMatchObject({requestId,action:'restart',body:{sourcePage}});
 const completed=await restart({...recovery.body,requestId});expect(completed.conversation.id).not.toBe(String(original._id));
 expect(await Conversation.countDocuments({userId:user._id})).toBe(2);
});


test('an older never-claimed receipt reports retryable instead of processing forever',async()=>{
 const requestId=crypto.randomUUID();
 await require('../models/SupportMutation').create({ownerId:user._id,conversationId:original._id,role:user.role,requestId,action:'send',fingerprint:'synthetic-unclaimed',state:'pending',active:false});
 const outcome=await service.getConversationRequestOutcome({conversationId:String(original._id),userId:user._id,requestId});
 expect(outcome.request.state).toBe('retryable');
});
