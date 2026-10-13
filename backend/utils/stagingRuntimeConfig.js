const { assertStagingEmailRecipients } = require('./stagingEmailBoundary');
const { createHash } = require('node:crypto');
const PRODUCTION_HOSTS = new Set(['lets-paraconnect.com', 'www.lets-paraconnect.com', 'lets-para3.onrender.com', 'lets-paraconnect.onrender.com']);
// Read-only Render inventory verified this retired, suspended free service has
// no custom domains. Reuse still requires an explicit matching service identity.
const REUSABLE_SERVICE = { host: 'lets-paraconnect-backend.onrender.com', id: 'srv-d10gdh24d50c73ap2p60' };

function assertStagingRuntimeConfiguration(env = process.env) {
  const fail = message => { throw new Error('[staging config] ' + message); };
  if (env.LPC_DEPLOYMENT_ENV !== 'staging' || env.NODE_ENV !== 'staging') fail('An explicit staging identity is required.');
  let base, database;
  try { base = new URL(env.APP_BASE_URL); database = new URL(env.MONGO_URI); }
  catch { fail('Staging application and database URLs must be configured.'); }
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.onrender.com') || PRODUCTION_HOSTS.has(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) fail('Use a separate Render staging HTTPS origin.');
  if (base.hostname === REUSABLE_SERVICE.host && (env.STAGING_RENDER_SERVICE_ID !== REUSABLE_SERVICE.id || env.RENDER_SERVICE_ID !== REUSABLE_SERVICE.id)) fail('Reusing the retired service requires its verified staging service identity.');
  for (const key of ['EMAIL_BASE_URL', 'CLIENT_BASE_URL', 'FRONTEND_BASE_URL', 'PUBLIC_ORIGIN', 'JWT_ISSUER']) {
    if (env[key] !== base.origin) fail(key + ' must match the staging origin.');
  }
  if (database.protocol !== 'mongodb+srv:' || database.hostname !== env.STAGING_MONGO_HOST || !database.username || !database.password || !/^\/lpc_staging_[a-z0-9_]+$/.test(database.pathname)) fail('Use the separately provisioned staging database host and database.');
  if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '') || !/^pk_test_[A-Za-z0-9]+$/.test(env.STRIPE_PUBLISHABLE_KEY || '')) fail('Stripe test-mode keys are required; live keys are forbidden.');
  for (const key of ['ENABLE_CSRF', 'REQUIRE_AUTH_SESSION', 'REQUIRE_DATA_ENCRYPTION', 'PROD']) {
    if (env[key] !== 'true') fail(key + ' must be true.');
  }
  if (Buffer.byteLength(env.JWT_SECRET || '') < 32 || !/^[a-f0-9]{64}$/i.test(env.DATA_ENCRYPTION_KEY || '')) fail('Separate session and data encryption secrets are required.');
  assertStagingEmailRecipients('admin@lets-paraconnect.com', {}, env);
  if (env.SUPPORT_ZOHO_REFRESH_TOKEN || env.DIRECTOR_ZOHO_REFRESH_TOKEN || env.ZOHO_MAIL_REFRESH_TOKEN) fail('Production mailbox sync credentials must not be mounted in staging.');
  if (env.S3_BUCKET) {
    const target = createHash('sha256').update(env.S3_BUCKET).digest('hex');
    if (env.STAGING_STORAGE_TARGET_SHA256 !== target || !/^[a-f0-9]{64}$/.test(env.PRODUCTION_STORAGE_TARGET_SHA256 || '') || target === env.PRODUCTION_STORAGE_TARGET_SHA256) fail('Use a verified storage target distinct from the production bucket.');
  }
  if (env.INCIDENT_AUTO_DEPLOY_ENABLED !== 'false' || env.INCIDENT_PRODUCTION_DEPLOY_MODE !== 'disabled') fail('Automatic production deployment must remain disabled.');
  return { origin: base.origin, databaseHost: database.hostname, stripeMode: 'test' };
}

module.exports = { assertStagingRuntimeConfiguration };
