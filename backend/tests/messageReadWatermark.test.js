const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Message = require('../models/Message');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/messages', require('../routes/messages'));
const cookie = user => `token=${require('jsonwebtoken').sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let attorney, paralegal, matter, old, newer;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); await Message.init();
  [attorney, paralegal] = await User.create(['attorney','paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@read-watermark.test`, password: 'Synthetic123!', role, status: 'approved' })));
  matter = await Case.create({ title: 'Synthetic read watermark', details: 'Preserve existing read progress.', attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_read_local', totalAmount: 40000 });
  [old, newer] = await Message.create([60000,1000].map((age,index) => ({ caseId: matter._id, senderId: attorney._id, senderRole: 'attorney', type: 'text', text: index ? 'Later viewed instruction' : 'Earlier instruction', createdAt: new Date(Date.now()-age) })));
});
const mark = upTo => request(app).post(`/api/messages/${matter._id}/read`).set('Cookie', cookie(paralegal)).set('X-LPC-Owner-Id', String(paralegal._id)).send({ upTo, ...(upTo===old.createdAt.toISOString() ? { messageId: String(old._id) } : {}) });
async function observe(identity, responses) {
  const viewer = await User.findById(paralegal._id), records = await Message.find({ caseId: matter._id }).sort({ createdAt: 1 });
  const count = await request(app).get('/api/messages/unread-count').set('Cookie', cookie(paralegal));
  const evidence = { identity, responses, oldCreatedAt:old.createdAt.toISOString(), latestCreatedAt:newer.createdAt.toISOString(), persistedWatermark:viewer.messageLastViewedAt?.get(String(matter._id))?.toISOString(), readBy:records.map(row=>({id:String(row._id),readBy:row.readBy.map(String)})), unread:count.body.count };
  if (process.env.LPC_READ_WATERMARK_EVIDENCE) require('fs').appendFileSync(process.env.LPC_READ_WATERMARK_EVIDENCE, JSON.stringify(evidence)+'\n');
  return evidence;
}

test('reviewing an older exact target cannot make already-viewed legacy timestamp-only history unread again', async () => {
  await User.updateOne({ _id: paralegal._id }, { $set: { [`messageLastViewedAt.${matter._id}`]:newer.createdAt } });
  expect((await request(app).get('/api/messages/unread-count').set('Cookie', cookie(paralegal))).body.count).toBe(0);
  expect((await Message.findById(newer._id)).readBy).toHaveLength(0);
  const response = await mark(old.createdAt.toISOString()); expect(response.status).toBe(200);
  const evidence = await observe('legacy timestamp-only latest view then older exact target',[response.status]);
  expect(evidence.persistedWatermark).toBe(newer.createdAt.toISOString());
  expect(evidence.unread).toBe(0);
});

test('an older acknowledgement arriving after a concurrent latest acknowledgement cannot move persisted read progress backward', async () => {
  await User.updateOne({ _id: paralegal._id }, { $set: { [`messageLastViewedAt.${matter._id}`]:new Date(old.createdAt.getTime()-1000) } });
  const collection=User.collection, original=collection.updateOne;
  let release, reached, timer, olderRequest;
  const held=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{reached=resolve;});
  collection.updateOne=async function(...args) {
    const update=args[1]||{}, writes={...update.$set,...update.$max};
    const olderWrite=Object.entries(writes).some(([key,value])=>key.startsWith('messageLastViewedAt')&&new Date(value).getTime()===old.createdAt.getTime());
    if (String(args[0]?._id)===String(paralegal._id)&&olderWrite) { reached(); await held; }
    return original.apply(this,args);
  };
  try {
    olderRequest=mark(old.createdAt.toISOString()).then(response=>response);
    await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The older actual watermark write did not reach the owned gate.')),5000);})]);
    clearTimeout(timer);
    const latestResponse=await mark(newer.createdAt.toISOString()); expect(latestResponse.status).toBe(200);
    release(); const olderResponse=await olderRequest; expect(olderResponse.status).toBe(200);
    const evidence=await observe('older actual database write released after latest acknowledgement',[latestResponse.status,olderResponse.status]);
    expect(evidence.persistedWatermark).toBe(newer.createdAt.toISOString());
    expect(evidence.unread).toBe(0);
  } finally {
    clearTimeout(timer);release();if(olderRequest)await olderRequest;collection.updateOne=original;
  }
});
