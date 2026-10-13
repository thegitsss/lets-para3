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
