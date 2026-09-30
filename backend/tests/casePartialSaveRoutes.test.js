const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async (_userId, _type, _payload, options = {}) => options.deferDispatch ? async () => ({}) : {}) }));
jest.mock('../utils/s3Client', () => ({ createS3Client: () => ({ send: async () => { throw new Error('Unexpected synthetic object-storage call'); } }) }));
jest.mock('../utils/stripe', () => ({ accounts: { retrieve: jest.fn(async id => ({ id, details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [], disabled_reason: null } })) } }));
const Case = require('../models/Case');
const User = require('../models/User');
const Job = require('../models/Job');
const Application = require('../models/Application');
const app = express();
app.use(cookieParser(), express.json());
app.use('/api/cases', require('../routes/cases'));
app.use('/api/paralegals', require('../routes/users').paralegalRouter);
app.use((error, req, res, next) => res.status(error.status || 500).json({ name: error.name, error: error.message, fields: Object.keys(error.errors || {}) }));
const cookie = user => `token=${require('jsonwebtoken').sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const evidence = process.env.LPC_CASE_PARTIAL_SAVE_EVIDENCE || '';
const expectedChanges = { zoom: ['zoomLink'], 'legacy-invite': ['updates'], metadata: ['title'], flag: ['flags'], 'auto-relist': ['relistRequestedAt', 'relistPending', 'applicants', '__v'] };
const money = ['totalAmount', 'lockedTotalAmount', 'partialPayoutAmount', 'remainingAmount', 'feeAttorneyAmount', 'feeParalegalAmount', 'disputeSettlement'];
const preserved = ['status', 'deadlineDate', 'deadline', 'attorney', 'attorneyId', 'paralegal', 'paralegalId', ...money];
const subset = (doc, fields) => Object.fromEntries(fields.map(key => [key, doc[key] ?? null]));
let owner, para, matter;
afterEach(() => jest.restoreAllMocks());
beforeAll(connect, 90000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [owner, para] = await User.create(['owner', 'para'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@partial-save.test`, password: 'Synthetic123!', role: name === 'para' ? 'paralegal' : 'attorney', status: 'approved' })));
  await User.collection.updateOne({ _id: para._id }, { $set: { profileImage: `profile-photos/${para._id}/approved.png`, stripeAccountId: 'acct_synthetic_partial_save', stripeOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true } });
  matter = await Case.create({ title: 'Synthetic lease work', practiceArea: 'contract law', state: 'New York', details: 'Review a synthetic lease and its exhibits.', attorney: owner._id, attorneyId: owner._id, status: 'open', deadlineDate: '2027-07-15', totalAmount: 40000, lockedTotalAmount: 40000, feeAttorneyAmount: 8000, feeParalegalAmount: 7200, partialPayoutAmount: 0, remainingAmount: 40000, tasks: [{ title: 'Review lease', completed: false }] });
});

test('meeting links accept Zoom domains and reject lookalikes without changing the saved link', async () => {
  const update = zoomLink => request(app).patch(`/api/cases/${matter._id}/zoom`).set('Cookie', cookie(owner)).send({ zoomLink });
  const valid = 'https://us02web.zoom.us/j/12345678901?pwd=example';
  expect((await update(valid)).status).toBe(200);
  for (const value of ['https://evilzoom.us/j/123', 'https://zoom.us.evil.test/j/123', 'https://zoom.us@evil.test/j/123', 'https://evil.test/path/zoom.us/j/123', 'http://zoom.us/j/123', 'https://zoom.us:8443/j/123', 'javascript:alert(1)', {}, 'https://zoom.us/j/' + 'x'.repeat(2000)]) {
    expect((await update(value)).status).toBe(400);
    expect((await Case.findById(matter._id)).zoomLink).toBe(valid);
  }
  expect((await request(app).patch(`/api/cases/${matter._id}/zoom`).set('Cookie', cookie(para)).send({ zoomLink: 'https://zoom.us/j/456' })).status).toBe(404);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: para._id, paralegalId: para._id, status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_meeting' } });
  expect((await request(app).patch(`/api/cases/${matter._id}/zoom`).set('Cookie', cookie(para)).send({ zoomLink: 'https://zoom.us/j/456' })).status).toBe(403);
  expect((await update('https://zoom.us/j/123')).status).toBe(200);
  expect((await update('')).status).toBe(200);
  expect((await Case.findById(matter._id)).zoomLink).toBe('');
});
test.each(['zoom', 'legacy-invite', 'metadata', 'flag', 'auto-relist'])('%s preserves unrelated saved Matter fields', async kind => {
  if (kind === 'auto-relist') {
    const job = await Job.create({ title: matter.title, description: matter.details, attorneyId: owner._id, caseId: matter._id, status: 'open', practiceArea: matter.practiceArea, budget: 400 });
    await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'paused', jobId: job._id, payoutFinalizedAt: new Date('2026-09-01T12:00:00Z'), payoutFinalizedType: 'partial_attorney', partialPayoutAmount: 15000, remainingAmount: 25000, relistPending: true, relistRequestedAt: null } });
  }
  const before = await Case.collection.findOne({ _id: matter._id });
  const saveErrors = [];
  const originalSave = Case.prototype.save;
  jest.spyOn(Case.prototype, 'save').mockImplementation(async function (...args) {
    try { return await originalSave.apply(this, args); }
    catch (error) { saveErrors.push({ name: error.name, message: error.message, fields: Object.keys(error.errors || {}), selected: this.$__.selected, modified: this.modifiedPaths() }); throw error; }
  });
  let result;
  if (kind === 'zoom') result = await request(app).patch(`/api/cases/${matter._id}/zoom`).set('Cookie', cookie(owner)).send({ zoomLink: 'https://us02web.zoom.us/j/12345678901' });
  if (kind === 'legacy-invite') result = await request(app).post(`/api/paralegals/${para._id}/invite`).set('Cookie', cookie(owner)).send({ caseId: String(matter._id), message: 'Please review this synthetic invitation.' });
  if (kind === 'metadata') result = await request(app).patch(`/api/cases/${matter._id}`).set('Cookie', cookie(owner)).send({ title: 'Synthetic revised lease title' });
  if (kind === 'flag') result = await request(app).post(`/api/cases/${matter._id}/flag`).set('Cookie', cookie(para)).send({ reason: 'other', details: 'Synthetic duplicate posting concern.' });
  if (kind === 'auto-relist') result = await request(app).post(`/api/cases/${matter._id}/apply`).set('Cookie', cookie(para)).send({ coverLetter: 'I can review this synthetic lease and its exhibits.' });
  const after = await Case.collection.findOne({ _id: matter._id });
  const changedFields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (evidence) {
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, `${kind}.json`), JSON.stringify({ kind, status: result.status, response: result.body, saveErrors, before, after, preservedBefore: subset(before, preserved), preservedAfter: subset(after, preserved), changedFields, applications: await Application.countDocuments({ paralegalId: para._id }) }, null, 2));
  }
  expect(changedFields.filter(key => ![...expectedChanges[kind], 'updatedAt'].includes(key))).toEqual([]);
  expect({ status: result.status, response: result.body.error || null, fields: result.body.fields || [] }).toEqual({ status: kind === 'auto-relist' ? 201 : 200, response: null, fields: [] });
  expect(subset(after, preserved)).toEqual(subset(before, preserved));
  if (kind === 'zoom') expect(after.zoomLink).toBe('https://us02web.zoom.us/j/12345678901');
  if (kind === 'legacy-invite') expect(after.updates.length).toBe(before.updates.length + 1);
  if (kind === 'metadata') expect(after.title).toBe('Synthetic revised lease title');
  if (kind === 'flag') expect(after.flags).toHaveLength(1);
  if (kind === 'auto-relist') expect(await Application.countDocuments({ paralegalId: para._id })).toBe(1);
});
