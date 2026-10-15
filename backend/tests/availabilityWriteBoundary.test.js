const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const User = require('../models/User');
const { effectiveAvailability } = require('../utils/availability');
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api/paralegals', require('../routes/paralegals'));
let first, second;
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => {
  await clearDatabase();
  [first, second] = await User.create(['first', 'second'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@availability-boundary.test`, password: 'Synthetic123!', role: 'paralegal', status: 'approved', availability: 'Available now', availabilityDetails: { status: 'available', nextAvailable: null, updatedAt: new Date('2026-09-01T12:00:00Z') } })));
});
afterEach(() => jest.restoreAllMocks());
const save = (actor, body) => request(app).post('/api/paralegals/update-availability').set('Cookie', authCookieFor(actor)).send(body);
const input = user => ({ expectedOwnerId: String(user._id), expectedValues: { availability: effectiveAvailability(user) }, status: 'unavailable', nextAvailable: null });

test('a switched signed-in account cannot receive an availability change intended for the prior account', async () => {
  const before = await User.collection.findOne({ _id: second._id });
  const response = await save(second, input(first)); expect(response.status).toBe(403); expect(response.body.code).toBe('ACCOUNT_CHANGED');
  expect(await User.collection.findOne({ _id: second._id })).toEqual(before);
});

test('concurrent availability edits based on one projection have one winner and a visible conflict', async () => {
  const original = input(first);
  const responses = await Promise.all([save(first, original), save(first, { ...original, status: 'available' })]);
  expect(responses.map(result => result.status).sort()).toEqual([200, 409]);
  const winner = responses.find(result => result.status === 200);
  expect(winner.body.ownerId).toBe(String(first._id));
  const stored = await User.findById(first._id);
  expect(effectiveAvailability(stored)).toEqual({ availability: winner.body.availability, availabilityDetails: { ...winner.body.availabilityDetails, updatedAt: new Date(winner.body.availabilityDetails.updatedAt) } });
});

test('an unbound availability write is refused without changing the profile', async () => {
  const before = await User.collection.findOne({ _id: first._id });
  const response = await save(first, { status: 'unavailable', nextAvailable: null });
  expect(response.status).toBe(400); expect(response.body.code).toBe('ACCOUNT_GUARD_INVALID');
  expect(await User.collection.findOne({ _id: first._id })).toEqual(before);
});

test('a changed availability record between read and atomic update cannot be overwritten', async () => {
  const update = User.findOneAndUpdate.bind(User);
  jest.spyOn(User, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await User.collection.updateOne({ _id: first._id }, { $set: { availability: 'Unavailable', 'availabilityDetails.status': 'unavailable', 'availabilityDetails.updatedAt': new Date('2026-09-02T12:00:00Z') } });
    return update(...args);
  });
  const response = await save(first, input(first)); expect(response.status).toBe(409);
  const stored = await User.findById(first._id); expect(stored.availabilityDetails.updatedAt.toISOString()).toBe('2026-09-02T12:00:00.000Z');
});

test('independent profile changes survive an availability save', async () => {
  await User.collection.updateOne({ _id: first._id }, { $set: { bio: 'Independent profile edit', 'preferences.theme': 'dark' } });
  const response = await save(first, input(first)); expect(response.status).toBe(200);
  const stored = await User.findById(first._id); expect(stored.bio).toBe('Independent profile edit'); expect(stored.preferences.theme).toBe('dark');
});

test('today returns an effective available receipt and the new projection can be saved again', async () => {
  const { dateOnlyFromZonedInstant } = require('../utils/businessDate');
  const response = await save(first, { ...input(first), nextAvailable: dateOnlyFromZonedInstant(new Date()) });
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ ownerId: String(first._id), availability: 'Available now', availabilityDetails: { status: 'available', nextAvailable: null } });
  const next = await save(first, { ...input(first), expectedValues: { availability: { availability: response.body.availability, availabilityDetails: response.body.availabilityDetails } } });
  expect(next.status).toBe(200); expect(next.body.availabilityDetails.status).toBe('unavailable');
});

test('a missing displayed-value precondition and invalid dates do not change availability', async () => {
  const before = await User.collection.findOne({ _id: first._id });
  expect((await save(first, { expectedOwnerId: String(first._id), status: 'unavailable' })).status).toBe(400);
  expect((await save(first, { ...input(first), nextAvailable: '2026-02-30' })).status).toBe(400);
  expect(await User.collection.findOne({ _id: first._id })).toEqual(before);
});
