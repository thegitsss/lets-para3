const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const Store = require('../models/LinkedInPhotoImport');
const { MAX_PROFILE_PHOTO_BYTES } = require('./profilePhotoDelivery');
const CALLBACK = '/api/uploads/linkedin-photo/callback';
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function configuration(env = process.env) {
  const clientId = env.LINKEDIN_PHOTO_CLIENT_ID || env.LINKEDIN_CLIENT_ID;
  const clientSecret = env.LINKEDIN_PHOTO_CLIENT_SECRET || env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = env.LINKEDIN_PHOTO_REDIRECT_URI;
  try {
    const url = new URL(redirectUri);
    const local = env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!clientId || !clientSecret || (!local && url.protocol !== 'https:') || url.pathname !== CALLBACK || url.username || url.password || url.search || url.hash) return null;
    return { clientId, clientSecret, redirectUri };
  } catch { return null; }
}
function pictureUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['media.licdn.com', 'media.licdn-ei.com'].includes(url.hostname)) throw failure('LinkedIn did not provide a supported photo.');
  return url.href;
}
async function begin(ownerId, sessionHash) {
  const config = configuration();
  if (!config) throw failure('LinkedIn photo import is not connected yet.', 503);
  const recent = await Store.countDocuments({ ownerId, createdAt: { $gt: new Date(Date.now() - 60000) } });
  if (recent >= 3) throw failure('Please wait a minute before trying LinkedIn again.', 429);
  const state = crypto.randomBytes(32).toString('hex');
  const requestId = crypto.randomBytes(32).toString('hex');
  await Store.create({ ownerId, sessionHash, requestId, stateHash: hash(state), expiresAt: new Date(Date.now() + 10 * 60000) });
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'openid profile', state }).toString();
  return { authorizationUrl: url.href, requestId };
}
async function complete({ ownerId, sessionHash, state, code, denied }) {
  if (!/^[a-f0-9]{64}$/.test(String(state || ''))) throw failure('This LinkedIn request expired. Please try again.');
  const record = await Store.findOneAndUpdate({ ownerId, sessionHash, stateHash: hash(state), status: 'pending', expiresAt: { $gt: new Date() } }, { $set: { status: 'processing' } }, { new: true });
  if (!record) throw failure('This LinkedIn request expired. Please try again.');
  try {
    const config = configuration();
    if (denied || !code || !config) throw failure('LinkedIn photo import was cancelled.');
    const token = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: config.clientId, client_secret: config.clientSecret }).toString(), { timeout: 10000, maxRedirects: 0, maxContentLength: 65536, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!token.data?.access_token || typeof token.data.access_token !== 'string') throw failure('LinkedIn could not connect.');
    const member = await axios.get('https://api.linkedin.com/v2/userinfo', { timeout: 10000, maxRedirects: 0, maxContentLength: 65536, headers: { Authorization: `Bearer ${token.data.access_token}` } });
    if (!member.data?.picture) throw failure('No LinkedIn photo is available.');
    const photo = await axios.get(pictureUrl(member.data.picture), { timeout: 10000, maxRedirects: 0, maxContentLength: MAX_PROFILE_PHOTO_BYTES, responseType: 'arraybuffer' });
    if (!/^image\/(jpeg|png)(;|$)/i.test(photo.headers['content-type'] || '')) throw failure('LinkedIn did not provide a supported photo.');
    const bytes = Buffer.from(photo.data);
    if (!bytes.length || bytes.length > MAX_PROFILE_PHOTO_BYTES) throw failure('The LinkedIn photo is too large.');
    const image = sharp(bytes, { limitInputPixels: 16000000 });
    const metadata = await image.metadata();
    if (!['jpeg', 'png'].includes(metadata.format)) throw failure('LinkedIn did not provide a supported photo.');
    const safe = await image.rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    if (safe.length > MAX_PROFILE_PHOTO_BYTES) throw failure('The LinkedIn photo is too large.');
    await Store.updateOne({ _id: record._id, status: 'processing', expiresAt: { $gt: new Date() } }, { $set: { status: 'ready', photo: safe } });
    return true;
  } catch {
    // Provider responses can contain credentials. Persist no tokens or raw errors.
    await Store.updateOne({ _id: record._id }, { $set: { status: 'failed' }, $unset: { photo: 1 } });
    return false;
  }
}
async function result(ownerId, sessionHash, requestId) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{64}$/.test(requestId)) throw failure('This LinkedIn request expired.', 404);
  const record = await Store.findOne({ ownerId, sessionHash, requestId: { $eq: requestId }, expiresAt: { $gt: new Date() } }).select('+photo').lean();
  if (!record) throw failure('This LinkedIn request expired.', 404);
  if (record.status !== 'ready') return { status: record.status };
  return { status: 'ready', contentType: 'image/jpeg', photo: (Buffer.isBuffer(record.photo) ? record.photo : Buffer.from(record.photo.buffer)).toString('base64') };
}
module.exports = { configuration, pictureUrl, begin, complete, result };
