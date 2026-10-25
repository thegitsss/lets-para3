const addressParser = require('nodemailer/lib/addressparser');
const { createHash } = require('node:crypto');

const APPROVED_INBOX = 'admin@lets-paraconnect.com';

function boundaryError(code) {
  const error = new Error('Staging email is restricted to the approved test inbox.');
  error.code = code;
  // A pre-transport rejection is definite; the durable delivery owner may
  // retain the failed attempt without treating it as uncertain acceptance.
  error.responseCode = 550;
  error.command = 'RCPT TO';
  return error;
}

function addresses(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(addresses);
  if (typeof value === 'string') return addressParser(value).flatMap(addresses);
  if (value && Array.isArray(value.group)) return value.group.flatMap(addresses);
  if (value && typeof value.address === 'string') return [value.address.trim().toLowerCase()];
  throw boundaryError('STAGING_EMAIL_RECIPIENT_BLOCKED');
}


// Optional LPC-36 test-mail lease. The approved runtime configuration and the
// owned sink enforce separate global request/byte caps; this boundary never
// represents a synthetic sink acknowledgement as external email delivery.
function syntheticLoadRecipients(options, env) {
  const fail = () => { throw boundaryError('STAGING_EMAIL_LOAD_LEASE_INVALID'); };
  const raw = env.LPC_STAGING_SMTP_LOAD_LEASE;
  const digest = value => createHash('sha256').update(value).digest('hex');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384 ||
      !/^[a-f0-9]{64}$/.test(env.LPC_STAGING_SMTP_LOAD_LEASE_SHA256 || '') ||
      digest(raw) !== env.LPC_STAGING_SMTP_LOAD_LEASE_SHA256) fail();
  let lease, app, database;
  try { lease = JSON.parse(raw); app = new URL(env.APP_BASE_URL); database = new URL(env.MONGO_URI); }
  catch { fail(); }
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) fail();
  const now = Date.now(), start = Date.parse(lease.startsAtUtc), end = Date.parse(lease.expiresAtUtc);
  const namespace = lease.namespace;
  if (lease.version !== 1 || lease.purpose !== 'lpc36-synthetic-smtp' ||
      !/^lpc-load-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(namespace || '') ||
      !Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now || end - start > 20 * 60 * 1000 ||
      !/^[a-f0-9]{64}$/.test(lease.ownerDecisionSha256 || '') ||
      lease.productionAuthorized !== false || lease.maximumMessages !== 200 || lease.maximumBytes !== 2 * 1024 * 1024) fail();
  // This opt-in is limited to the existing isolated Render staging web service
  // and its explicitly enumerated staging workers, never another app or DB.
  // IDs are exact lease members; the prefix is syntax, never authorization.
  // Root binds the fresh owner/role/ID API readback to the reviewed lease.
  const webId = 'srv-d10gdh24d50c73ap2p60';
  if (env.LPC_DEPLOYMENT_ENV !== 'staging' || env.NODE_ENV !== 'staging' || env.PROD !== 'true' ||
      env.STAGING_RENDER_SERVICE_ID !== webId || lease.webServiceId !== webId ||
      !Array.isArray(lease.serviceIds) || !lease.serviceIds.includes(webId) || lease.serviceIds.length > 5 ||
      new Set(lease.serviceIds).size !== lease.serviceIds.length || !lease.serviceIds.every(id => /^(?:srv-[a-z0-9]+|crn-[a-z0-9]{20})$/.test(id)) ||
      !/^[a-f0-9]{64}$/.test(lease.serviceIdentityReadbackSha256 || '') ||
      !lease.serviceIds.includes(env.RENDER_SERVICE_ID) ||
      !/^[a-f0-9]{40}$/.test(lease.commit || '') || env.RENDER_GIT_COMMIT !== lease.commit ||
      app.origin !== 'https://lets-paraconnect-backend.onrender.com' || app.href !== app.origin + '/' ||
      lease.appOrigin !== app.origin) fail();
  if (database.protocol !== 'mongodb+srv:' || !database.username || !database.password ||
      !database.hostname.endsWith('.mongodb.net') || database.hostname !== env.STAGING_MONGO_HOST ||
      database.hostname !== lease.databaseHost ||
      !/^[a-f0-9]{64}$/.test(lease.productionDatabaseHostSha256 || '') ||
      digest(database.hostname) === lease.productionDatabaseHostSha256 ||
      lease.databaseName !== 'lpc_staging_l_' + digest(namespace).slice(0, 24) ||
      database.pathname !== '/' + lease.databaseName || database.hash ||
      (env.MONGODB_URI && env.MONGODB_URI !== env.MONGO_URI)) fail();
  // Render's owned private host is a single label, not a public DNS address.
  // The web's platform discovery identity independently binds its exact host.
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(lease.smtpHost || '') || lease.smtpHost === 'localhost' ||
      lease.smtpPort !== 2525 || env.SMTP_HOST !== lease.smtpHost || env.SMTP_PORT !== '2525' ||
      env.SMTP_SECURE !== 'false' || env.SMTP_USER !== namespace ||
      typeof env.SMTP_PASS !== 'string' || env.SMTP_PASS.length < 32 ||
      digest(env.SMTP_PASS) !== lease.smtpPasswordSha256 ||
      env.EMAIL_SKIP_VERIFY !== 'true' || env.EMAIL_DISABLE === 'true' ||
      (env.RENDER_SERVICE_ID === webId && env.RENDER_DISCOVERY_SERVICE !== lease.smtpHost + '-discovery')) fail();
  if (!Array.isArray(lease.recipients) || !lease.recipients.includes(APPROVED_INBOX) ||
      lease.recipients.length < 2 || lease.recipients.length > 46 ||
      new Set(lease.recipients).size !== lease.recipients.length ||
      !lease.recipients.every(address => address === APPROVED_INBOX ||
        (typeof address === 'string' && address.startsWith(namespace + '.') &&
         /^[a-z0-9.-]+@example\.test$/.test(address))) ||
      env.SMTP_FROM_EMAIL !== namespace + '.from@example.test') fail();
  // Custom SMTP can otherwise escape the private sink before sendMail. No
  // envelope/transport override is permitted in this explicit synthetic mode.
  for (const key of ['smtp', 'envelope', 'transport']) if (Object.hasOwn(options, key)) fail();
  if (options.from && addresses(options.from).some(address => address !== env.SMTP_FROM_EMAIL)) fail();
  return new Set(lease.recipients);
}

function assertStagingEmailRecipients(to, options = {}, env = process.env) {
  const hasLoadLease = env.LPC_STAGING_SMTP_LOAD_LEASE !== undefined || env.LPC_STAGING_SMTP_LOAD_LEASE_SHA256 !== undefined;
  if (hasLoadLease) {
    if (env.STAGING_EMAIL_RECIPIENT !== APPROVED_INBOX) throw boundaryError('STAGING_EMAIL_CONFIGURATION_INVALID');
    const allowed = syntheticLoadRecipients(options, env);
    const recipients = [to, options.cc, options.bcc].flatMap(addresses);
    if (!recipients.length || recipients.some(address => !allowed.has(address))) throw boundaryError('STAGING_EMAIL_RECIPIENT_BLOCKED');
    return;
  }
  if (env.LPC_DEPLOYMENT_ENV !== 'staging') {
    if (env.STAGING_EMAIL_RECIPIENT) throw boundaryError('STAGING_EMAIL_CONFIGURATION_INVALID');
    return;
  }
  if (env.STAGING_EMAIL_RECIPIENT !== APPROVED_INBOX) {
    throw boundaryError('STAGING_EMAIL_CONFIGURATION_INVALID');
  }
  const recipients = [to, options.cc, options.bcc].flatMap(addresses);
  if (!recipients.length || recipients.some(address => address !== APPROVED_INBOX)) {
    throw boundaryError('STAGING_EMAIL_RECIPIENT_BLOCKED');
  }
}

module.exports = { assertStagingEmailRecipients };
