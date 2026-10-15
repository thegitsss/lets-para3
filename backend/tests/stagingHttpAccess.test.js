const express = require('express');
const request = require('supertest');
const { stagingHttpAccess } = require('../utils/stagingHttpAccess');
const env = { NODE_ENV: 'staging', LPC_DEPLOYMENT_ENV: 'staging', STAGING_HTTP_USERNAME: 'lpc-staging', STAGING_HTTP_PASSWORD: 'synthetic-access-password-for-tests-only-32' };
function app(settings = env) {
  const server = express(); server.use(stagingHttpAccess(settings));
  server.use((_req, res) => res.status(200).send('Reached protected handler'));
  return server;
}
test('staging fails closed without a separate access identity', () => {
  expect(() => app({ ...env, STAGING_HTTP_PASSWORD: '' })).toThrow(/credentials/);
  expect(() => app({ ...env, LPC_DEPLOYMENT_ENV: 'production' })).toThrow(/credentials/);
});
test.each(['/attorney-v2.html', '/paralegal-v2.html', '/api/auth/register', '/api/messages/threads'])('unauthenticated staging access to %s is challenged', async route => {
  const response = await request(app()).get(route); expect(response.status).toBe(401);
  expect(response.headers['www-authenticate']).toMatch(/LPC staging/); expect(response.headers['cache-control']).toBe('no-store');
});
test('correct credentials reach handlers and incorrect credentials are rejected', async () => {
  expect((await request(app()).get('/attorney-v2.html').auth(env.STAGING_HTTP_USERNAME, env.STAGING_HTTP_PASSWORD)).status).toBe(200);
  expect((await request(app()).get('/attorney-v2.html').auth(env.STAGING_HTTP_USERNAME, 'wrong')).status).toBe(401);
});
test('only the exact health GET and webhook POST bypass browser credentials', async () => {
  expect((await request(app()).get('/api/health')).status).toBe(200);
  expect((await request(app()).post('/api/webhooks/stripe')).status).toBe(200);
  expect((await request(app()).post('/api/health')).status).toBe(401);
  expect((await request(app()).get('/api/webhooks/stripe')).status).toBe(401);
  expect((await request(app()).get('/api/health/details')).status).toBe(401);
});
test('production access handling is unchanged', async () => {
  expect((await request(app({ NODE_ENV: 'production' })).get('/attorney-v2.html')).status).toBe(200);
});
