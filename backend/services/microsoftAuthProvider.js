const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AUTHORITY = 'https://login.microsoftonline.com';
const AUTHORIZE_URL = `${AUTHORITY}/common/oauth2/v2.0/authorize`;
const TOKEN_URL = `${AUTHORITY}/common/oauth2/v2.0/token`;
const JWKS_URL = `${AUTHORITY}/common/discovery/v2.0/keys`;
const HTTP = { timeout: 10000, maxRedirects: 0, maxContentLength: 131072 };
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let cached = null, pending = null;
function configuration(env = process.env) {
  const clientId = String(env.MICROSOFT_AUTH_CLIENT_ID || '').trim();
  const clientSecret = String(env.MICROSOFT_AUTH_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.MICROSOFT_AUTH_REDIRECT_URI || '').trim();
  try {
    const url = new URL(redirectUri);
    const local = env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!clientId || !clientSecret || (!local && url.protocol !== 'https:') || url.pathname !== '/api/auth/microsoft/callback' || url.username || url.password || url.search || url.hash) return null;
    return { clientId, clientSecret, redirectUri };
  } catch { return null; }
}
async function keys(force = false) {
  if (force || !cached || Date.now() - cached.at > 300000) {
    if (!pending) pending = axios.get(JWKS_URL, HTTP).then(({ data }) => {
      if (!Array.isArray(data?.keys) || data.keys.length > 100) throw new Error('Invalid Microsoft key set');
      cached = { at: Date.now(), keys: data.keys }; return cached;
    }).finally(() => { pending = null; });
    await pending;
  }
  return cached.keys;
}
async function verifyIdentity(idToken, clientId, nonce) {
  if (typeof idToken !== 'string' || idToken.length > 32768 || typeof nonce !== 'string' || nonce.length < 16) throw new Error('Invalid Microsoft identity');
  const decoded = jwt.decode(idToken, { complete: true });
  const header = decoded?.header, tenant = decoded?.payload?.tid;
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 || typeof tenant !== 'string' || !TENANT.test(tenant)) throw new Error('Invalid Microsoft signing identity');
  // The untrusted tenant only selects an expected issuer; it never selects a URL.
  const issuer = `${AUTHORITY}/${tenant}/v2.0`;
  const matches = key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256') && typeof key.issuer === 'string' && key.issuer.replace('{tenantid}', tenant) === issuer;
  let key = (await keys()).find(matches);
  if (!key && Date.now() - cached.at > 30000) key = (await keys(true)).find(matches);
  if (!key) throw new Error('Unknown Microsoft signing key');
  const payload = jwt.verify(idToken, crypto.createPublicKey({ key, format: 'jwk' }), { algorithms: ['RS256'], issuer, audience: clientId, maxAge: '10m', clockTolerance: 30 });
  if (!payload || payload.ver !== '2.0' || payload.tid !== tenant || !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.iat > Date.now() / 1000 + 30 || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 180 || (payload.azp && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error('Invalid Microsoft identity');
  const received = Buffer.from(String(payload.nonce || '')), expected = Buffer.from(nonce);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('Invalid Microsoft nonce');
  return payload;
}
async function exchange(code, config, context) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(context?.codeVerifier || '')) throw new Error('Missing Microsoft proof key');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, code_verifier: context.codeVerifier, scope: 'openid email profile' });
  const { data } = await axios.post(TOKEN_URL, body.toString(), { ...HTTP, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const identity = await verifyIdentity(data?.id_token, config.clientId, context.nonce);
  // Microsoft email/username claims are suggestions, not verified ownership.
  return { sub: `${identity.tid}:${identity.sub}`, nonce: identity.nonce, email: identity.email || identity.preferred_username || '', email_verified: false, given_name: identity.given_name, family_name: identity.family_name, name: identity.name };
}
module.exports = { configuration, exchange, verifyIdentity, AUTHORIZE_URL };
