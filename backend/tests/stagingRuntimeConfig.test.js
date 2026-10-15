const { assertStagingRuntimeConfiguration } = require('../utils/stagingRuntimeConfig');
const origin = 'https://lpc-staging-shared-matter.onrender.com';
function mongo(host = 'isolated.mongodb.net', database = 'lpc_staging_test') {
  const uri = new URL('mongodb+srv://' + host + '/' + database);
  uri.username = 'synthetic'; uri.password = 'synthetic';
  return uri.toString();
}
function config() {
  return {
    LPC_DEPLOYMENT_ENV: 'staging', NODE_ENV: 'staging', APP_BASE_URL: origin,
    EMAIL_BASE_URL: origin, CLIENT_BASE_URL: origin, FRONTEND_BASE_URL: origin, PUBLIC_ORIGIN: origin, JWT_ISSUER: origin,
    MONGO_URI: mongo(), STAGING_MONGO_HOST: 'isolated.mongodb.net',
    STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
    JWT_SECRET: 'synthetic-session-secret-at-least-32-bytes', DATA_ENCRYPTION_KEY: 'a'.repeat(64),
    ENABLE_CSRF: 'true', REQUIRE_AUTH_SESSION: 'true', REQUIRE_DATA_ENCRYPTION: 'true', PROD: 'true',
    STAGING_EMAIL_RECIPIENT: 'admin@lets-paraconnect.com', INCIDENT_AUTO_DEPLOY_ENABLED: 'false', INCIDENT_PRODUCTION_DEPLOY_MODE: 'disabled',
  };
}
test('accepts an isolated staging identity and Stripe test mode', () => {
  expect(assertStagingRuntimeConfiguration(config())).toMatchObject({ origin, stripeMode: 'test' });
});
test('allows the verified retired service only with its exact staging identity', () => {
  const reused = 'https://lets-paraconnect-backend.onrender.com';
  const env = { ...config(), ...Object.fromEntries(['APP_BASE_URL', 'EMAIL_BASE_URL', 'CLIENT_BASE_URL', 'FRONTEND_BASE_URL', 'PUBLIC_ORIGIN', 'JWT_ISSUER'].map(key => [key, reused])), RENDER_SERVICE_ID: 'srv-d10gdh24d50c73ap2p60', STAGING_RENDER_SERVICE_ID: 'srv-d10gdh24d50c73ap2p60' };
  expect(assertStagingRuntimeConfiguration(env).origin).toBe(reused);
  expect(() => assertStagingRuntimeConfiguration({ ...env, STAGING_RENDER_SERVICE_ID: '' })).toThrow();
  expect(() => assertStagingRuntimeConfiguration({ ...env, RENDER_SERVICE_ID: 'srv-d3o54nc9c44c73cm5kn0' })).toThrow();
});
test('storage reuse depends on verified distinct target identities rather than naming', () => {
  const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const env = { ...config(), S3_BUCKET: 'existing-isolated-documents', STAGING_STORAGE_TARGET_SHA256: digest('existing-isolated-documents'), PRODUCTION_STORAGE_TARGET_SHA256: digest('synthetic-production') };
  expect(assertStagingRuntimeConfiguration(env).stripeMode).toBe('test');
  expect(() => assertStagingRuntimeConfiguration({ ...env, PRODUCTION_STORAGE_TARGET_SHA256: env.STAGING_STORAGE_TARGET_SHA256 })).toThrow();
  expect(() => assertStagingRuntimeConfiguration({ ...config(), S3_BUCKET: 'lpc-staging-name-alone' })).toThrow();
});
test.each([
  ['STRIPE_SECRET_KEY', 'sk_live_synthetic'], ['STRIPE_PUBLISHABLE_KEY', 'pk_live_synthetic'],
  ['NODE_ENV', 'production'], ['LPC_DEPLOYMENT_ENV', 'production'],
  ['APP_BASE_URL', 'https://www.lets-paraconnect.com'], ['APP_BASE_URL', 'https://lets-para3.onrender.com'],
  ['EMAIL_BASE_URL', 'https://www.lets-paraconnect.com'], ['JWT_ISSUER', 'https://www.lets-paraconnect.com'],
  ['MONGO_URI', mongo('isolated.mongodb.net', 'production')],
  ['MONGO_URI', mongo('another.mongodb.net')],
  ['MONGO_URI', 'mongodb+srv://isolated.mongodb.net/lpc_staging_test'],
  ['STAGING_EMAIL_RECIPIENT', 'test@example.invalid'], ['ENABLE_CSRF', 'false'],
  ['REQUIRE_AUTH_SESSION', 'false'], ['REQUIRE_DATA_ENCRYPTION', 'false'], ['PROD', 'false'],
  ['JWT_SECRET', 'short'], ['DATA_ENCRYPTION_KEY', 'short'],
  ['SUPPORT_ZOHO_REFRESH_TOKEN', 'synthetic'], ['DIRECTOR_ZOHO_REFRESH_TOKEN', 'synthetic'], ['ZOHO_MAIL_REFRESH_TOKEN', 'synthetic'],
  ['S3_BUCKET', 'production-bucket'],
  ['INCIDENT_AUTO_DEPLOY_ENABLED', 'true'], ['INCIDENT_PRODUCTION_DEPLOY_MODE', 'webhook'],
])('refuses unsafe staging configuration %s', (key, value) => {
  expect(() => assertStagingRuntimeConfiguration({ ...config(), [key]: value })).toThrow();
});
