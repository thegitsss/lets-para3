const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User'), Case = require('../models/Case'), Block = require('../models/Block'), AuthSession = require('../models/AuthSession');
const { createAuthSession } = require('../services/authSessionService');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/blocks', require('../routes/blocks'));
let owner, target, other, matter, cookie, session;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase();
  [owner, target, other] = await User.create(['owner', 'target', 'other'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@contextual-block.test`, password: 'SyntheticPassword123!', status: 'approved', role: name === 'owner' ? 'attorney' : 'paralegal' })));
  session = await createAuthSession(owner, { headers: {}, ip: '192.0.2.21' });
  cookie = `token=${jwt.sign({ id: String(owner._id), role: owner.role, av: owner.authVersion || 0, sid: session.sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  matter = await Case.create({ title: 'Contextual blocking', details: 'Only this recorded applicant may be blocked from this review.', practiceArea: 'immigration', attorney: owner._id, attorneyId: owner._id, status: 'open', applicants: [{ paralegalId: target._id, status: 'pending' }] });
});
const send = extra => request(app).post('/api/blocks').set('Cookie', cookie).send({ caseId: String(matter._id), paralegalId: String(target._id), expectedOwnerId: String(owner._id), expectedBlockedId: String(target._id), ...extra });
function afterContextRead(change) {
  const original = Case.collection.findOne.bind(Case.collection); let altered = false;
  jest.spyOn(Case.collection, 'findOne').mockImplementation(async (...args) => {
    const value = await original(...args);
    if (!altered && String(args[0]?._id) === String(matter._id)) { altered = true; await change(); }
    return value;
  });
  return () => expect(altered).toBe(true);
}
test('the reviewed owner and counterpart must match the contextual action', async () => {
  for (const [extra, status] of [[{ expectedOwnerId: String(other._id) }, 403], [{ expectedBlockedId: String(other._id) }, 409]]) {
    const response = await send(extra); expect({ status: response.status, body: response.body }).toMatchObject({ status });
    expect(await Block.countDocuments()).toBe(0);
  }
});
test.each(['disabled', 'authVersion', 'session'])('%s changing after contextual eligibility is read prevents creation', async kind => {
  const checked = afterContextRead(async () => {
    if (kind === 'session') await AuthSession.updateOne({ sessionId: session.sessionId }, { $set: { revokedAt: new Date() } });
    else await User.collection.updateOne({ _id: owner._id }, { $set: kind === 'disabled' ? { disabled: true } : { authVersion: 1 } });
  });
  const response = await send(); checked(); expect({ status: response.status, body: response.body }).toMatchObject({ status: 403 });
  expect(await Block.countDocuments()).toBe(0);
});
test('a newly assigned applicant cannot be blocked from an older screening context', async () => {
  const checked = afterContextRead(() => Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'in progress', paralegal: target._id, paralegalId: target._id, 'applicants.0.status': 'accepted' } }));
  const response = await send(); checked(); expect({ status: response.status, body: response.body }).toMatchObject({ status: 409 });
  expect(await Block.countDocuments()).toBe(0);
  expect(await Case.findById(matter._id).lean()).toMatchObject({ status: 'in progress', paralegalId: target._id });
});
test('an independent private note survives contextual creation', async () => {
  const checked = afterContextRead(() => Case.collection.updateOne({ _id: matter._id }, { $set: { privateNote: 'Keep this independent note.' } }));
  const response = await send(); checked(); expect({ status: response.status, body: response.body }).toMatchObject({ status: 201 });
  expect((await Case.findById(matter._id).lean()).privateNote).toBe('Keep this independent note.');
  expect(await Block.countDocuments({ blockerId: owner._id, blockedId: target._id, active: true })).toBe(1);
});
test('a finalized context cannot silently block a different retained counterparty', async () => {
  await Case.updateOne({ _id: matter._id }, { $set: { status: 'completed', paralegal: other._id, paralegalId: other._id, paymentReleased: true } });
  const response = await send({ paralegalId: undefined });
  expect({ status: response.status, body: response.body }).toMatchObject({ status: 409 });
  expect(await Block.countDocuments()).toBe(0);
});

test('an unknown commit result stays uncertain and the saved direct block can be read back', async () => {
  const mongoose = require('mongoose'), original = mongoose.startSession.bind(mongoose);
  jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async () => {
    const session = await original(), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => { await commit(); const error = new Error('Synthetic lost commit acknowledgement'); error.hasErrorLabel = label => label === 'UnknownTransactionCommitResult'; throw error; };
    return session;
  });
  const response = await send();
  expect({ status: response.status, body: response.body }).toMatchObject({ status: 503, body: { code: 'ACCOUNT_WRITE_UNCONFIRMED' } });
  expect(await Block.countDocuments({ blockerId: owner._id, blockedId: target._id, active: true })).toBe(1);
  const saved = await request(app).get(`/api/blocks/${target._id}?expectedOwnerId=${owner._id}`).set('Cookie', cookie);
  expect({ status: saved.status, body: saved.body }).toMatchObject({ status: 200, body: { blocked: true, blockedId: String(target._id) } });
});

test.each(['attorney', 'paralegal'])('conflicting %s participant aliases do not authorize a contextual block', async role => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: role === 'attorney' ? { attorneyId: other._id } : { paralegal: other._id, paralegalId: target._id } });
  const response = await send();
  expect({ status: response.status, body: response.body }).toMatchObject({ status: 409, body: { code: 'CASE_IDENTITY_CONFLICT' } });
  expect(await Block.countDocuments()).toBe(0);
});
