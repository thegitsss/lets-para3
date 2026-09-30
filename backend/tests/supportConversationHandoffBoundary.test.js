const crypto = require('node:crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
process.env.STRIPE_SECRET_KEY = 'sk_test_support_handoff_local_only';
process.env.EMAIL_DISABLE = 'true';
const User = require('../models/User');
const Conversation = require('../models/SupportConversation');
const Message = require('../models/SupportMessage');
const Ticket = require('../models/SupportTicket');
const Alert = require('../models/AdminCommunicationAlert');
const service = process.env.LPC_SUPPORT_ORIGINAL_HANDOFF === '1'
  ? require('../services/support/conversationServiceOriginalFixture')
  : require('../services/support/conversationService');
let user, conversation;
beforeAll(connect,240000);
beforeEach(async()=>{await clearDatabase();user=await User.create({firstName:'Synthetic',lastName:'Reporter',email:`handoff-${crypto.randomUUID()}@example.test`,password:'Synthetic handoff passphrase1!',role:'attorney',status:'approved',emailVerified:true});conversation=await Conversation.create({userId:user._id,role:user.role,status:'open'});});
afterEach(()=>jest.restoreAllMocks());afterAll(closeDatabase);
const send=requestId=>service.createConversationMessage({conversationId:String(conversation._id),user,text:'I need to talk to a person.',requestId});
test('replayed human handoff keeps one question acknowledgment ticket and owner alert',async()=>{
 const id=crypto.randomUUID(),first=await send(id),second=await send(id);
 expect(await Ticket.countDocuments({conversationId:conversation._id,requestKind:'human'})).toBe(1);
 expect(await Alert.countDocuments({kind:'human'})).toBe(1);
 expect(await Message.countDocuments({conversationId:conversation._id,sender:'user'})).toBe(1);
 expect(await Message.countDocuments({conversationId:conversation._id,'metadata.kind':'human_handoff'})).toBe(1);
 expect(second.userMessage.id).toBe(first.userMessage.id);expect(second.assistantMessage.id).toBe(first.assistantMessage.id);
});
test('failed handoff acknowledgment cannot commit a partial ticket or duplicate the retry question',async()=>{
 const id=crypto.randomUUID(),create=Message.create.bind(Message);let failed=false;
 jest.spyOn(Message,'create').mockImplementation(async(...args)=>{const doc=Array.isArray(args[0])?args[0][0]:args[0];if(doc?.metadata?.kind==='human_handoff'&&!failed){failed=true;throw new Error('synthetic acknowledgment failure');}return create(...args);});
 await expect(send(id)).rejects.toThrow();expect(failed).toBe(true);
 expect(await Ticket.countDocuments({conversationId:conversation._id})).toBe(0);
 expect(await Alert.countDocuments({kind:'human'})).toBe(0);
 await send(id);expect(await Message.countDocuments({conversationId:conversation._id,sender:'user'})).toBe(1);expect(await Message.countDocuments({conversationId:conversation._id,'metadata.kind':'human_handoff'})).toBe(1);
});
