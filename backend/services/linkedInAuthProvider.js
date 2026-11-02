const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const ISSUER = 'https://www.linkedin.com/oauth';
const JWKS_URL = 'https://www.linkedin.com/oauth/openid/jwks';
const HTTP = { timeout: 10000, maxRedirects: 0, maxContentLength: 65536 };
let cached = null, pending = null;
function configuration(env = process.env) {
  const clientId = String(env.LINKEDIN_AUTH_CLIENT_ID || env.LINKEDIN_CLIENT_ID || '').trim();
  const clientSecret = String(env.LINKEDIN_AUTH_CLIENT_SECRET || env.LINKEDIN_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.LINKEDIN_AUTH_REDIRECT_URI || '').trim();
  try {
    const url = new URL(redirectUri);
    const local = env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if (!clientId || !clientSecret || (!local && url.protocol !== 'https:') || url.pathname !== '/api/auth/linkedin/callback' || url.username || url.password || url.search || url.hash) return null;
    return { clientId, clientSecret, redirectUri };
  } catch { return null; }
}
async function signingKey(header) {
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256) throw new Error('Invalid LinkedIn signing key');
  if (!cached || Date.now() - cached.at > 300000) {
    if (!pending) pending = axios.get(JWKS_URL, HTTP).then(({data}) => {
      if (!Array.isArray(data?.keys) || data.keys.length > 20) throw new Error('Invalid LinkedIn key set');
      cached = { at: Date.now(), keys: data.keys }; return cached;
    }).finally(() => { pending = null; });
    await pending;
  }
  const key = cached.keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (!key) throw new Error('Unknown LinkedIn signing key');
  return crypto.createPublicKey({ key, format: 'jwk' });
}
async function verifyIdentity(idToken, clientId) {
  if (typeof idToken !== 'string' || idToken.length > 32768) throw new Error('Invalid LinkedIn identity');
  const header = jwt.decode(idToken, { complete: true })?.header;
  const payload = jwt.verify(idToken, await signingKey(header), { algorithms: ['RS256'], issuer: ISSUER, audience: clientId, maxAge: '10m', clockTolerance: 30 });
  if (!payload || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) || payload.iat > Date.now()/1000+30 || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 255 || (payload.azp && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error('Invalid LinkedIn identity');
  return payload;
}
async function exchange(code, config) {
  const body = new URLSearchParams({ grant_type:'authorization_code', code, client_id:config.clientId, client_secret:config.clientSecret, redirect_uri:config.redirectUri });
  const { data: token } = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', body.toString(), { ...HTTP, headers:{'Content-Type':'application/x-www-form-urlencoded'} });
  if (typeof token?.access_token !== 'string' || !token.id_token) throw new Error('Missing LinkedIn identity');
  const identity = await verifyIdentity(token.id_token, config.clientId);
  const { data: profile } = await axios.get('https://api.linkedin.com/v2/userinfo', { ...HTTP, headers:{ Authorization:`Bearer ${token.access_token}` } });
  if (profile?.sub !== identity.sub) throw new Error('LinkedIn subject mismatch');
  return { sub:identity.sub, email:profile.email, email_verified:profile.email_verified === true, given_name:profile.given_name, family_name:profile.family_name, name:profile.name };
}
module.exports = { configuration, exchange, verifyIdentity };
