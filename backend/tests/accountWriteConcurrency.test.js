const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
process.env.S3_BUCKET = 'account-test-bucket';
process.env.S3_REGION = 'us-east-1';
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const mockSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-s3', () => {
  class S3Client { constructor() { this.send = mockSend; } }
  class Command { constructor(input) { this.input = input; } }
  return { S3Client, PutObjectCommand: Command, GetObjectCommand: Command, DeleteObjectCommand: Command, HeadObjectCommand: Command, GetObjectTaggingCommand: Command };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn(async () => 'https://synthetic.invalid/object') }));
const User = require('../models/User');
const StorageDeletionTask = require('../models/StorageDeletionTask');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/users', require('../routes/users'));
app.use('/api/account', require('../routes/account'));
app.use('/api/uploads', require('../routes/uploads'));
app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Server error' }));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const read = user => request(app).get(`/api/users/me?expectedOwnerId=${user._id}`).set('Cookie', cookie(user));
const patch = (user, values, expectedValues = {}) => request(app).patch('/api/users/me').set('Cookie', cookie(user)).send({ expectedOwnerId: String(user._id), expectedValues: { ...(Object.hasOwn(values, 'bio') ? { about: '' } : {}), ...expectedValues }, ...values });
const prefs = (user, values, expectedValues = {}) => request(app).post('/api/account/preferences').set('Cookie', cookie(user)).send({ expectedOwnerId: String(user._id), expectedValues, ...values });
const notification = (user, values, expectedValues = {}) => request(app).patch('/api/users/me/notification-prefs').set('Cookie', cookie(user)).send({ expectedOwnerId: String(user._id), expectedValues, ...values });
const photo = (user, revision, owner = String(user._id)) => request(app).post('/api/uploads/profile-photo').set('Cookie', cookie(user))
  .field('expectedOwnerId', owner).field('expectedPhotoRevision', revision || '0'.repeat(64))
  .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), { filename: 'profile.jpg', contentType: 'image/jpeg' });
let attorney;
beforeAll(connect, 90000); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); mockSend.mockReset().mockResolvedValue({});
  attorney = await User.create({ firstName: 'Avery', lastName: 'Counsel', email: 'account-cas@example.test', password: 'Password123!', role: 'attorney', status: 'approved', state: 'NY', location: 'NY', barNumber: 'NY-4321', timezone: 'America/Chicago', bio: 'Original biography', lawFirm: 'Original firm', experience: [{ title: 'Attorney', years: '2019–2026', description: 'Litigation' }], yearsExperience: 7 });
});
afterEach(() => jest.restoreAllMocks());

test('private account read returns persisted professional fields and a photo-only revision', async () => {
  const response = await read(attorney);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ barNumber: 'NY-4321', timezone: 'America/Chicago', yearsExperience: 7 });
  expect(response.body.profilePhotoRevision).toMatch(/^[a-f0-9]{64}$/);
  const changed = await patch(attorney, { bio: 'Changed biography' }, { bio: 'Original biography' });
  expect(changed.status).toBe(200);
  expect(changed.body.profilePhotoRevision).toBe(response.body.profilePhotoRevision);
  expect(changed.body).not.toHaveProperty('password');
});

test.each(['/api/users/me', '/api/account/preferences', '/api/uploads/profile-photo/original'])('private read %s rejects a replaced expected owner', async path => {
  const response = await request(app).get(`${path}?expectedOwnerId=64b000000000000000000099`).set('Cookie', cookie(attorney));
  expect(response.status).toBe(403); expect(response.body.code).toBe('ACCOUNT_CHANGED'); expect(mockSend).not.toHaveBeenCalled();
});

test('profile write rejects a replaced expected owner before changing the cookie owner', async () => {
  const response = await patch(attorney, { expectedOwnerId: '64b000000000000000000099', bio: 'Wrong account' }, { bio: 'Original biography' });
  expect(response.status).toBe(403); expect((await User.findById(attorney._id)).bio).toBe('Original biography');
});

test('attorney experience, years and state aliases round-trip through private reads', async () => {
  const experience = [{ title: 'Partner', years: '2026', description: 'Current practice' }];
  const response = await patch(attorney, { experience, yearsExperience: 8, state: 'CA' }, { experience: attorney.experience.toObject(), yearsExperience: 7, state: 'NY' });
  expect(response.status).toBe(200);
  expect((await read(attorney)).body).toMatchObject({ experience, yearsExperience: 8, state: 'CA', location: 'CA' });
});

test('stale edits to the same profile field conflict while independent edits merge', async () => {
  expect((await patch(attorney, { bio: 'First biography' }, { bio: 'Original biography' })).status).toBe(200);
  expect((await patch(attorney, { bio: 'Stale biography' }, { bio: 'Original biography' })).status).toBe(409);
  const independent = await patch(attorney, { lawFirm: 'New firm' }, { lawFirm: 'Original firm' });
  expect(independent.status).toBe(200); expect(independent.body).toMatchObject({ bio: 'First biography', lawFirm: 'New firm' });
});

test('same-field change between read and Mongo update is rejected by atomic CAS', async () => {
  const update = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    await update({ _id: attorney._id }, { $set: { bio: 'Other session won' } });
    return update(...args);
  });
  expect((await patch(attorney, { bio: 'Overwritten' }, { bio: 'Original biography' })).status).toBe(409);
  expect((await User.findById(attorney._id)).bio).toBe('Other session won');
});

test('an independent in-flight edit is retained and the response reads back current state', async () => {
  const update = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    await update({ _id: attorney._id }, { $set: { lawFirm: 'Concurrent firm' } });
    return update(...args);
  });
  const response = await patch(attorney, { bio: 'Saved biography' }, { bio: 'Original biography' });
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ bio: 'Saved biography', lawFirm: 'Concurrent firm' });
});

test('guarded writes require the expected value for each changed field', async () => {
  expect((await patch(attorney, { bio: 'No comparison' })).status).toBe(400);
  expect((await User.findById(attorney._id)).bio).toBe('Original biography');
});

test('preference fields use owner and touched-field guards without locking unrelated changes', async () => {
  expect((await prefs(attorney, { theme: 'dark', expectedOwnerId: '64b000000000000000000099' }, { theme: 'light' })).status).toBe(403);
  expect((await prefs(attorney, { theme: 'dark' }, { theme: 'light' })).status).toBe(200);
  expect((await prefs(attorney, { theme: 'light' }, { theme: 'light' })).status).toBe(409);
  const response = await prefs(attorney, { fontSize: 'lg' }, { fontSize: 'md' });
  expect(response.status).toBe(200); expect(response.body.preferences).toMatchObject({ theme: 'dark', fontSize: 'lg' });
});

test('notification preference updates conflict only on the changed leaves', async () => {
  const current = (await read(attorney)).body.notificationPrefs;
  expect((await notification(attorney, { emailMessages: !current.emailMessages, expectedOwnerId: '64b000000000000000000099' }, { emailMessages: current.emailMessages })).status).toBe(403);
  expect((await notification(attorney, { emailMessages: !current.emailMessages }, { emailMessages: current.emailMessages })).status).toBe(200);
  expect((await notification(attorney, { emailMessages: current.emailMessages }, { emailMessages: current.emailMessages })).status).toBe(409);
  const independent = await notification(attorney, { inAppCase: !current.inAppCase }, { inAppCase: current.inAppCase });
  expect(independent.status).toBe(200); expect(independent.body.notificationPrefs).toMatchObject({ emailMessages: !current.emailMessages, inAppCase: !current.inAppCase });
});

test('photo upload refuses a changed owner before any object upload', async () => {
  const response = await photo(attorney, '0'.repeat(64), '64b000000000000000000099');
  expect(response.status).toBe(403); expect(mockSend).not.toHaveBeenCalled();
});

test('photo revision changes on upload and rejects stale replacement or removal', async () => {
  const initial = (await read(attorney)).body;
  const uploaded = await photo(attorney, initial.profilePhotoRevision);
  expect(uploaded.status).toBe(200);
  const latest = (await read(attorney)).body;
  expect(latest.profilePhotoRevision).not.toBe(initial.profilePhotoRevision);
  expect(uploaded.body.profilePhotoRevision).toBe(latest.profilePhotoRevision);
  expect((await photo(attorney, initial.profilePhotoRevision)).status).toBe(409);
  expect((await patch(attorney, { avatarURL: '', expectedPhotoRevision: initial.profilePhotoRevision })).status).toBe(409);
  const removed = await patch(attorney, { avatarURL: '', expectedPhotoRevision: latest.profilePhotoRevision });
  expect(removed.status).toBe(200); expect(removed.body.profilePhotoStatus).toBe('unsubmitted');
});

test('photo upload cannot restore a photo removed while the object write is pending', async () => {
  const oldKey = `profile-photos/${attorney._id}/profile-1700000000000.jpg`;
  await User.updateOne({ _id: attorney._id }, { $set: { profileImageKey: oldKey, profileImage: `/api/users/profile-photo/${attorney._id}`, avatarURL: `/api/users/profile-photo/${attorney._id}`, profilePhotoStatus: 'approved' } });
  const initial = (await read(attorney)).body;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  mockSend.mockImplementationOnce(async () => { started(); await gate; return {}; });
  const uploading = photo(attorney, initial.profilePhotoRevision).then(value => value);
  await entered;
  try {
    expect((await patch(attorney, { avatarURL: '', expectedPhotoRevision: initial.profilePhotoRevision })).status).toBe(200);
  } finally { release(); }
  expect((await uploading).status).toBe(409);
  expect((await read(attorney)).body.profilePhotoStatus).toBe('unsubmitted');
  const compensations = await StorageDeletionTask.find({ reason: 'profile_photo_upload_compensation' }).lean();
  expect(compensations.length).toBeGreaterThan(0); expect(compensations.every(value => value.status === 'pending')).toBe(true);
});

test('a private read retains canonical state when only the older state field exists', async () => {
  await User.collection.updateOne({ _id: attorney._id }, { $unset: { location: '' } });
  expect((await read(attorney)).body.state).toBe('NY');
  expect((await patch(attorney, { state: 'CA' }, { state: 'NY' })).status).toBe(200);
  expect((await User.collection.findOne({ _id: attorney._id }))).toMatchObject({ state: 'CA', location: 'CA' });
});

test('missing legacy preference leaves use displayed defaults and do not overwrite unrelated saved views', async () => {
  await User.collection.updateOne({ _id: attorney._id }, { $unset: { preferences: '', notificationPrefs: '' } });
  expect((await prefs(attorney, { theme: 'dark' }, { theme: 'light' })).status).toBe(200);
  expect((await notification(attorney, { email: false }, { email: true })).status).toBe(200);
  const storedViews = [{ id: 'preserved-view', name: 'My view', scope: 'attorney_matters', version: 1 }];
  await User.collection.updateOne({ _id: attorney._id }, { $unset: { preferences: '' } });
  const update = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    await update({ _id: attorney._id }, { $set: { 'preferences.dashboardViews': storedViews } });
    return update(...args);
  });
  expect((await patch(attorney, { bio: 'Profile-only change' }, { bio: 'Original biography' })).status).toBe(200);
  expect((await User.collection.findOne({ _id: attorney._id })).preferences.dashboardViews).toEqual(storedViews);
});

test('preferences and notification leaves have atomic comparisons at the actual write', async () => {
  const update = User.collection.updateOne.bind(User.collection);
  const spy = jest.spyOn(User.collection, 'updateOne');
  spy.mockImplementationOnce(async (...args) => { await update({ _id: attorney._id }, { $set: { 'preferences.theme': 'dark' } }); return update(...args); });
  expect((await prefs(attorney, { theme: 'dark' }, { theme: 'light' })).status).toBe(409);
  spy.mockImplementationOnce(async (...args) => { await update({ _id: attorney._id }, { $set: { 'notificationPrefs.email': false } }); return update(...args); });
  expect((await notification(attorney, { email: false }, { email: true })).status).toBe(409);
});

test('email changes remain pending and a stale pending request cannot overwrite another session', async () => {
  const email = attorney.email;
  const first = await patch(attorney, { email: 'pending-one@example.test' }, { email, pendingEmail: '' });
  expect(first.status).toBe(200); expect(first.body).toMatchObject({ email, pendingEmail: 'pending-one@example.test' });
  expect((await patch(attorney, { email: 'pending-two@example.test' }, { email, pendingEmail: '' })).status).toBe(409);
  expect((await User.findById(attorney._id)).pendingEmail).toBe('pending-one@example.test');
  expect(require('../utils/email')).toHaveBeenCalled();
});

test('original photo read rejects a stale photo revision before object access', async () => {
  const response = await request(app).get(`/api/uploads/profile-photo/original?expectedOwnerId=${attorney._id}&expectedPhotoRevision=${'0'.repeat(64)}`).set('Cookie', cookie(attorney));
  expect(response.status).toBe(409); expect(mockSend).not.toHaveBeenCalled();
});

test('an independent profile edit while a photo uploads remains saved', async () => {
  const initial = (await read(attorney)).body;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  mockSend.mockImplementationOnce(async () => { started(); await gate; return {}; });
  const uploading = photo(attorney, initial.profilePhotoRevision).then(value => value);
  await entered;
  try { expect((await patch(attorney, { bio: 'Edited during upload' }, { bio: 'Original biography' })).status).toBe(200); }
  finally { release(); }
  expect((await uploading).status).toBe(200);
  expect((await read(attorney)).body).toMatchObject({ bio: 'Edited during upload', profilePhotoStatus: 'approved' });
});

test('a lost photo update acknowledgement retains recoverable cleanup and protects current references', async () => {
  const oldKey = `profile-photos/${attorney._id}/profile-1700000000000.jpg`;
  await User.updateOne({ _id: attorney._id }, { $set: { profileImageKey: oldKey, profileImage: `/api/users/profile-photo/${attorney._id}`, avatarURL: `/api/users/profile-photo/${attorney._id}`, profilePhotoStatus: 'approved' } });
  const initial = (await read(attorney)).body;
  const update = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => { await update(...args); throw new Error('Synthetic acknowledgement lost'); });
  expect((await photo(attorney, initial.profilePhotoRevision)).status).toBe(500);
  const persisted = await User.findById(attorney._id).select('+profileImageKey');
  expect(persisted.profileImageKey).not.toBe(oldKey);
  const tasks = await StorageDeletionTask.find({ ownerId: attorney._id }).lean();
  expect(tasks.find(task => task.key === oldKey).status).toBe('pending');
  expect(tasks.find(task => task.key === persisted.profileImageKey).status).toBe('pending');
  mockSend.mockClear();
  await require('../services/personalStorageDeletion').processPersonalStorageDeletionTasks({}, { s3: { send: mockSend }, env: process.env });
  expect(mockSend.mock.calls.map(([command]) => command.input.Key)).toEqual([oldKey]);
  expect((await StorageDeletionTask.findOne({ key: persisted.profileImageKey })).status).toBe('cancelled');
});

test('a failed object write leaves the old photo and activates safe compensation', async () => {
  const oldKey = `profile-photos/${attorney._id}/profile-1700000000000.jpg`;
  await User.updateOne({ _id: attorney._id }, { $set: { profileImageKey: oldKey, profileImage: `/api/users/profile-photo/${attorney._id}`, avatarURL: `/api/users/profile-photo/${attorney._id}`, profilePhotoStatus: 'approved' } });
  const initial = (await read(attorney)).body;
  mockSend.mockRejectedValueOnce(new Error('Synthetic object write failed'));
  expect((await photo(attorney, initial.profilePhotoRevision)).status).toBe(500);
  expect((await read(attorney)).body.profilePhotoRevision).toBe(initial.profilePhotoRevision);
  expect((await StorageDeletionTask.findOne({ reason: 'profile_photo_upload_compensation' })).status).toBe('pending');
});

test('unhide cannot outrun a concurrent paralegal photo removal', async () => {
  await User.updateOne({ _id: attorney._id }, { $set: { role: 'paralegal', profileImage: `/api/users/profile-photo/${attorney._id}`, avatarURL: `/api/users/profile-photo/${attorney._id}`, profilePhotoStatus: 'approved', 'preferences.hideProfile': true } });
  const paralegal = await User.findById(attorney._id);
  const update = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    await update({ _id: attorney._id }, { $set: { profileImage: null, avatarURL: '', profilePhotoStatus: 'unsubmitted' } });
    return update(...args);
  });
  expect((await prefs(paralegal, { hideProfile: false }, { hideProfile: true })).status).toBe(409);
  expect((await User.findById(attorney._id)).preferences.hideProfile).toBe(true);
});

test('preference response reports authoritative readback after a later committed change', async () => {
  const update = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => {
    const result = await update(...args);
    await update({ _id: attorney._id }, { $set: { 'preferences.theme': 'light' } });
    return result;
  });
  const response = await prefs(attorney, { theme: 'dark' }, { theme: 'light' });
  expect(response.status).toBe(200); expect(response.body.preferences.theme).toBe('light');
});

test.each(['', '   ', null, 'ZZ'])('preferences cannot clear or invalidate primary state: %j', async state => {
  expect((await prefs(attorney, { state }, { state: 'NY' })).status).toBe(400);
  expect(await User.findById(attorney._id)).toMatchObject({ state: 'NY', location: 'NY' });
});
