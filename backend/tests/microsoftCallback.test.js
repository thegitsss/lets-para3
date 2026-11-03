const request = require('supertest');
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../services/microsoftAuthProvider', () => ({...jest.requireActual('../services/microsoftAuthProvider'), exchange:jest.fn()}));
const {exchange}=require('../services/microsoftAuthProvider');
const { buildTestApp } = require('./helpers/testApp');
const app = buildTestApp();
const sendEmail = require('../utils/email');
const previous = Object.fromEntries(['MICROSOFT_AUTH_CLIENT_ID', 'MICROSOFT_AUTH_CLIENT_SECRET', 'MICROSOFT_AUTH_REDIRECT_URI'].map(key => [key, process.env[key]]));
beforeAll(async () => {
  Object.assign(process.env, { MICROSOFT_AUTH_CLIENT_ID: 'isolated-client', MICROSOFT_AUTH_CLIENT_SECRET: 'isolated-secret', MICROSOFT_AUTH_REDIRECT_URI: 'https://lpc.invalid/api/auth/microsoft/callback' });
  await connect();
});
beforeEach(async () => { await clearDatabase(); jest.clearAllMocks(); sendEmail.mockResolvedValue({ ok: true }); });
afterAll(async () => {
  await closeDatabase();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
async function callback({ profile = {}, fail = false, next = '/attorney-v2.html#/matters?view=active' } = {}) {
  const start = await request(app).get('/api/auth/microsoft').query({ intent: 'login', next });
  expect(start.status).toBe(302);
  const authorization = new URL(start.headers.location);
  const cookie = start.headers['set-cookie'].find(value => value.startsWith('lpc_microsoft_oauth=')).split(';')[0];
  const provider = {};
  exchange.mockImplementation(async (_code,_config,context)=>{if(fail)throw Error('Synthetic provider secret');return {sub:'provider-user-123',email:'microsoft@example.com',email_verified:false,given_name:'Jordan',family_name:'Lee',nonce:context.nonce,...profile};});
  const response = await request(app).get('/api/auth/microsoft/callback').query({ state: authorization.searchParams.get('state'), code: 'isolated-code' }).set('Cookie', cookie);
  return { response, provider };
}
async function account(overrides = {}) {
  return User.create({ firstName: 'Jordan', lastName: 'Lee', email: 'microsoft@example.com', password: 'A unique isolated passphrase', role: 'attorney', status: 'approved', emailVerified: true, authProviders: [{ provider: 'microsoft', providerAccountId: 'provider-user-123' }], ...overrides });
}
test('a verified linked account establishes a managed session and preserves its permitted return', async () => {
  const user = await account();
  const { response, provider } = await callback();
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe('/attorney-v2.html#/matters?view=active');
  expect(exchange).toHaveBeenCalledWith('isolated-code',expect.objectContaining({clientId:'isolated-client'}),expect.objectContaining({nonce:expect.any(String),codeVerifier:expect.any(String)}));
  const cookie = response.headers['set-cookie'].find(value => value.startsWith('token=')).split(';')[0];
  const session = await request(app).get('/api/auth/me').set('Cookie', cookie);
  expect(session.body.user.id).toBe(String(user._id));
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(1);
});
test.each([
  [{ status: 'pending' }, 'pending'],
  [{ disabled: true }, 'disabled'],
])('linked account restrictions remain authoritative: %j', async (overrides, error) => {
  await account(overrides);
  const { response } = await callback();
  expect(new URL(response.headers.location, 'https://lpc.invalid').searchParams.get('microsoft_error')).toBe(error);
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('a matching email alone cannot link an existing account or establish a session', async () => {
  const user = await account({ authProviders: [] });
  const { response } = await callback();
  expect(response.headers.location).toContain('microsoft_error=matching_email_unlinked');
  expect((await User.findById(user._id).select('+authProviders')).authProviders).toHaveLength(0);
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('a new verified identity receives signup context without platform access', async () => {
  const { response } = await callback();
  expect(response.headers.location).toBe('/signup.html?microsoft=1&role=attorney');
  const cookies = response.headers['set-cookie'].map(value => value.split(';')[0]);
  const context = await request(app).get('/api/auth/microsoft/signup-profile').set('Cookie', cookies);
  expect(context.body.profile).toMatchObject({ firstName: 'Jordan', lastName: 'Lee', email: 'microsoft@example.com', emailVerified: false });
  expect(await User.countDocuments({})).toBe(0);
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test.each([{ nonce: 'wrong-nonce' }, { sub:'' }])('invalid provider identity grants no access: %j', async profile => {
  await account();
  const { response } = await callback({ profile });
  expect(response.headers.location).toContain('microsoft_error=identity_invalid');
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('provider failure returns to sign-in without exposing provider details', async () => {
  const { response } = await callback({ fail: true });
  expect(response.headers.location).toContain('microsoft_error=oauth_failed');
  expect(JSON.stringify(response.headers)).not.toContain('Synthetic provider secret');
  expect(await AuthSession.countDocuments({})).toBe(0);
});
test('Microsoft two-step sign-in creates no session until the emailed code is verified', async () => {
  const user = await account({ twoFactorEnabled: true, twoFactorMethod: 'email' });
  const { response } = await callback();
  expect(response.headers.location).toContain('microsoft_2fa=1');
  expect(await AuthSession.countDocuments({})).toBe(0);
  const context = await request(app).get('/api/auth/microsoft/2fa-context').set('Cookie', response.headers['set-cookie'].map(value => value.split(';')[0]));
  expect(context.body.method).toBe('email');
  const mail = sendEmail.mock.calls.find(call => call[1] === 'Your verification code');
  const code = mail[3].text.match(/code is (\d{6})/)[1];
  const verified = await request(app).post('/api/auth/2fa-verify').send({ challengeToken: context.body.challengeToken, code });
  expect(verified.status).toBe(200);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(1);
  const reused = await request(app).post('/api/auth/2fa-verify').send({ challengeToken: context.body.challengeToken, code });
  expect(reused.status).toBe(400);
});
for (const method of ['microsoft', 'password']) test.each([{ error: true }, { disabled: true }, { accepted: [] }])(`${method} two-step delivery failure does not claim a code was sent: %j`, async delivery => {
  const user = await account({ twoFactorEnabled: true, twoFactorMethod: 'email' });
  sendEmail.mockResolvedValue(delivery);
  if (method === 'microsoft') {
    const { response } = await callback();
    expect(response.headers.location).toContain('microsoft_error=two_factor_unavailable');
  } else {
    const response = await request(app).post('/api/auth/login').send({ email: user.email, password: 'A unique isolated passphrase' });
    expect(response.status).toBe(500);
    expect(response.body.twoFactorRequired).toBeUndefined();
  }
  const saved = await User.findById(user._id).select('+twoFactorChallengeHash +twoFactorTempCode');
  expect(saved.twoFactorChallengeHash).toBeFalsy();
  expect(saved.twoFactorTempCode).toBeFalsy();
  expect(await AuthSession.countDocuments({})).toBe(0);
});

test.each(['attorney', 'paralegal'])('an approved unverified linked %s can sign in without changing email verification', async role => {
  const user = await account({ role, emailVerified: false });
  const { response } = await callback({ next: `/${role}-v2.html#/home` });
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe(`/${role}-v2.html#/home`);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(1);
  expect((await User.findById(user._id)).emailVerified).toBe(false);
});

test('Microsoft signup can suggest an email without asserting ownership or granting access',async()=>{
 const {response}=await callback({profile:{email:''}});
 const context=await request(app).get('/api/auth/microsoft/signup-profile').set('Cookie',response.headers['set-cookie'].map(v=>v.split(';')[0]));
 expect(context.body.profile).toMatchObject({email:'',emailVerified:false});
 expect(await User.countDocuments({})).toBe(0);
});
test('Microsoft authorization uses state, nonce and an S256 proof key without exposing its verifier',async()=>{
 const response=await request(app).get('/api/auth/microsoft?intent=signup&role=paralegal');
 const url=new URL(response.headers.location);
 expect(url.origin).toBe('https://login.microsoftonline.com');
 expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
 expect(url.searchParams.get('code_challenge_method')).toBe('S256');
 expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
 expect(url.searchParams.has('code_verifier')).toBe(false);
 expect(url.searchParams.get('nonce')).toBeTruthy();
});
test('a new Microsoft applicant must complete LPC requirements and verify their chosen email',async()=>{
 const {currentPolicyMetadata}=require('../utils/legalDocuments');
 const {response}=await callback();
 const cookies=response.headers['set-cookie'].map(v=>v.split(';')[0]);
 const payload={firstName:'Jordan',lastName:'Lee',email:'chosen@example.com',password:'An isolated strong registration passphrase',role:'attorney',state:'CA',barState:'CA',barNumber:'123456',attorneyGoodStanding:true,attorneyPricingAccepted:true,termsAccepted:true,privacyAcknowledged:true,termsHash:currentPolicyMetadata().terms.hash,privacyHash:currentPolicyMetadata().privacy.hash,oauthSignupProvider:'microsoft'};
 const denied=await request(app).post('/api/auth/register').set('Cookie',cookies).send({...payload,attorneyGoodStanding:false});
 expect(denied.status).toBe(400);
 const submitted=await request(app).post('/api/auth/register').set('Cookie',cookies).send(payload);
 expect({status:submitted.status,body:submitted.body}).toMatchObject({status:200,body:{emailVerified:false}});
 const saved=await User.findOne({email:'chosen@example.com'}).select('+authProviders');
 expect(saved.status).toBe('pending');expect(saved.emailVerified).toBe(false);
 expect((await request(app).get('/api/auth/microsoft/signup-profile').set('Cookie',cookies)).body.profile.signInAccountNotFound).toBe(true);
 expect(saved.authProviders).toEqual(expect.arrayContaining([expect.objectContaining({provider:'microsoft',providerAccountId:'provider-user-123'})]));
 expect(sendEmail.mock.calls.some(call=>call[1]==='Verify your email')).toBe(true);
 expect(await AuthSession.countDocuments({})).toBe(0);
 const pending=await callback();
 expect(pending.response.headers.location).toContain('microsoft_error=pending');
 expect(await AuthSession.countDocuments({})).toBe(0);
 saved.status='approved';saved.approvedAt=new Date();await saved.save();
 const approved=await callback();
 expect(approved.response.headers.location).toBe('/attorney-v2.html#/matters?view=active');
 const sessionCookie=approved.response.headers['set-cookie'].find(v=>v.startsWith('token=')).split(';')[0];
 const session=await request(app).get('/api/auth/me').set('Cookie',sessionCookie);
 expect(session.status).toBe(200);expect(session.body.user.id).toBe(String(saved._id));
 expect(await AuthSession.countDocuments({userId:saved._id})).toBe(1);
});
