const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Types } = require('mongoose');
const { isDeepStrictEqual } = require('node:util');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/stripe', () => ({}));
jest.mock('../utils/email', () => jest.fn(async () => ({})));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async () => ({})) }));
const User = require('../models/User');
const Case = require('../models/Case');
const Message = require('../models/Message');
const verifyToken = require('../utils/verifyToken');
const { requireCaseAccess } = require('../utils/authz');
const ensureCaseParticipant = require('../middleware/ensureCaseParticipant');
const app = express();
app.use(cookieParser(), express.json());
app.get('/acl/:caseId', verifyToken, requireCaseAccess('caseId', { project: 'title' }), (req, res) => res.json({ title: req.case.title }));
app.get('/participant/:caseId', verifyToken, ensureCaseParticipant(), (req, res) => res.json({ title: req.case.title }));
app.use('/api/cases', require('../routes/cases'));
app.use('/api/messages', require('../routes/messages'));
app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message }));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let people, matter;
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  people = Object.fromEntries(['attorney', 'attorneyAlias', 'paralegal', 'paralegalAlias', 'unrelated', 'admin'].map(key => [key, {
    _id: new Types.ObjectId(), firstName: 'Synthetic', lastName: key, email: `${key.toLowerCase()}@ownership.test`,
    role: key.startsWith('paralegal') ? 'paralegal' : key === 'admin' ? 'admin' : 'attorney', status: 'approved', authVersion: 0,
  }]));
  await User.collection.insertMany(Object.values(people));
  matter = await Case.create({ title: 'PRIVATE_MATTER_TITLE', details: 'PRIVATE_MATTER_DETAILS', attorney: people.attorney._id, attorneyId: people.attorney._id,
    paralegal: people.paralegal._id, paralegalId: people.paralegal._id, totalAmount: 40001, status: 'in progress', hiredAt: new Date(), escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_ownership', tasks: [{ title: 'Private scope' }] });
  await Message.create({ caseId: matter._id, senderId: people.paralegal._id, senderRole: 'paralegal', text: 'PRIVATE_CONVERSATION_TEXT' });
});
const paths = { acl: id => `/acl/${id}`, participant: id => `/participant/${id}`, matter: id => `/api/cases/${id}`, messages: id => `/api/messages/${id}` };
test.each(Object.keys(paths).flatMap(surface => ['attorney', 'attorneyAlias', 'paralegal', 'paralegalAlias'].map(actor => [surface, actor])))('%s refuses conflicting recorded identity for %s without exposing or changing private records', async (surface, actorKey) => {
  const role = people[actorKey].role;
  await Case.collection.updateOne({ _id: matter._id }, { $set: { [`${role}Id`]: people[`${role}Alias`]._id } });
  const before = await Case.collection.findOne({ _id: matter._id });
  const beforeUser = await User.collection.findOne({ _id: people[actorKey]._id });
  const beforeMessages = await Message.collection.find({ caseId: matter._id }).toArray();
  const response = await request(app).get(paths[surface](matter._id)).set('Cookie', cookie(people[actorKey]));
  expect({ status: response.status, privateContent: /PRIVATE_MATTER|PRIVATE_CONVERSATION/.test(response.text),
    matterChanged: !isDeepStrictEqual(await Case.collection.findOne({ _id: matter._id }), before),
    viewerChanged: !isDeepStrictEqual(await User.collection.findOne({ _id: people[actorKey]._id }), beforeUser),
    messagesChanged: !isDeepStrictEqual(await Message.collection.find({ caseId: matter._id }).toArray(), beforeMessages),
  }).toEqual({ status: 409, privateContent: false, matterChanged: false, viewerChanged: false, messagesChanged: false });
  expect(response.body.code).toBe('CASE_IDENTITY_CONFLICT');
  expect(response.headers['cache-control']).toBe('private, no-store');
});
test.each(['acl', 'participant'].flatMap(surface => ['attorney', 'paralegal'].map(role => [surface, role])))('%s rejects an unreadable %s alias instead of treating it as absent', async (surface, role) => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { [`${role}Id`]: 'unreadable-recorded-identity' } });
  const before = await Case.collection.findOne({ _id: matter._id });
  const response = await request(app).get(paths[surface](matter._id)).set('Cookie', cookie(people[role]));
  expect({ status: response.status, privateContent: /PRIVATE_MATTER/.test(response.text) }).toEqual({ status: 409, privateContent: false });
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test.each(['acl', 'participant'].flatMap(surface => ['attorney', 'paralegal'].flatMap(role => ['single', 'alias_only', 'text', 'uppercase'].map(shape => [surface, role, shape]))))('%s preserves %s access with coherent %s identity fields', async (surface, role, shape) => {
  const actor = people[role], primary = shape === 'uppercase' ? String(actor._id).toUpperCase() : String(actor._id);
  const change = ['single', 'alias_only'].includes(shape) ? { $unset: { [shape === 'single' ? `${role}Id` : role]: '' } } : { $set: { [role]: primary, [`${role}Id`]: actor._id } };
  await Case.collection.updateOne({ _id: matter._id }, change);
  const before = await Case.collection.findOne({ _id: matter._id });
  const response = await request(app).get(paths[surface](matter._id)).set('Cookie', cookie(actor));
  expect({ status: response.status, body: response.body }).toEqual({ status: 200, body: { title: 'PRIVATE_MATTER_TITLE' } });
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test.each(['acl', 'participant'])('%s keeps revoked paralegal access denied before reporting an identity conflict', async surface => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegalId: people.paralegalAlias._id, paralegalAccessRevokedAt: new Date() } });
  const before = await Case.collection.findOne({ _id: matter._id });
  const response = await request(app).get(paths[surface](matter._id)).set('Cookie', cookie(people.paralegal));
  expect(response.status).toBe(surface === 'acl' ? 404 : 403);
  expect(response.body.code).toBeUndefined();
  expect(response.text).not.toMatch(/PRIVATE_MATTER|PRIVATE_CONVERSATION/);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
test.each(['acl', 'participant'])('%s preserves administrative inspection and hides conflicting records from unrelated users', async surface => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { attorneyId: people.attorneyAlias._id } });
  const before = await Case.collection.findOne({ _id: matter._id });
  const admin = await request(app).get(paths[surface](matter._id)).set('Cookie', cookie(people.admin));
  expect(admin.status).toBe(200);
  const unrelated = await request(app).get(paths[surface](matter._id)).set('Cookie', cookie(people.unrelated));
  expect(unrelated.status).toBe(surface === 'acl' ? 404 : 403);
  expect(unrelated.text).not.toMatch(/PRIVATE_MATTER|PRIVATE_CONVERSATION/);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(before);
});
