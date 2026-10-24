const { assertStagingEmailRecipients } = require('../utils/stagingEmailBoundary');
const env = { LPC_DEPLOYMENT_ENV: 'staging', STAGING_EMAIL_RECIPIENT: 'admin@lets-paraconnect.com' };

test.each([
  'admin@lets-paraconnect.com',
  'LPC test <admin@lets-paraconnect.com>',
  { name: 'LPC test', address: 'admin@lets-paraconnect.com' },
  ['admin@lets-paraconnect.com', { address: 'ADMIN@LETS-PARACONNECT.COM' }],
  'Test group: admin@lets-paraconnect.com;',
])('accepts only approved recipient forms %#', to => {
  expect(() => assertStagingEmailRecipients(to, {}, env)).not.toThrow();
});

test.each([
  ['test@example.invalid', {}],
  ['admin+test@lets-paraconnect.com', {}],
  ['admin@lets-paraconnect.com, test@example.invalid', {}],
  ['admin@lets-paraconnect.com', { cc: 'test@example.invalid' }],
  ['admin@lets-paraconnect.com', { bcc: [{ address: 'test@example.invalid' }] }],
  ['admin@lets-paraconnect.com', { bcc: 'Recipients: admin@lets-paraconnect.com, test@example.invalid;' }],
  [{ name: 'admin@lets-paraconnect.com', address: 'test@example.invalid' }, {}],
  [[], {}],
  [{ malformed: true }, {}],
])('blocks additional and malformed recipients %#', (to, options) => {
  expect(() => assertStagingEmailRecipients(to, options, env)).toThrow();
});

test('missing or altered staging inbox fails closed', () => {
  for (const inbox of [undefined, '', 'test@example.invalid']) {
    expect(() => assertStagingEmailRecipients('admin@lets-paraconnect.com', {}, { ...env, STAGING_EMAIL_RECIPIENT: inbox })).toThrow();
  }
});

test('boundary configuration cannot silently run outside staging', () => {
  expect(() => assertStagingEmailRecipients('admin@lets-paraconnect.com', {}, { STAGING_EMAIL_RECIPIENT: env.STAGING_EMAIL_RECIPIENT })).toThrow();
});

test('existing production delivery without staging configuration retains its recipient contract', () => {
  expect(() => assertStagingEmailRecipients('user@example.invalid', { cc: 'another@example.invalid' }, { NODE_ENV: 'production' })).not.toThrow();
});

test('staging remains restricted with production runtime settings', () => {
  expect(() => assertStagingEmailRecipients('user@example.invalid', {}, { ...env, NODE_ENV: 'production' })).toThrow();
});

test('the actual send API blocks recipients before any transport connection', async () => {
  const previous = { ...process.env };
  const verify = jest.fn(), sendMail = jest.fn();
  let create;
  try {
    Object.assign(process.env, env, { EMAIL_DISABLE: 'false' });
    let send;
    jest.isolateModules(() => {
      create = jest.spyOn(require('nodemailer'), 'createTransport').mockReturnValue({ verify, sendMail, close: jest.fn() });
      send = require('../utils/email');
    });
    const baseline = create.mock.calls.length;
    const result = await send('test@example.invalid', 'Test', '<p>Test</p>', { smtp: { host: 'example.invalid' } });
    expect(result).toMatchObject({ error: true, code: 'STAGING_EMAIL_RECIPIENT_BLOCKED' });
    await expect(send('admin@lets-paraconnect.com', 'Test', '<p>Test</p>', { bcc: 'test@example.invalid', throwOnError: true })).rejects.toMatchObject({ code: 'STAGING_EMAIL_RECIPIENT_BLOCKED', responseCode: 550 });
    expect(create).toHaveBeenCalledTimes(baseline);
    expect(verify).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  } finally {
    process.env = previous;
    create?.mockRestore();
  }
});


// Synthetic-only leased transport. No SMTP or provider connection is opened.
const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
function loadConfig(change = {}, leaseChange = {}) {
  const namespace = 'lpc-load-12345678-1234-1234-1234-123456789abc';
  const now = Date.now();
  const lease = {
    version: 1, purpose: 'lpc36-synthetic-smtp', namespace,
    startsAtUtc: new Date(now - 1000).toISOString(), expiresAtUtc: new Date(now + 600000).toISOString(),
    ownerDecisionSha256: digest('offline synthetic decision fixture, not execution authority'),
    productionAuthorized: false, maximumMessages: 200, maximumBytes: 2 * 1024 * 1024,
    webServiceId: 'srv-d10gdh24d50c73ap2p60', serviceIds: ['srv-d10gdh24d50c73ap2p60', 'srv-syntheticworker'],
    serviceIdentityReadbackSha256: digest('offline synthetic exact owner role ID readback, not provider evidence'),
    commit: '2'.repeat(40), appOrigin: 'https://lets-paraconnect-backend.onrender.com',
    databaseHost: 'isolated.mongodb.net', productionDatabaseHostSha256: digest('production.mongodb.net'),
    databaseName: 'lpc_staging_l_' + digest(namespace).slice(0, 24),
    smtpHost: 'lpc-staging-owned', smtpPort: 2525, smtpPasswordSha256: digest('synthetic-only-password-never-transmitted-1234'),
    recipients: [env.STAGING_EMAIL_RECIPIENT, namespace + '.actor1@example.test', namespace + '.signup1@example.test'],
    ...leaseChange,
  };
  const uri = new URL('mongodb+srv://' + lease.databaseHost + '/' + lease.databaseName);
  uri.username = 'synthetic'; uri.password = 'synthetic-not-sent';
  const raw = JSON.stringify(lease);
  return {
    ...env, NODE_ENV: 'staging', PROD: 'true', APP_BASE_URL: lease.appOrigin,
    STAGING_RENDER_SERVICE_ID: lease.webServiceId, RENDER_SERVICE_ID: lease.webServiceId,
    RENDER_GIT_COMMIT: lease.commit, RENDER_DISCOVERY_SERVICE: lease.smtpHost + '-discovery',
    MONGO_URI: uri.toString(), STAGING_MONGO_HOST: lease.databaseHost,
    SMTP_HOST: lease.smtpHost, SMTP_PORT: '2525', SMTP_SECURE: 'false', SMTP_USER: namespace,
    SMTP_PASS: 'synthetic-only-password-never-transmitted-1234', SMTP_FROM_EMAIL: namespace + '.from@example.test',
    EMAIL_SKIP_VERIFY: 'true', EMAIL_DISABLE: 'false',
    LPC_STAGING_SMTP_LOAD_LEASE: raw, LPC_STAGING_SMTP_LOAD_LEASE_SHA256: digest(raw), ...change,
  };
}
function ownedRecipient(e) { return JSON.parse(e.LPC_STAGING_SMTP_LOAD_LEASE).recipients[1]; }

test('exact fresh owned lease permits only enumerated recipients on the existing private web sink', () => {
  const e = loadConfig();
  expect(() => assertStagingEmailRecipients(ownedRecipient(e), { cc: env.STAGING_EMAIL_RECIPIENT }, e)).not.toThrow();
  expect(() => assertStagingEmailRecipients(env.STAGING_EMAIL_RECIPIENT, {}, e)).not.toThrow();
  expect(() => assertStagingEmailRecipients(ownedRecipient(e), {}, { ...e, RENDER_SERVICE_ID: 'srv-syntheticworker' })).not.toThrow();
  expect(() => assertStagingEmailRecipients(ownedRecipient(e).replace('actor1', 'actor2'), {}, e)).toThrow();
  expect(() => assertStagingEmailRecipients(ownedRecipient(e), { bcc: 'outside@example.test' }, e)).toThrow();
});

test.each([
  ['LPC_DEPLOYMENT_ENV', 'production'], ['NODE_ENV', 'production'], ['PROD', 'false'],
  ['STAGING_RENDER_SERVICE_ID', 'srv-other'], ['RENDER_SERVICE_ID', 'srv-other'],
  ['RENDER_GIT_COMMIT', '3'.repeat(40)], ['APP_BASE_URL', 'https://www.lets-paraconnect.com'],
  ['STAGING_MONGO_HOST', 'other.mongodb.net'], ['MONGODB_URI', 'mongodb+srv://other.mongodb.net/letspara'],
  ['SMTP_HOST', 'external.example.com'], ['SMTP_PORT', '587'], ['SMTP_SECURE', 'true'],
  ['SMTP_USER', 'somebody-else'], ['SMTP_PASS', 'changed'], ['EMAIL_SKIP_VERIFY', 'false'],
  ['EMAIL_DISABLE', 'true'], ['SMTP_FROM_EMAIL', 'outside@example.test'],
  ['RENDER_DISCOVERY_SERVICE', 'another-service-discovery'],
  ['LPC_STAGING_SMTP_LOAD_LEASE_SHA256', '0'.repeat(64)], ['LPC_STAGING_SMTP_LOAD_LEASE', '{}'],
])('leased SMTP fails closed when exact runtime binding changes: %s', (key, value) => {
  const e = loadConfig({ [key]: value });
  expect(() => assertStagingEmailRecipients(env.STAGING_EMAIL_RECIPIENT, {}, e)).toThrow();
});

test.each([
  { startsAtUtc: new Date(Date.now() + 60000).toISOString() },
  { expiresAtUtc: new Date(Date.now() - 1).toISOString() },
  { expiresAtUtc: new Date(Date.now() + 21 * 60 * 1000).toISOString() },
  { productionAuthorized: true }, { maximumMessages: 201 }, { maximumBytes: 3 * 1024 * 1024 },
  { databaseName: 'letspara' }, { productionDatabaseHostSha256: digest('isolated.mongodb.net') },
  { smtpHost: 'public.example.com' }, { smtpHost: '127.0.0.1' }, { smtpHost: 'localhost' },
  { recipients: [env.STAGING_EMAIL_RECIPIENT, 'outside@example.test'] },
  { recipients: Array.from({ length: 47 }, () => env.STAGING_EMAIL_RECIPIENT) },
  { serviceIds: ['srv-d10gdh24d50c73ap2p60', 'srv-d10gdh24d50c73ap2p60'] },
])('lease content is bounded and rejects unsafe scope %#', change => {
  const e = loadConfig({}, change);
  expect(() => assertStagingEmailRecipients(env.STAGING_EMAIL_RECIPIENT, {}, e)).toThrow();
});

test('active lease is checked on every call, including after startup and after expiration', () => {
  const e = loadConfig();
  expect(() => assertStagingEmailRecipients(ownedRecipient(e), {}, e)).not.toThrow();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(JSON.parse(e.LPC_STAGING_SMTP_LOAD_LEASE).expiresAtUtc));
  try { expect(() => assertStagingEmailRecipients(ownedRecipient(e), {}, e)).toThrow(); }
  finally { clock.mockRestore(); }
});

test.each(['smtp', 'envelope', 'transport'])('leased recipients cannot escape through a custom %s', key => {
  const e = loadConfig();
  expect(() => assertStagingEmailRecipients(ownedRecipient(e), { [key]: { host: 'external.example.com' } }, e)).toThrow();
});

test('actual send API refuses a leased transport override before verification or SMTP creation', async () => {
  const previous = { ...process.env }, verify = jest.fn(), sendMail = jest.fn();
  let create;
  try {
    const e = loadConfig(); Object.assign(process.env, e);
    let send;
    jest.isolateModules(() => {
      create = jest.spyOn(require('nodemailer'), 'createTransport').mockReturnValue({ verify, sendMail, close: jest.fn() });
      send = require('../utils/email');
    });
    const baseline = create.mock.calls.length;
    await expect(send(ownedRecipient(e), 'Synthetic only', '<p>Test</p>', { smtp: { host: 'external.example.com' }, throwOnError: true })).rejects.toMatchObject({ code: 'STAGING_EMAIL_LOAD_LEASE_INVALID' });
    expect(create).toHaveBeenCalledTimes(baseline); expect(verify).not.toHaveBeenCalled(); expect(sendMail).not.toHaveBeenCalled();
  } finally { process.env = previous; create?.mockRestore(); }
});


test('exact reviewed cron roles may use the same sink lease, while unknown cron IDs remain blocked', () => {
  const ids = ['srv-d10gdh24d50c73ap2p60', 'srv-syntheticworker', 'crn-db8h4d2jnfac73foqau0', 'crn-db8h4divcj2c73acrvu0'];
  for (const id of ids.slice(2)) {
    const e = loadConfig({ RENDER_SERVICE_ID: id }, { serviceIds: ids });
    expect(() => assertStagingEmailRecipients(ownedRecipient(e), {}, e)).not.toThrow();
  }
  const bad = loadConfig({ RENDER_SERVICE_ID: 'crn-unreviewed' }, { serviceIds: [...ids, 'crn-unreviewed'] });
  expect(() => assertStagingEmailRecipients(env.STAGING_EMAIL_RECIPIENT, {}, bad)).toThrow();
});


test('recreated cron requires exact reviewed lease membership and fresh provider identity evidence', () => {
  const recreated = 'crn-12345678901234567890';
  const e = loadConfig({ RENDER_SERVICE_ID: recreated }, { serviceIds: ['srv-d10gdh24d50c73ap2p60', recreated] });
  expect(() => assertStagingEmailRecipients(ownedRecipient(e), {}, e)).not.toThrow();
  expect(() => assertStagingEmailRecipients(ownedRecipient(e), {}, { ...e, RENDER_SERVICE_ID: 'crn-22345678901234567890' })).toThrow();
  for (const value of [undefined, '', 'not-a-receipt-digest']) {
    const missing = loadConfig({}, { serviceIdentityReadbackSha256: value });
    expect(() => assertStagingEmailRecipients(env.STAGING_EMAIL_RECIPIENT, {}, missing)).toThrow();
  }
});
