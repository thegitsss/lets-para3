const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const User = require('../models/User');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));
app.use('/api/users', require('../routes/users'));
app.use('/api/account', require('../routes/account'));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, status: 'approved' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const stored = user => User.collection.findOne({ _id: user._id });
const retainedFields = ['email', 'password', 'role', 'status', 'preferences', 'notificationPrefs', 'notifications', 'onboarding', 'resumeURL', 'certificateURL', 'writingSampleURL', 'profileImage', 'profilePhotoStatus', 'linkedInURL', 'firmWebsite', 'education', 'experience', 'languages', 'stateExperience', 'createdAt'];
const preserved = user => Object.fromEntries(retainedFields.map(field => [field, user[field]]));

beforeAll(connect, 90000);
afterAll(closeDatabase);
beforeEach(clearDatabase);

async function seed(role = 'paralegal') {
  const user = await User.create({
    firstName: 'Existing', lastName: 'Professional', email: `${role}@example.test`,
    password: 'Synthetic account preservation passphrase!', role, status: 'approved', emailVerified: true,
    state: 'CA', bio: 'Retained biography', about: 'Retained biography',
    profileImage: 'profile-photos/retained.jpg', profilePhotoStatus: 'approved',
    education: [{ school: 'Retained College', degree: 'B.A.' }],
    experience: [{ title: 'Paralegal', years: '2020–2026', description: 'Retained work history' }],
    languages: [{ name: 'English', proficiency: 'Native' }], stateExperience: ['CA', 'NY'],
    onboarding: { attorneyTourCompleted: true, attorneyProfileCompleted: true, paralegalTourCompleted: true, paralegalProfileTourCompleted: true, paralegalTours: { 'profile-v1': 'dismissed' } },
  });
  await User.collection.updateOne({ _id: user._id }, { $set: {
    'preferences.theme': 'retired-dashboard-dark', 'preferences.fontSize': 'lg', 'preferences.hideProfile': true,
    'notificationPrefs.email': false,
    linkedInURL: 'linkedin.com/in/retained-professional', firmWebsite: 'retained.example.test',
    resumeURL: `paralegal-resumes/${user._id}/retained.pdf`,
    certificateURL: `paralegal-certificates/${user._id}/retained.pdf`,
    writingSampleURL: `paralegal-writing-samples/${user._id}/retained.pdf`,
  } });
  return user;
}

describe.each(['attorney', 'paralegal'])('%s retained account', role => {
  test('an older password can sign in and upgrade without changing profile or preferences', async () => {
    const user = await seed(role);
    const password = 'Synthetic account preservation passphrase!';
    await User.collection.updateOne({ _id: user._id }, { $set: { password: await require('bcryptjs').hash(password, 4) } });
    const before = await stored(user);
    const response = await request(app).post('/api/auth/login').send({ email: user.email, password });
    expect(response.status).toBe(200);
    const after = await stored(user);
    expect(after.password).toMatch(/^\$argon2/);
    expect(after.lastLoginAt).toBeInstanceOf(Date);
    const withoutPassword = value => { const copy = preserved(value); delete copy.password; return copy; };
    expect(withoutPassword(after)).toEqual(withoutPassword(before));
  });

  test.each([false, true])('profile saves preserve stored details with guarded=%s', async guarded => {
    const user = await seed(role), before = await stored(user);
    const response = await request(app).patch('/api/users/me').set('Cookie', cookie(user)).send({
      bio: 'Deliberate updated biography',
      ...(guarded ? { expectedOwnerId: String(user._id), expectedValues: { bio: before.bio, about: before.about } } : {}),
    });
    expect(response.status).toBe(200);
    const after = await stored(user);
    expect(after.bio).toBe('Deliberate updated biography');
    expect(preserved(after)).toEqual(preserved(before));
    const nextSession = await request(app).get('/api/users/me').set('Cookie', cookie(user));
    expect(nextSession.status).toBe(200);
    expect(nextSession.body.bio).toBe(after.bio);
    expect(preserved(await stored(user))).toEqual(preserved(before));
  });

  test('changing text size retains historical theme and all unrelated account details', async () => {
    const user = await seed(role), before = await stored(user);
    const response = await request(app).post('/api/account/preferences').set('Cookie', cookie(user)).send({
      expectedOwnerId: String(user._id), expectedValues: { fontSize: 'lg' }, fontSize: 'xl',
    });
    expect(response.status).toBe(200);
    const after = await stored(user);
    expect(after.preferences).toEqual({ ...before.preferences, fontSize: 'xl' });
    expect(preserved(after)).toEqual({ ...preserved(before), preferences: after.preferences });
  });
});

test('tour saves reject a changed signed-in owner without altering either account', async () => {
  const user = await seed(), before = await stored(user);
  const response = await request(app).patch('/api/users/me/onboarding').set('Cookie', cookie(user)).send({
    expectedOwnerId: '650000000000000000000099', paralegalTours: { 'welcome-v1': 'completed' },
  });
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('ACCOUNT_CHANGED');
  expect(await stored(user)).toEqual(before);
});

test.each([false, true])('tour progress preserves profile, preferences and previous tours with guarded=%s', async guarded => {
  const user = await seed(), before = await stored(user);
  const response = await request(app).patch('/api/users/me/onboarding').set('Cookie', cookie(user)).send({
    ...(guarded ? { expectedOwnerId: String(user._id) } : {}), paralegalTours: { 'browse-v1': 'completed' },
  });
  expect(response.status).toBe(200);
  expect(response.body.onboarding.paralegalTours).toMatchObject({ 'profile-v1': 'dismissed', 'browse-v1': 'completed' });
  const after = await stored(user);
  expect(preserved(after)).toEqual({ ...preserved(before), onboarding: { ...before.onboarding, paralegalTours: { ...before.onboarding.paralegalTours, 'browse-v1': 'completed' } } });
});
