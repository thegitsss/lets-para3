const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { origin, tokens, discover, writePrivate, requestJson } = require('./setup-support-mailbox.cjs');
const settings = { SUPPORT_ZOHO_CLIENT_ID: 'synthetic-client', SUPPORT_ZOHO_CLIENT_SECRET: 'synthetic-secret', SUPPORT_ZOHO_MAILBOX: 'help@lets-paraconnect.com', SUPPORT_ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.zoho.com', SUPPORT_ZOHO_API_BASE_URL: 'https://mail.zoho.com/api' };
const response = data => ({ ok: true, json: async () => data });
test('credentials only go to official HTTPS Zoho origins', () => {
  for (const value of ['http://accounts.zoho.com', 'https://accounts.zoho.com.evil.test', 'https://secret@accounts.zoho.com', 'https://accounts.zoho.com/?secret=x']) assert.throws(() => origin(value, 'accounts'));
  assert.equal(origin('https://accounts.zohocloud.ca', 'accounts'), 'https://accounts.zohocloud.ca');
});
test('authorization exchanges credentials in the request body with redirects disabled', async () => {
  const got = await tokens(settings, 'synthetic-code', async (url, options) => {
    assert.equal(url, 'https://accounts.zoho.com/oauth/v2/token');
    assert.equal(options.redirect, 'error'); assert.equal(options.body.get('client_secret'), 'synthetic-secret');
    return response({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
  });
  assert.equal(got.refresh_token, 'synthetic-refresh');
});
test('discovery uses the exact support mailbox and preserves long IDs without reading messages', async () => {
  const urls = [];
  const ids = await discover(settings, 'synthetic-access', async url => {
    urls.push(url);
    return response({ status: { code: 200 }, data: url.endsWith('/accounts') ? [{ accountId: '1', mailboxAddress: 'someone@example.test' }, { accountId: '9000000000000000011', mailboxAddress: settings.SUPPORT_ZOHO_MAILBOX, emailAddress: [{ mailId: settings.SUPPORT_ZOHO_MAILBOX }] }] : [{ folderId: '9000000000000000012', folderName: 'Inbox' }] });
  });
  assert.deepEqual(ids, { accountId: '9000000000000000011', folderId: '9000000000000000012' });
  assert.equal(urls.length, 2); assert.ok(urls.every(url => !url.includes('messages')));
});
test('a wrong account cannot silently connect', async () => {
  await assert.rejects(discover(settings, 'synthetic-access', async () => response({ status: { code: 200 }, data: [{ mailboxAddress: 'wrong@example.test', accountId: '1' }] })), /owning help/);
});
test('provider exceptions and bodies do not expose credentials in errors', async () => {
  await assert.rejects(requestJson('https://accounts.zoho.com', {}, async () => { throw new Error('synthetic-secret'); }), error => !error.message.includes('synthetic-secret'));
  await assert.rejects(tokens(settings, 'synthetic-code', async () => response({ error_description: 'synthetic-secret' })), error => !error.message.includes('synthetic-secret'));
});
test('private settings persist with owner-only permissions and reject symlinks or newline injection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpc-zoho-setup-test-'));
  try {
    const target = path.join(dir, '.env.private');
    writePrivate({ SUPPORT_ZOHO_REFRESH_TOKEN: 'synthetic-refresh' }, target);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.throws(() => writePrivate({ BAD: 'one\nEVIL=two' }, target));
    assert.ok(fs.readFileSync(target, 'utf8').includes('synthetic-refresh'));
    const link = path.join(dir, 'link'); fs.symlinkSync(target, link);
    assert.throws(() => writePrivate({ BAD: 'value' }, link));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an alias cannot silently expose a different mailbox Inbox', async () => {
  await assert.rejects(discover(settings, 'synthetic-access', async url => response({ status: { code: 200 }, data: url.endsWith('/accounts') ? [{ mailboxAddress: 'different@example.test', accountId: '1', emailAddress: [{ mailId: settings.SUPPORT_ZOHO_MAILBOX }] }] : [{ folderId: '2', folderName: 'Inbox' }] })), /dedicated folder named LPC Support/);
});

test('an alias discovers only its dedicated support folder without reading messages', async () => {
  const urls = [];
  const ids = await discover(settings, 'synthetic-access', async url => {
    urls.push(url);
    return response({ status: { code: 200 }, data: url.endsWith('/accounts') ? [{ mailboxAddress: 'admin@lets-paraconnect.com', accountId: '9000000000000000011', emailAddress: [{ mailId: settings.SUPPORT_ZOHO_MAILBOX }] }] : [{ folderId: '123', folderName: 'Inbox' }, { folderId: '9000000000000000012', folderName: 'LPC Support' }] });
  });
  assert.deepEqual(ids, { accountId: '9000000000000000011', folderId: '9000000000000000012' });
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => !url.includes('messages')));
});

test('ambiguous or imprecise support folders cannot be selected', async () => {
  for (const folders of [
    [{ folderId: '2', folderName: 'LPC Support' }, { folderId: '3', folderName: 'LPC Support' }],
    [{ folderId: 9000000000000000012, folderName: 'LPC Support' }],
  ]) {
    await assert.rejects(discover(settings, 'synthetic-access', async url => response({ status: { code: 200 }, data: url.endsWith('/accounts') ? [{ mailboxAddress: 'admin@lets-paraconnect.com', accountId: '1', emailAddress: [{ mailId: settings.SUPPORT_ZOHO_MAILBOX }] }] : folders })), /dedicated folder named LPC Support/);
  }
});
