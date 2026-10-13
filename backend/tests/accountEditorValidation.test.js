const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/users', require('../routes/users'));
app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Server error' }));
let user;
const save = (values, expectedValues) => request(app).patch('/api/users/me').set('Cookie', `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`).send({ expectedOwnerId: String(user._id), expectedValues: { ...(Object.hasOwn(values, 'bio') ? { about: '' } : {}), ...expectedValues }, ...values });
const publicProfile = () => request(app).get(`/api/users/attorneys/${user._id}`).set('Cookie', `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`);
beforeAll(connect, 90000); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); user = await User.create({ firstName: 'Avery', lastName: 'Counsel', email: 'account-editor@example.test', password: 'Password123!', role: 'attorney', status: 'approved', state: 'NY', bio: 'Original biography', timezone: 'America/New_York' }); });
test('guarded editor preserves paragraphs in biography and experience without other control characters', async () => {
  const response = await save({ bio: 'First paragraph.\r\n\r\nSecond paragraph.\u0001', experience: [{ title: 'Attorney', years: '2024–2026', description: 'First responsibility.\nSecond responsibility.\u0002' }] }, { bio: 'Original biography', experience: [] });
  expect(response.status).toBe(200);
  expect(response.body.bio).toBe('First paragraph.\n\nSecond paragraph.');
  expect(response.body.experience[0].description).toBe('First responsibility.\nSecond responsibility.');
});
test.each(['firstName', 'lastName'])('guarded editor rejects whitespace-only %s without saving other fields', async field => {
  const response = await save({ [field]: '   ', bio: 'Should not save' }, { [field]: user[field], bio: 'Original biography' });
  expect(response.status).toBe(400); expect((await User.findById(user._id)).bio).toBe('Original biography');
});
test.each(['', 'Mars/Olympus', 'x'.repeat(65)])('guarded editor rejects invalid timezone %j', async timezone => {
  expect((await save({ timezone }, { timezone: 'America/New_York' })).status).toBe(400);
  expect((await User.findById(user._id)).timezone).toBe('America/New_York');
});
test('guarded alias biography clear also clears the displayed legacy about text', async () => {
  await User.updateOne({ _id: user._id }, { $set: { bio: '', about: 'Legacy practice description' } });
  const response = await save({ bio: '' }, { bio: '', about: 'Legacy practice description' });
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ bio: '', about: '' });
  expect((await publicProfile()).body.practiceDescription).toBe('');
});
test('guarded alias biography edit rejects a concurrently changed legacy about value', async () => {
  await User.updateOne({ _id: user._id }, { $set: { about: 'Other session description' } });
  expect((await save({ bio: 'My description' }, { bio: 'Original biography', about: '' })).status).toBe(409);
  expect((await User.findById(user._id)).about).toBe('Other session description');
});
test('guarded alias practice-area clear removes the displayed legacy specialties', async () => {
  await User.updateOne({ _id: user._id }, { $set: { specialties: ['Litigation'] } });
  const response = await save({ practiceAreas: [] }, { practiceAreas: [], specialties: ['Litigation'] });
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ practiceAreas: [], specialties: [] });
  expect((await publicProfile()).body).toMatchObject({ practiceAreas: [], specialties: [] });
});
test('guarded alias practice-area edit rejects concurrently changed specialties', async () => {
  await User.updateOne({ _id: user._id }, { $set: { specialties: ['Other session specialty'] } });
  expect((await save({ practiceAreas: ['Litigation'] }, { practiceAreas: [], specialties: [] })).status).toBe(409);
  expect((await User.findById(user._id)).specialties).toEqual(['Other session specialty']);
});

test.each(['', '   ', null, 'ZZ'])('profile editor cannot clear or invalidate primary state: %j', async state => {
  const response = await save({ state }, { state: 'NY' });
  expect(response.status).toBe(400);
  expect((await User.findById(user._id)).state).toBe('NY');
});
test('profile editor synchronizes primary state and directory location', async () => {
  const response = await save({ state: ' va ' }, { state: 'NY' });
  expect(response.status).toBe(200);
  expect(await User.findById(user._id)).toMatchObject({ state: 'VA', location: 'VA' });
});
