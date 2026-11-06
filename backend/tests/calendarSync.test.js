const crypto = require('crypto');
const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/notificationEvents', () => ({ publishNotificationEvent: jest.fn() }));
jest.mock('../utils/caseProjectionEvents', () => ({ publishCaseProjectionRefresh: jest.fn() }));
jest.mock('../services/calendar/providers');
const providers = require('../services/calendar/providers');
const Connection = require('../models/CalendarConnection');
const Link = require('../models/CalendarSyncLink');
const User = require('../models/User');
const Event = require('../models/Event');
const Case = require('../models/Case');
const sync = require('../services/calendar/sync');
const connections = require('../services/calendar/connections');
const actual = jest.requireActual('../services/calendar/providers');
let user, connection, remote;
const shape = { title: 'Private appointment', start: '2026-11-09T15:00:00.000Z', end: '2026-11-09T16:00:00.000Z', isAllDay: false, where: '' };
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  user = await User.create({ firstName: 'Calendar', lastName: 'Owner', email: 'calendar-owner@example.test', password: 'Synthetic123!', role: 'attorney', status: 'approved' });
  connection = await Connection.create({ ownerId: user._id, provider: 'google', authVersion: 0, revision: crypto.randomUUID(), credentials: connections.encode({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }), expiresAt: new Date(Date.now() + 3600000) });
  providers.configuration.mockReturnValue({ scope: 'calendar' }); remote = [];
  providers.list.mockImplementation(async () => remote);
  providers.normalize.mockImplementation((_provider, raw) => raw);
  providers.payload.mockImplementation((_provider, value, identity) => ({ ...value, identity }));
  providers.request.mockImplementation(async (_provider, _token, options) => {
    if (options.method === 'POST') { const item = { ...options.body, id: options.body.identity, etag: 'created' }; remote.push(item); return item; }
    const found = remote.find(item => item.id === options.id);
    if (!found) throw Object.assign(new Error('Missing'), { providerStatus: 404 });
    if (options.method === 'PATCH') { Object.assign(found, options.body, { etag: 'updated' }); return found; }
    if (options.method === 'DELETE') { found.deleted = true; return {}; } return found;
  });
});
test('imports privately and deduplicates repeat sync', async () => {
  remote.push({ id: 'external-one', ...shape, etag: 'v1' });
  expect(await sync.sync(connection._id)).toEqual({ synced: true, conflicts: 0 });
  const event = await Event.findOne().lean(); expect(event.visibility).toBe('private'); expect(event.caseId).toBeNull();
  await sync.sync(connection._id); expect(await Event.countDocuments()).toBe(1); expect(providers.request).not.toHaveBeenCalled();
});
test('exports and applies edits in either direction without echo writes', async () => {
  const event = await Event.create({ owner: user._id, ...shape }); await sync.sync(connection._id); expect(remote).toHaveLength(1);
  remote[0].title = 'Changed externally'; await sync.sync(connection._id); expect((await Event.findById(event._id)).title).toBe('Changed externally');
  await Event.updateOne({ _id: event._id }, { $set: { title: 'Changed in LPC' } }); await sync.sync(connection._id); expect(remote[0].title).toBe('Changed in LPC');
  providers.request.mockClear(); await sync.sync(connection._id); expect(providers.request).not.toHaveBeenCalled();
});
test('preserves simultaneous edits and accepts chosen conflict resolution', async () => {
  const event = await Event.create({ owner: user._id, ...shape }); await sync.sync(connection._id);
  remote[0].title = 'External version'; await Event.updateOne({ _id: event._id }, { $set: { title: 'Local version' } });
  expect((await sync.sync(connection._id)).conflicts).toBe(1); expect((await Event.findById(event._id)).title).toBe('Local version');
  const link = await Link.findOne(); expect((await sync.sync(connection._id, { linkId: String(link._id), prefer: 'remote' })).conflicts).toBe(0); expect((await Event.findById(event._id)).title).toBe('External version');
});
test('propagates external deletion without resurrection', async () => {
  const event = await Event.create({ owner: user._id, ...shape }); await sync.sync(connection._id); remote[0].deleted = true;
  await sync.sync(connection._id); expect(await Event.findById(event._id)).toBeNull(); await sync.sync(connection._id); expect(await Event.countDocuments()).toBe(0);
});
test('propagates LPC deletion', async () => {
  const event = await Event.create({ owner: user._id, ...shape }); await sync.sync(connection._id); await Event.deleteOne({ _id: event._id }); await sync.sync(connection._id); expect(remote[0].deleted).toBe(true);
});
test('revoked account authorization prevents provider calls', async () => {
  await User.updateOne({ _id: user._id }, { $inc: { authVersion: 1 } }); await expect(sync.sync(connection._id)).rejects.toMatchObject({ publicCode: 'CALENDAR_ACCOUNT_CHANGED' }); expect(providers.list).not.toHaveBeenCalled();
});
test('immediately changes shared Matter deadline for authorized attorney', async () => {
  const para = new mongoose.Types.ObjectId(); const matter = await Case.create({ attorney: user._id, attorneyId: user._id, paralegal: para, paralegalId: para, title: 'Calendar matter', details: 'Synthetic matter', status: 'in progress', totalAmount: 50000, deadlineDate: '2026-11-10' });
  await sync.sync(connection._id); expect(remote).toHaveLength(1); remote[0].start = '2026-11-12T00:00:00.000Z'; remote[0].end = '2026-11-13T00:00:00.000Z';
  await sync.sync(connection._id); expect((await Case.findById(matter._id)).deadlineDate).toBe('2026-11-12');
});
test('loss of Matter access prevents exporting private changes', async () => {
  const matter = await Case.create({ attorney: user._id, attorneyId: user._id, title: 'Calendar matter', details: 'Synthetic matter', status: 'open', totalAmount: 50000, deadlineDate: '2026-11-10' }); await sync.sync(connection._id);
  await Case.updateOne({ _id: matter._id }, { $set: { attorney: new mongoose.Types.ObjectId(), attorneyId: new mongoose.Types.ObjectId(), title: 'New private title' } }); providers.request.mockClear(); await sync.sync(connection._id); expect(providers.request).not.toHaveBeenCalled();
});
test('provider payload uses exclusive all-day end', () => {
  const value = { ...shape, start: '2026-11-09T00:00:00.000Z', end: '2026-11-10T00:00:00.000Z', isAllDay: true }; expect(actual.payload('google', value).end).toEqual({ date: '2026-11-10' }); expect(actual.payload('microsoft', value).end.dateTime).toBe('2026-11-10T00:00:00.000');
});
test('refresh retains rotated credentials', async () => {
  await Connection.updateOne({ _id: connection._id }, { $set: { expiresAt: new Date(0) } }); providers.exchange.mockResolvedValue({ access_token: 'fresh-access', refresh_token: 'rotated-refresh', expires_in: 3600 }); await sync.sync(connection._id);
  const stored = await Connection.findById(connection._id).select('+credentials').lean(); expect(connections.decode(stored.credentials).refreshToken).toBe('rotated-refresh'); expect(providers.list).toHaveBeenCalledWith('google', 'fresh-access');
});
test('OAuth state is session-bound and single-use', async () => {
  const req = { user: { id: String(user._id), role: 'attorney' }, authVersion: 0, auth: { token: 'session-one' }, params: { provider: 'google' }, body: {} }; providers.authorization.mockImplementation((_settings,_provider,state) => state);
  const started = await connections.connect(req); const callback = { ...req, query: { state: started.authorizationUrl, error: 'access_denied' } };
  await expect(connections.callback({ ...callback, auth: { token: 'session-two' } })).rejects.toMatchObject({ publicCode: 'CALENDAR_STATE_INVALID' });
  await expect(connections.callback(callback)).resolves.toMatchObject({ href: expect.stringContaining('calendarResult=canceled') }); await expect(connections.callback(callback)).rejects.toMatchObject({ publicCode: 'CALENDAR_STATE_INVALID' });
});
test('disconnect removes credentials and prevents provider calls', async () => {
  await connections.disconnect({ user: { id: String(user._id), role: 'attorney' }, authVersion: 0, params: { provider: 'google' } }); const stored = await Connection.findById(connection._id).select('+credentials'); expect(stored.credentials).toBe(''); expect(stored.disconnectedAt).not.toBeNull(); await expect(sync.sync(connection._id)).rejects.toMatchObject({ publicCode: 'CALENDAR_BUSY' }); expect(providers.list).not.toHaveBeenCalled();
});
test('active lease rejects overlapping sync and disconnect', async () => {
  await Connection.updateOne({ _id: connection._id }, { $set: { lease: 'other-pass', leaseUntil: new Date(Date.now() + 60000) } }); await expect(sync.sync(connection._id)).rejects.toMatchObject({ publicCode: 'CALENDAR_BUSY' }); await expect(connections.disconnect({ user: { id: String(user._id) }, authVersion: 0, params: { provider: 'google' } })).rejects.toMatchObject({ publicCode: 'CALENDAR_BUSY' }); expect(providers.list).not.toHaveBeenCalled();
});
test('Microsoft normalization preserves UTC instants and identity', () => {
  const event = actual.normalize('microsoft', { id: 'ms-event', subject: 'Outlook meeting', start: {dateTime:'2026-11-09T15:00:00.0000000',timeZone:'UTC'}, end: {dateTime:'2026-11-09T16:00:00.0000000',timeZone:'UTC'}, transactionId:'stable-identity', '@odata.etag':'W/"abc"' }); expect(event.start).toBe(shape.start); expect(event.end).toBe(shape.end); expect(event.identity).toBe('stable-identity');
});
test('Microsoft sync uses its connection independently', async () => {
  await Connection.updateOne({ _id: connection._id }, { $set: { provider: 'microsoft' } }); const event = await Event.create({ owner: user._id, ...shape }); await sync.sync(connection._id); expect(providers.request.mock.calls[0][0]).toBe('microsoft'); remote[0].title='Changed in Outlook'; await sync.sync(connection._id); expect((await Event.findById(event._id)).title).toBe('Changed in Outlook');
});
test('canceling pending consent during provider exchange cannot recreate a disconnected connection', async () => {
  const State = require('../models/CalendarOAuthState');
  const req = { user: { id: String(user._id), role: 'attorney' }, authVersion: 0, auth: { token: 'session-one' }, params: { provider: 'google' }, body: {} };
  providers.authorization.mockImplementation((_settings,_provider,state) => state);
  const started = await connections.connect(req);
  providers.exchange.mockImplementation(async () => { await State.deleteMany({ownerId:user._id}); return {access_token:'synthetic',refresh_token:'synthetic',expires_in:3600}; }); providers.identity.mockResolvedValue('primary-calendar');
  await expect(connections.callback({ ...req, query: { state: started.authorizationUrl, code: 'synthetic-code' } })).rejects.toMatchObject({ publicCode: 'CALENDAR_STATE_INVALID' });
});
test.each(['google', 'microsoft'])('successful %s authorization imports the first events before returning to Settings', async provider => {
  const req = { user: { id: String(user._id), role: 'attorney' }, authVersion: 0, auth: { token: 'session-one' }, params: { provider }, body: {} };
  providers.authorization.mockImplementation((_settings,_provider,state) => state);
  providers.exchange.mockResolvedValue({access_token:'synthetic',refresh_token:'synthetic-refresh',expires_in:3600});
  providers.identity.mockResolvedValue('primary-calendar');
  remote.push({id:'first-import',...shape,etag:'first'});
  const started = await connections.connect(req);
  await expect(connections.callback({...req,query:{state:started.authorizationUrl,code:'synthetic-code'}})).resolves.toMatchObject({href:expect.stringContaining('calendarResult=connected')});
  const saved = await Connection.findOne({ownerId:user._id,provider}).lean();
  expect(saved.lastSyncedAt).toBeInstanceOf(Date);
  expect(saved.lastError).toBe('');
  expect(await Event.countDocuments({owner:user._id,title:shape.title})).toBe(1);
});
test('a failed initial sync preserves the authorized connection and reports recovery instead of undoing consent', async () => {
  const req = { user: { id: String(user._id), role: 'attorney' }, authVersion: 0, auth: { token: 'session-one' }, params: { provider:'google' }, body: {} };
  providers.authorization.mockImplementation((_settings,_provider,state) => state);
  providers.exchange.mockResolvedValue({access_token:'synthetic',refresh_token:'synthetic-refresh',expires_in:3600});
  providers.identity.mockResolvedValue('primary-calendar');
  providers.list.mockRejectedValue(new Error('Temporary provider interruption'));
  const started = await connections.connect(req);
  await expect(connections.callback({...req,query:{state:started.authorizationUrl,code:'synthetic-code'}})).resolves.toMatchObject({href:expect.stringContaining('calendarResult=connected')});
  const saved=await Connection.findOne({ownerId:user._id,provider:'google'}).select('+credentials').lean();
  expect(saved.disconnectedAt).toBeNull();expect(saved.needsReconnect).toBe(false);expect(saved.credentials).toBeTruthy();
  expect(saved.lastSyncedAt).toBeNull();expect(saved.lastError).toContain('Sync could not finish');
  providers.list.mockResolvedValue([]);await sync.sync(saved._id);
  expect((await Connection.findById(saved._id).lean()).lastSyncedAt).toBeInstanceOf(Date);
});
test('the local-e2e server checks pending connections immediately and starts one background sync timer while ordinary unit tests remain inactive', async () => {
  const original = process.env.APP_ENV, timer = { unref: jest.fn() }, interval = jest.spyOn(global, 'setInterval').mockReturnValue(timer), clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
  const find=jest.spyOn(Connection,'find').mockReturnValue({select:()=>({sort:()=>({limit:()=>({lean:async()=>[]})})})});
  try {
    delete process.env.APP_ENV; sync.start(); expect(interval).not.toHaveBeenCalled();
    process.env.APP_ENV = 'local-e2e'; sync.start(); sync.start();
    await Promise.resolve();expect(find).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledTimes(1); expect(interval).toHaveBeenCalledWith(expect.any(Function), 60000); expect(timer.unref).toHaveBeenCalledTimes(1);
    sync.stop(); expect(clear).toHaveBeenCalledWith(timer); expect(providers.list).not.toHaveBeenCalled();
  } finally { sync.stop(); find.mockRestore(); interval.mockRestore(); clear.mockRestore(); if (original === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = original; }
});

test.each(['google', 'microsoft'].flatMap(provider => [
  [provider, 'timeout', Object.assign(new Error('Synthetic timeout'), { code: 'ETIMEDOUT' })],
  [provider, 'unavailable', { response: { status: 503, data: { error: 'temporarily_unavailable' } } }],
  [provider, 'client configuration', { response: { status: 401, data: { error: 'invalid_client' } } }],
]))('%s refresh preserves credentials after %s failure and resumes without new consent', async (provider, _failure, error) => {
  await Connection.updateOne({ _id: connection._id }, { $set: { provider, expiresAt: new Date(0) } });
  const before = await Connection.findById(connection._id).select('+credentials').lean();
  remote.push({ id: 'external-recovery', ...shape, etag: 'v1' });
  providers.exchange.mockRejectedValueOnce(error).mockResolvedValue({ access_token: 'synthetic-renewed', expires_in: 3600 });
  await expect(sync.sync(connection._id)).rejects.toMatchObject({ publicCode: 'CALENDAR_SYNC_FAILED', status: 503 });
  const failed = await Connection.findById(connection._id).select('+credentials').lean();
  expect(failed.credentials).toBe(before.credentials); expect(failed.needsReconnect).toBe(false); expect(failed.lease).toBe('');
  expect(failed.lastError).toBe('Sync could not finish. Existing calendar data is kept.');
  expect(providers.list).not.toHaveBeenCalled(); expect(await Event.countDocuments()).toBe(0);
  expect(await sync.sync(connection._id)).toEqual({ synced: true, conflicts: 0 });
  await sync.sync(connection._id);
  const recovered = await Connection.findById(connection._id).select('+credentials').lean();
  expect(connections.decode(recovered.credentials)).toEqual({ accessToken: 'synthetic-renewed', refreshToken: 'synthetic-refresh' });
  expect(recovered.needsReconnect).toBe(false); expect(recovered.lastError).toBe(''); expect(await Event.countDocuments()).toBe(1);
});

test.each(['google', 'microsoft'])('%s refresh still clears a confirmed invalid grant and requires new consent', async provider => {
  await Connection.updateOne({ _id: connection._id }, { $set: { provider, expiresAt: new Date(0) } });
  providers.exchange.mockRejectedValueOnce({ response: { status: 400, data: { error: 'invalid_grant' } } });
  await expect(sync.sync(connection._id)).rejects.toMatchObject({ publicCode: 'CALENDAR_RECONNECT_REQUIRED', status: 409 });
  const failed = await Connection.findById(connection._id).select('+credentials').lean();
  expect(failed.credentials).toBe(''); expect(failed.needsReconnect).toBe(true); expect(failed.lease).toBe('');
  expect(providers.list).not.toHaveBeenCalled();
  await expect(sync.sync(connection._id)).rejects.toMatchObject({ publicCode: 'CALENDAR_BUSY' });
});

test('refresh persistence failure preserves the saved grant instead of misclassifying it as revoked', async () => {
  await Connection.updateOne({ _id: connection._id }, { $set: { expiresAt: new Date(0) } });
  const before = await Connection.findById(connection._id).select('+credentials').lean();
  providers.exchange.mockResolvedValue({ access_token: 'synthetic-renewed', expires_in: 3600 });
  const update = jest.spyOn(Connection, 'updateOne').mockRejectedValueOnce(new Error('Synthetic database unavailable'));
  try { await expect(sync.sync(connection._id)).rejects.toMatchObject({ publicCode: 'CALENDAR_SYNC_FAILED', status: 503 }); }
  finally { update.mockRestore(); }
  const failed = await Connection.findById(connection._id).select('+credentials').lean();
  expect(failed.credentials).toBe(before.credentials); expect(failed.needsReconnect).toBe(false); expect(failed.lease).toBe('');
  expect(providers.list).not.toHaveBeenCalled();
});
