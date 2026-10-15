const { timingSafeEqual } = require('node:crypto');

function stagingHttpAccess(env = process.env) {
  if (env.NODE_ENV !== 'staging') return (_req, _res, next) => next();
  const username = env.STAGING_HTTP_USERNAME || '';
  const password = env.STAGING_HTTP_PASSWORD || '';
  if (env.LPC_DEPLOYMENT_ENV !== 'staging' || !/^[a-zA-Z0-9_-]{3,64}$/.test(username) || Buffer.byteLength(password) < 32) {
    throw new Error('[staging config] Separate staging HTTP access credentials are required.');
  }
  const expected = Buffer.from('Basic ' + Buffer.from(username + ':' + password).toString('base64'));
  return (req, res, next) => {
    // Provider health checks and signed Stripe events cannot supply browser
    // credentials. The existing webhook handler still verifies its signature.
    if (req.method === 'GET' && req.path === '/api/health' || req.method === 'POST' && req.path === '/api/webhooks/stripe') return next();
    const actual = Buffer.from(req.get('authorization') || '');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="LPC staging"');
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('text').send('Staging access required.');
  };
}

module.exports = { stagingHttpAccess };
