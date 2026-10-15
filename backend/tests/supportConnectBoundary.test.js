const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/s3Client', () => ({ createS3Client: () => ({ send: async () => { throw Error('Unexpected storage call'); } }) }));
jest.mock('../utils/stripe', () => ({
  accounts: { create: jest.fn() },
  accountLinks: { create: jest.fn(async () => ({ url: 'https://connect.stripe.com/setup/synthetic-only' })) },
}));
const User = require('../models/User');
const { createAuthSession } = require('../services/authSessionService');
const stripe = require('../utils/stripe');
const app = express();
app.use(cookieParser(), express.json());
app.use('/api/payments', require('../routes/payments'));
let owner, other, ownerCookie, otherCookie;
async function cookie(user) {
  const session = await createAuthSession(user, {});
  return `token=${jwt.sign({ id: String(user._id), role: user.role, av: user.authVersion || 0, sid: session.sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
}
beforeAll(connect, 90000);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other] = await User.create(['owner', 'other'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@connect-boundary.test`, password: 'Synthetic123!', role: 'paralegal', status: 'approved', stripeAccountId: `acct_synthetic_${name}` })));
  ownerCookie = await cookie(owner); otherCookie = await cookie(other);
});
const binding = () => ({ expectedOwnerId: String(owner._id), expectedRole: 'paralegal' });
const post = (body, auth = ownerCookie) => request(app).post('/api/payments/connect').set('Cookie', auth).send(body);
test.each(['guarded', 'legacy'])('%s Connect keeps the authenticated account destination', async mode => {
  const response = await post(mode === 'guarded' ? binding() : {});
  expect(response.status).toBe(200);
  expect(response.body.url).toBe('https://connect.stripe.com/setup/synthetic-only');
  expect(stripe.accountLinks.create).toHaveBeenCalledTimes(1);
  expect(stripe.accountLinks.create.mock.calls[0][0].account).toBe(owner.stripeAccountId);
  expect(stripe.accounts.create).not.toHaveBeenCalled();
});
test('replacement credentials cannot create a link for the new account from the old Assistant', async () => {
  const response = await post(binding(), otherCookie);
  expect(response.status).toBe(403); expect(response.body.code).toBe('SUPPORT_ACCOUNT_CHANGED');
  expect(stripe.accountLinks.create).not.toHaveBeenCalled(); expect(stripe.accounts.create).not.toHaveBeenCalled();
});
test.each([{ expectedRole: 'paralegal' }, { expectedOwnerId: 'invalid', expectedRole: 'paralegal' }, { expectedOwnerId: '111111111111111111111111' }])('malformed binding cannot begin provider work: %j', async body => {
  expect((await post(body)).status).toBe(400);
  expect(stripe.accountLinks.create).not.toHaveBeenCalled(); expect(stripe.accounts.create).not.toHaveBeenCalled();
});
test('a stale role binding cannot begin provider work', async () => {
  expect((await post({ ...binding(), expectedRole: 'attorney' })).status).toBe(403);
  expect(stripe.accountLinks.create).not.toHaveBeenCalled();
});
