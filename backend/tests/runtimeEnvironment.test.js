const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRuntimeEnvironment, SUPPORT_KEYS } = require('../utils/runtimeEnvironment');
const { inspectLocalConfiguration } = require('../scripts/check-local-configuration');

let root;
const saved = {
  ADMIN_ALERT_EMAIL: 'admin@lets-paraconnect.com', SUPPORT_SETUP_VERIFIED: 'true',
  SUPPORT_ZOHO_MAILBOX: 'help@lets-paraconnect.com', SUPPORT_ZOHO_ACCOUNT_ID: '12345',
  SUPPORT_ZOHO_INBOX_FOLDER_ID: '67890', SUPPORT_ZOHO_CLIENT_ID: 'synthetic-id',
  SUPPORT_ZOHO_CLIENT_SECRET: 'synthetic-secret', SUPPORT_ZOHO_REFRESH_TOKEN: 'synthetic-refresh',
  SUPPORT_ZOHO_API_BASE_URL: 'https://mail.zoho.com/api',
  SUPPORT_ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.zoho.com',
};
function write(name, values, mode = 0o600) {
  fs.writeFileSync(path.join(root, name), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'), { mode });
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lpc-runtime-env-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('loads the backend file independently of cwd, preserves process overrides, and resolves operational paths', () => {
  write('.env', { PORT: '5050', EMAIL_BASE_URL: 'http://localhost:5050', BACKUP_STATUS_FILE: './backups/status.json' });
  const env = { NODE_ENV: 'development', PORT: '5051' };
  loadRuntimeEnvironment({ env, root });
  expect(env).toMatchObject({ PORT: '5051', EMAIL_BASE_URL: 'http://localhost:5050', BACKUP_STATUS_FILE: path.join(root, 'backups/status.json') });
});
test('loads only the verified support bundle and approved owner address', () => {
  write('.env.support-setup.local', { ...saved, SMTP_PASS: 'must-not-load' });
  const env = { NODE_ENV: 'development' };
  expect(loadRuntimeEnvironment({ env, root })).toMatchObject({ supportSource: 'verified-local-file' });
  for (const key of SUPPORT_KEYS) expect(env[key]).toBe(saved[key]);
  expect(env.ADMIN_ALERT_EMAIL).toBe(saved.ADMIN_ALERT_EMAIL);
  expect(env.SMTP_PASS).toBeUndefined();
});
test.each([
  { NODE_ENV: 'production' }, { NODE_ENV: 'test' },
  { NODE_ENV: 'development', RENDER: 'true' },
  { NODE_ENV: 'development', RENDER_SERVICE_ID: 'hosted' },
  { NODE_ENV: 'development', STAGING_MONGO_HOST: 'staging.test' },
])('does not load the private support bundle in protected runtimes: %j', env => {
  write('.env.support-setup.local', saved);
  loadRuntimeEnvironment({ env, root });
  expect(env.SUPPORT_ZOHO_CLIENT_SECRET).toBeUndefined();
});
test('tests never inherit workstation env credentials', () => {
  write('.env', { SMTP_PASS: 'must-not-load', MONGO_URI: 'mongodb+srv://must-not-load.test/db' });
  const env = { NODE_ENV: 'test' };
  loadRuntimeEnvironment({ env, root });
  expect(env.SMTP_PASS).toBeUndefined(); expect(env.MONGO_URI).toBeUndefined();
});
test('an incomplete setup is not activated', () => {
  write('.env.support-setup.local', { ...saved, SUPPORT_SETUP_VERIFIED: 'false' });
  const env = { NODE_ENV: 'development' };
  loadRuntimeEnvironment({ env, root });
  expect(env.SUPPORT_ZOHO_CLIENT_SECRET).toBeUndefined();
});
test('rejects exposed or symlinked saved credentials without printing them', () => {
  write('.env.support-setup.local', saved); fs.chmodSync(path.join(root, '.env.support-setup.local'), 0o644);
  expect(() => loadRuntimeEnvironment({ env: {}, root })).toThrow('owner-only regular file');
  fs.renameSync(path.join(root, '.env.support-setup.local'), path.join(root, 'saved'));
  fs.symlinkSync(path.join(root, 'saved'), path.join(root, '.env.support-setup.local'));
  expect(() => loadRuntimeEnvironment({ env: {}, root })).toThrow('owner-only regular file');
});
test('never mixes saved credentials into another explicit support account', () => {
  write('.env.support-setup.local', saved);
  const env = { NODE_ENV: 'development', SUPPORT_ZOHO_ACCOUNT_ID: '99999' };
  loadRuntimeEnvironment({ env, root });
  expect(env.SUPPORT_ZOHO_ACCOUNT_ID).toBe('99999'); expect(env.SUPPORT_ZOHO_REFRESH_TOKEN).toBeUndefined();
});
test('rejects invalid approved addresses and incomplete verified data', () => {
  write('.env.support-setup.local', { ...saved, SUPPORT_ZOHO_MAILBOX: 'other@example.test' });
  expect(() => loadRuntimeEnvironment({ env: {}, root })).toThrow('incomplete');
});

function localEnv() {
  return { ...saved, PORT: '5050', MONGO_URI: 'mongodb://127.0.0.1/lpc_dev',
    EMAIL_BASE_URL: 'http://localhost:5050', OPS_HEALTHCHECK_URL: 'http://localhost:5050/api/health',
    LINKEDIN_OAUTH_REDIRECT_URI: 'http://localhost:5050/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback' };
}
test('reports local URL correctness without confusing configuration with provider or worker proof', () => {
  const report = inspectLocalConfiguration({ env: localEnv(), root, processes: '' });
  expect(report.checks.filter(c => ['email_links', 'health_target', 'support_mailbox'].includes(c.id)).every(c => c.status === 'pass')).toBe(true);
  expect(report.checks.find(c => c.id === 'linkedin_callback').status).toBe('unverified');
  expect(report.checks.find(c => c.id === 'backup').status).toBe('fail');
  expect(report.checks.find(c => c.id === 'process_communications').status).toBe('unverified');
  expect(report.ok).toBe(false);
});
test.each(['EMAIL_BASE_URL', 'OPS_HEALTHCHECK_URL'])('detects wrong-host and wrong-port %s without leaking values', key => {
  for (const value of ['https://production.example.test/private-secret', 'http://localhost:5051']) {
    const env = { ...localEnv(), [key]: value };
    const report = inspectLocalConfiguration({ env, root });
    expect(report.checks.some(c => c.status === 'fail' && c.message.includes(key))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private-secret');
  }
});
test('an existing provider callback on another origin is not classified as a local configuration failure', () => {
  const env = { ...localEnv(), LINKEDIN_OAUTH_REDIRECT_URI: 'https://www.lets-paraconnect.com/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback' };
  const result = inspectLocalConfiguration({ env, root }).checks.find(c => c.id === 'linkedin_callback');
  expect(result.status).toBe('unverified');
  expect(result.message).toContain('Preserve its provider-registered URI');
});
test('an empty status file cannot stand in for an actual backup', () => {
  const env = { ...localEnv(), BACKUP_STATUS_FILE: 'status.json' };
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({ status: 'ok', completedAt: new Date(now).toISOString(), outPath: 'missing.archive', sizeBytes: 5 }));
  expect(inspectLocalConfiguration({ env, root, now }).checks.find(c => c.id === 'backup').status).toBe('fail');
  fs.writeFileSync(path.join(root, 'missing.archive'), 'abcde', { mode: 0o600 });
  expect(inspectLocalConfiguration({ env, root, now }).checks.find(c => c.id === 'backup').status).toBe('pass');
  expect(inspectLocalConfiguration({ env, root, now: now + 40 * 3600000 }).checks.find(c => c.id === 'backup').status).toBe('fail');
});
test('remote database targets block indiscriminate local background startup', () => {
  const target = new URL('mongodb+srv://remote.test/db');
  target.username = 'synthetic';
  target.password = 'secret';
  const report = inspectLocalConfiguration({ env: { ...localEnv(), MONGO_URI: target.href }, root });
  expect(report.checks.find(c => c.id === 'background_safety').status).toBe('fail');
  expect(JSON.stringify(report)).not.toContain('synthetic:secret');
});
