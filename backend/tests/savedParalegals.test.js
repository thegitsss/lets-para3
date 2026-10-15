const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), request = require('supertest');
const User = require('../models/User'), Case = require('../models/Case'), Saved = require('../models/SavedParalegal'), Block = require('../models/Block');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/paralegals', require('../routes/paralegals'));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let attorney, other, paralegal;
const path = () => `/api/paralegals/saved/${paralegal._id}`;
const put = (saved, user = attorney, extra = {}) => request(app).put(path()).set('Cookie', cookie(user)).send({ expectedOwnerId: String(user._id), saved, ...extra });
const read = (user = attorney) => request(app).get(path()).set('Cookie', cookie(user)).query({ expectedOwnerId: String(user._id) });
const list = (user = attorney, page = '1') => request(app).get('/api/paralegals/saved').set('Cookie', cookie(user)).query({ expectedOwnerId: String(user._id), page });
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [attorney, other, paralegal] = await User.create(['attorney', 'attorney', 'paralegal'].map((role, i) => ({ firstName: ['Avery', 'Blair', 'Casey'][i], lastName: 'Example', email: `saved-${i}@example.test`, role, status: 'approved', password: 'SyntheticPassword123!' })));
  await Case.collection.insertOne({ attorney: attorney._id, paralegal: paralegal._id, title: 'Completed work', status: 'completed' });
});
test('save persists, is private, is idempotent, and can be removed', async () => {
  expect((await read()).body).toMatchObject({ saved: false, decided: false, available: true });
  expect((await put(true)).status).toBe(200); expect((await put(true)).status).toBe(200);
  expect(await Saved.countDocuments()).toBe(1);
  expect((await read()).body).toMatchObject({ saved: true, decided: true });
  const response = await list(); expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.items[0]).toMatchObject({ id: String(paralegal._id), profile: { name: 'Casey Example' } });
  expect(JSON.stringify(response.body)).not.toMatch(/email|password|resumeURL/);
  expect((await list(other)).body.total).toBe(0);
  expect((await put(false)).status).toBe(200); expect((await list()).body.total).toBe(0);
  expect((await read()).body).toMatchObject({ saved: false, decided: true });
});
test('No thanks is remembered without adding a saved profile', async () => {
  expect((await put(false)).status).toBe(200); expect((await read()).body).toMatchObject({ saved: false, decided: true }); expect((await list()).body.items).toEqual([]);
});
test('concurrent saves create only one preference', async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => put(true)));
  expect(responses.every(response => response.status === 200)).toBe(true); expect(await Saved.countDocuments()).toBe(1);
});
test('rejects other roles, stale account context, malformed writes, and unsigned access', async () => {
  expect((await put(true, paralegal)).status).toBe(403);
  expect((await put(true, attorney, { expectedOwnerId: String(other._id) })).status).toBe(403);
  expect((await put('yes')).status).toBe(400);
  expect((await put(true, attorney, { attorneyId: String(other._id) })).status).toBe(400);
  expect((await request(app).get('/api/paralegals/saved')).status).toBe(401);
  expect(await Saved.countDocuments()).toBe(0);
});
test('hidden unrelated profiles cannot be saved; relationship permits saving', async () => {
  await User.updateOne({ _id: paralegal._id }, { $set: { 'preferences.hideProfile': true } });
  expect((await put(true, other)).status).toBe(404); expect((await put(true)).status).toBe(200);
});
test.each(['blocked', 'deleted', 'disabled', 'pending'])('%s profiles expose no saved profile details and can still be removed', async condition => {
  await put(true);
  if (condition === 'blocked') await Block.create({ blockerId: paralegal._id, blockedId: attorney._id });
  else await User.updateOne({ _id: paralegal._id }, { $set: condition === 'pending' ? { status: 'pending' } : { [condition]: true } });
  expect((await list()).body.items).toEqual([{ id: String(paralegal._id), profile: null }]);
  expect((await put(true)).status).toBe(404); expect((await put(false)).status).toBe(200);
});
test('list validates pagination and pages saved records without leaking dismissed choices', async () => {
  await Saved.insertMany(Array.from({ length: 21 }, (_, i) => ({ attorneyId: attorney._id, paralegalId: new (require('mongoose').Types.ObjectId)(), saved: i !== 20 })));
  expect((await list()).body).toMatchObject({ total: 20, page: 1, pages: 1 });
  expect((await list(attorney, '2')).body.items).toEqual([]);
  expect((await list(attorney, '-1')).status).toBe(400);
});
test('CSRF protects saved preferences when enabled', async () => {
  process.env.ENABLE_CSRF = 'true';
  try { expect((await put(true)).status).toBe(403); expect(await Saved.countDocuments()).toBe(0); }
  finally { process.env.ENABLE_CSRF = 'false'; }
});

test('a discoverable profile can be saved before working together', async () => {
  await User.updateOne({ _id: paralegal._id }, { $set: { bio: 'Contracts and legal research', skills: ['Research'], practiceAreas: ['Contract Law'], resumeURL: 'resume.pdf', profilePhotoStatus: 'approved', profileImage: '/assets/avatar-placeholder.svg' } });
  expect((await put(true, other)).status).toBe(200);
  expect((await list(other)).body.items[0].profile.name).toBe('Casey Example');
});

test('saved profiles provide a protected photo URL without exposing the stored image reference', async () => {
  await User.updateOne({ _id: paralegal._id }, { $set: { profileImage: 'private/photo-reference', profilePhotoStatus: 'approved' } });
  await put(true);
  const response = await list();
  expect(response.status).toBe(200);
  expect(response.body.items[0].profile.avatarURL).toMatch(new RegExp(`^/api/users/profile-photo/${paralegal._id}(\\?v=\\d+)?$`));
  expect(JSON.stringify(response.body)).not.toContain('private/photo-reference');
});
