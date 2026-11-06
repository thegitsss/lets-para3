'use strict';
const axios = require('axios');
const crypto = require('crypto');
const { isEncryptionEnabled } = require('../../utils/dataEncryption');
const HTTP = { timeout: 15000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024 };
const settings = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly', base: 'https://www.googleapis.com/calendar/v3/calendars/primary/events' },
  microsoft: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'offline_access Calendars.ReadWrite', base: 'https://graph.microsoft.com/v1.0/me/events' },
};
function configuration(provider, env = process.env) {
  if (!settings[provider] || !isEncryptionEnabled()) return null;
  const prefix = provider.toUpperCase() + '_CALENDAR_';
  try {
    const origin = new URL(env.APP_BASE_URL), redirect = new URL(env[prefix + 'REDIRECT_URI'] || `/api/integrations/calendars/${provider}/callback`, origin.origin);
    const local = env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if ((!local && origin.protocol !== 'https:') || origin.username || origin.password || redirect.origin !== origin.origin || redirect.pathname !== `/api/integrations/calendars/${provider}/callback` || redirect.search || redirect.hash || redirect.username || redirect.password) return null;
    const clientId = env[prefix + 'CLIENT_ID'], clientSecret = env[prefix + 'CLIENT_SECRET'];
    if (!clientId || !clientSecret) return null;
    return { ...settings[provider], clientId, clientSecret, redirectUri: redirect.href };
  } catch { return null; }
}
function authorization(config, provider, state, verifier) {
  const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: config.scope, state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }) });
  return `${config.authorize}?${query}`;
}
async function exchange(config, values) {
  const { data } = await axios.post(config.token, new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...values }).toString(), { ...HTTP, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (typeof data?.access_token !== 'string' || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new Error('Invalid calendar authorization response');
  // Granular consent can omit the requested calendar permission.
  const scopes = String(data.scope || '').split(' ');
  if (values.grant_type !== 'refresh_token' && (config.scope.includes('googleapis') ? !config.scope.split(' ').every(scope => scopes.includes(scope)) : !scopes.includes('Calendars.ReadWrite') && !scopes.includes('https://graph.microsoft.com/Calendars.ReadWrite'))) throw new Error('Calendar permission was not granted');
  return data;
}
function base(provider) { if (!settings[provider]) throw new Error('Unknown calendar provider'); return settings[provider].base; }
async function request(provider, token, { method = 'GET', id, body, query = {}, etag, view = false } = {}) {
  const url = new URL((view && provider === 'microsoft' ? 'https://graph.microsoft.com/v1.0/me/calendarView' : base(provider)) + (id ? '/' + encodeURIComponent(id) : ''));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  try {
    const { data } = await axios({ ...HTTP, method, url: url.href, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(provider === 'microsoft' ? { Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' } : {}), ...(etag ? { 'If-Match': etag } : {}) }, ...(body ? { data: body } : {}) });
    return data;
  } catch (error) { throw Object.assign(new Error('The calendar provider could not complete this request.'), { providerStatus: error.response?.status }); }
}
function normalize(provider, raw) {
  if (typeof raw?.id !== 'string' || raw.id.length > 2048) throw new Error('Invalid calendar event');
  if (raw.status === 'cancelled' || raw.isCancelled || raw['@removed']) return { id: raw.id, deleted: true };
  const allDay = provider === 'google' ? Boolean(raw.start?.date) : raw.isAllDay === true;
  const instant = value => { if (typeof value !== 'string') throw new Error('Invalid calendar time'); const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + (value.length === 10 ? 'T00:00:00Z' : 'Z')); if (!Number.isFinite(date.getTime())) throw new Error('Invalid calendar time'); return date.toISOString(); };
  const start = instant(raw.start?.date || raw.start?.dateTime), end = instant(raw.end?.date || raw.end?.dateTime);
  if (end < start) throw new Error('Invalid calendar range');
  return { id: raw.id, deleted: false, title: String(provider === 'google' ? raw.summary || 'Untitled event' : raw.subject || 'Untitled event').trim().slice(0, 500) || 'Untitled event', start, end, isAllDay: allDay, where: String(provider === 'google' ? raw.location || '' : raw.location?.displayName || '').slice(0, 2000), etag: raw.etag || raw['@odata.etag'] || '', identity: raw.extendedProperties?.private?.lpcSync || raw.transactionId || '', recurring: Boolean(raw.recurrence || raw.type === 'seriesMaster') };
}
function payload(provider, event, identity) {
  let end = event.end;
  if (event.isAllDay) {
    // Retained LPC all-day entries can end at 23:59:59; providers require
    // an exclusive midnight end date. Already-exclusive dates stay unchanged.
    const boundary = new Date(end.slice(0,10) + 'T00:00:00.000Z');
    if (!end.endsWith('T00:00:00.000Z')) boundary.setUTCDate(boundary.getUTCDate() + 1);
    end = boundary.toISOString();
  }
  if (end <= event.start) end = new Date(new Date(event.start).getTime() + (event.isAllDay ? 86400000 : 3600000)).toISOString();
  if (provider === 'google') return { summary: event.title, location: event.where || '', start: event.isAllDay ? { date: event.start.slice(0, 10) } : { dateTime: event.start }, end: event.isAllDay ? { date: end.slice(0, 10) } : { dateTime: end }, ...(identity ? { id: identity.replace(/-/g, ''), extendedProperties: { private: { lpcSync: identity } } } : {}) };
  return { subject: event.title, location: { displayName: event.where || '' }, isAllDay: event.isAllDay, start: { dateTime: event.start.replace(/Z$/, ''), timeZone: 'UTC' }, end: { dateTime: end.replace(/Z$/, ''), timeZone: 'UTC' }, ...(identity ? { transactionId: identity } : {}) };
}
async function identity(provider, token) {
  const url = provider === 'google' ? 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary' : 'https://graph.microsoft.com/v1.0/me/calendar';
  let data;
  try { ({ data } = await axios.get(url, { ...HTTP, headers: { Authorization: `Bearer ${token}` } })); }
  catch { throw new Error('Calendar account identity could not be confirmed.'); }
  if (typeof data?.id !== 'string' || !data.id || data.id.length > 2048) throw new Error('Invalid calendar identity');
  return data.id;
}
async function list(provider, token) {
  const items = [], seen = new Set(); let page = null, pages = 0;
  // Expand occurrences in a bounded window. Sync fetches missing linked IDs
  // individually before interpreting an event as deleted.
  const from = new Date(Date.now() - 90 * 86400000).toISOString(), to = new Date(Date.now() + 366 * 86400000).toISOString();
  do {
    if (++pages > 100) throw new Error('Calendar inventory exceeds the pagination limit');
    const query = provider === 'google' ? { maxResults: 250, showDeleted: true, singleEvents: true, timeMin: from, timeMax: to, ...(page ? { pageToken: page } : {}) } : { $top: 250, $select: 'id,subject,start,end,isAllDay,location,isCancelled,type,transactionId', startDateTime: from, endDateTime: to, ...(page || {}) };
    const raw = await request(provider, token, { query, view: true });
    const rows = provider === 'google' ? raw?.items : raw?.value;
    if (!Array.isArray(rows) || items.length + rows.length > 10000) throw new Error('Calendar inventory could not be read completely');
    items.push(...rows.map(row => normalize(provider, row)));
    if (provider === 'google') page = raw.nextPageToken || null;
    else if (raw['@odata.nextLink']) {
      const next = new URL(raw['@odata.nextLink']);
      if (next.origin !== 'https://graph.microsoft.com' || next.pathname !== '/v1.0/me/calendarView' || next.username || next.password || next.hash || [...next.searchParams.keys()].some(key => !['$skip','$skiptoken','$top','$select','startDateTime','endDateTime'].includes(key)) || !next.searchParams.has('$skip') && !next.searchParams.has('$skiptoken')) throw new Error('Invalid calendar continuation');
      page = Object.fromEntries(next.searchParams);
    } else page = null;
    const pageKey = typeof page === 'object' ? JSON.stringify(page) : page;
    if (page && seen.has(pageKey)) throw new Error('Repeated calendar page');
    seen.add(pageKey);
  } while (page);
  return items;
}
module.exports = { configuration, authorization, exchange, request, normalize, payload, list, identity };
