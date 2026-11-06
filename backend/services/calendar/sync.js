'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const Connection = require('../../models/CalendarConnection');
const Link = require('../../models/CalendarSyncLink');
const Event = require('../../models/Event');
const Case = require('../../models/Case');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const providers = require('./providers');
const { encode, decode, fail } = require('./connections');
const { withActiveAccountWrite } = require('../../utils/activeAccountWrite');
const { caseParticipantIdentity } = require('../../utils/caseParticipantIdentity');
const { normalizeCaseStatus } = require('../../utils/caseState');
const { publishNotificationEvent } = require('../../utils/notificationEvents');
const hash = event => crypto.createHash('sha256').update(JSON.stringify(event && [event.title, event.start, event.end, event.isAllDay, event.where || ''])).digest('hex');
const namespace = connection => ({ connectionId: connection._id, connectionRevision: connection.revision });
const iso = value => new Date(value).toISOString();
function eventShape(event) { return { title: event.title, start: iso(event.start), end: iso(event.end || event.start), isAllDay: event.isAllDay === true, where: event.where || '' }; }
function matterShape(matter) {
  const date = matter.deadlineDate || (matter.deadline ? iso(matter.deadline).slice(0, 10) : '');
  return date ? { title: matter.title, start: date + 'T00:00:00.000Z', end: iso(new Date(date + 'T00:00:00.000Z').getTime() + 86400000), isAllDay: true, where: '' } : null;
}
function permission(matter, ownerId) {
  const identity = caseParticipantIdentity(matter, ownerId);
  const readable = !identity.identityConflict && (identity.isAttorney || identity.isParalegal && !matter.paralegalAccessRevokedAt) && !matter.purgedAt;
  const writable = readable && !matter.archived && !matter.readOnly && ['in progress', 'open'].includes(normalizeCaseStatus(matter.status));
  return { readable, writable, attorney: identity.isAttorney };
}
async function owner(connection) {
  const user = await User.findById(connection.ownerId).select('role status disabled deleted authVersion').lean();
  if (!user || !['attorney','paralegal'].includes(user.role) || user.status !== 'approved' || user.disabled || user.deleted || Number(user.authVersion || 0) !== connection.authVersion) fail(403, 'ACCOUNT_CHANGED', 'Sign in and reconnect your calendar.');
  return user;
}
async function check(connection) {
  await owner(connection);
  if (!await Connection.exists({ _id: connection._id, revision: connection.revision, disconnectedAt: null, lease: connection.lease, leaseUntil: { $gt: new Date() } })) fail(409, 'CONNECTION_CHANGED', 'The calendar connection changed. Refresh its status.');
}
async function token(connection) {
  const settings = providers.configuration(connection.provider);
  if (!settings) fail(503, 'NOT_CONFIGURED', 'This calendar provider is not configured for LPC yet.');
  const previous = decode(connection.credentials);
  if (connection.expiresAt > new Date(Date.now() + 60000)) return previous.accessToken;
  let value;
  try {
    value = await providers.exchange(settings, { grant_type: 'refresh_token', refresh_token: previous.refreshToken, ...(connection.provider === 'microsoft' ? { scope: settings.scope } : {}) });
  } catch (error) {
    // Only a confirmed invalid grant requires fresh user consent. Transport,
    // provider and client-configuration failures do not revoke the saved grant.
    if (error.response?.status === 400 && error.response?.data?.error === 'invalid_grant') {
      await Connection.updateOne({ _id: connection._id, revision: connection.revision, lease: connection.lease }, { $set: { needsReconnect: true, credentials: '' } });
      fail(409, 'RECONNECT_REQUIRED', 'Reconnect your calendar to resume sync.');
    }
    fail(503, 'SYNC_FAILED', 'Sync could not finish. Existing calendar data is kept. Try again shortly.');
  }
  await check(connection);
  await Connection.updateOne({ _id: connection._id, revision: connection.revision, lease: connection.lease }, { $set: { credentials: encode({ accessToken: value.access_token, refreshToken: value.refresh_token || previous.refreshToken }), expiresAt: new Date(Date.now() + Number(value.expires_in) * 1000) } });
  return value.access_token;
}
async function apply(connection, link, local, remote, role) {
  let changedMatter;
  await withActiveAccountWrite([connection.ownerId], async session => {
    const active = await Connection.findOne({ _id: connection._id, revision: connection.revision, lease: connection.lease, disconnectedAt: null, leaseUntil: { $gt: new Date() } }).session(session).lean();
    if (!active) fail(409, 'CONNECTION_CHANGED', 'Calendar sync changed. Refresh its status.');
    let matter = null;
    if (link.kind === 'matter' || local?.caseId) {
      matter = await Case.findById(link.kind === 'matter' ? link.localId : local.caseId).session(session).lean();
      const access = matter && permission(matter, connection.ownerId);
      if (!access?.writable || link.kind === 'matter' && !access.attorney) fail(403, 'MATTER_CHANGED', 'This calendar cannot change that Matter.');
      changedMatter = matter;
      const locked = await Case.updateOne({ _id: matter._id, __v: matter.__v ?? { $exists: false } }, { $inc: { __v: 1 } }, { session });
      if (locked.matchedCount !== 1) fail(409, 'CONFLICT', 'This Matter changed during sync.');
    }
    if (link.kind === 'matter') {
      // Calendar consent permits deadline changes, never Matter renaming or
      // alteration of engagement, payment or assignment records.
      if (hash(matterShape(matter)) !== hash(local && matterShape(local))) fail(409, 'CONFLICT', 'This Matter deadline changed during sync.');
      const date = remote.deleted ? '' : remote.start.slice(0, 10);
      await Case.updateOne({ _id: matter._id }, { $set: { deadlineDate: date, deadline: date ? new Date(date + 'T00:00:00.000Z') : null } }, { session });
    } else if (local) {
      const current = await Event.findOne({ _id: link.localId, owner: connection.ownerId }).session(session).lean();
      if (!current || hash(eventShape(current)) !== hash(eventShape(local))) fail(409, 'CONFLICT', 'This LPC event changed during sync.');
      if (remote.deleted) await Event.deleteOne({ _id: current._id, owner: connection.ownerId }, { session });
      else {
        const values = { title: remote.title, start: new Date(remote.start), end: new Date(remote.end), isAllDay: remote.isAllDay, where: remote.where, timezone: 'UTC' };
        const prepared = Event.hydrate({ ...current, ...values }); await prepared.validate();
        await Event.updateOne({ _id: current._id, owner: connection.ownerId }, { $set: values }, { session });
      }
    } else if (!remote.deleted) {
      await Event.create([{ _id: link.localId, owner: connection.ownerId, title: remote.title, start: remote.start, end: remote.end, isAllDay: remote.isAllDay, where: remote.where, visibility: 'private', source: 'user', timezone: 'UTC' }], { session });
    }
    await AuditLog.create([{ action: 'calendar.external.sync', actor: connection.ownerId, actorRole: role, targetType: link.kind === 'matter' ? 'case' : 'event', targetId: String(link.localId), ...(matter ? { case: matter._id } : {}), meta: { provider: connection.provider, operation: remote.deleted ? 'delete' : local ? 'update' : 'import' } }], { session });
  }, { ownerId: String(connection.ownerId), authVersion: connection.authVersion });
  if (changedMatter) require('../../utils/caseProjectionEvents').publishCaseProjectionRefresh(changedMatter, 'calendar_event_updated_refresh');
}
async function validateOutbound(connection, kind, local) {
  await check(connection);
  if (kind === 'matter') {
    const current = await Case.findById(local._id).lean();
    if (!current || !permission(current, connection.ownerId).readable || hash(matterShape(current)) !== hash(matterShape(local))) fail(409, 'CONFLICT', 'The Matter changed during sync.');
  } else {
    const current = await Event.findOne({ _id: local._id, owner: connection.ownerId }).lean();
    if (!current || hash(eventShape(current)) !== hash(eventShape(local))) fail(409, 'CONFLICT', 'The LPC event changed during sync.');
    if (current.caseId) { const matter = await Case.findById(current.caseId).lean(); if (!matter || !permission(matter, connection.ownerId).readable) fail(403, 'MATTER_CHANGED', 'Matter access changed during sync.'); }
  }
}
async function sync(id, resolution = {}) {
  await Promise.all([Connection.init(), Link.init(), Event.init(), AuditLog.init()]);
  const lease = crypto.randomUUID();
  const connection = await Connection.findOneAndUpdate({ _id: id, ...(resolution.revision ? { revision: resolution.revision } : {}), disconnectedAt: null, needsReconnect: false, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] }, { $set: { lease, leaseUntil: new Date(Date.now() + 120000) } }, { returnDocument: 'after' }).select('+credentials').lean();
  if (!connection) fail(409, 'BUSY', 'Calendar sync is already running, or reconnection is required.');
  const scope = namespace(connection); let conflicts = 0;
  try {
    const user = await owner(connection), accessToken = await token(connection);
    const remotes = await providers.list(connection.provider, accessToken);
    await check(connection);
    const links = await Link.find(scope).lean(), remoteMap = new Map(remotes.map(event => [event.id, event]));
    const events = await Event.find({ owner: connection.ownerId }).limit(10001).lean();
    const matters = await Case.find({ $or: [{ attorney: connection.ownerId }, { attorneyId: connection.ownerId }, { paralegal: connection.ownerId }, { paralegalId: connection.ownerId }] }).limit(10001).lean();
    if (events.length > 10000 || matters.length > 10000) fail(503, 'LIMIT', 'This calendar is too large to sync completely.');
    const eventMap = new Map(events.map(event => [String(event._id), event])), matterMap = new Map(matters.map(matter => [String(matter._id), matter]));
    const claim = async () => {
      await check(connection);
      // Extend only the current lease; another worker can never own this pass.
      await Connection.updateOne({ _id: connection._id, lease, revision: connection.revision }, { $set: { leaseUntil: new Date(Date.now() + 120000) } });
    };
    const saveLink = async (link, localHash, remote, extra = {}) => {
      const values = { remoteId: remote.id, localHash, remoteHash: remote.deleted ? '' : hash(remote), etag: remote.etag || '', conflict: false, deleted: remote.deleted === true, ...extra };
      await Link.updateOne({ ...scope, kind: link.kind, localId: link.localId }, { $set: values }, { upsert: true });
      Object.assign(link, values);
    };
    for (const link of links) {
      await claim();
      const local = (link.kind === 'matter' ? matterMap : eventMap).get(String(link.localId));
      if (link.kind === 'matter' && !local) continue;
      const access = local && (link.kind === 'matter' ? permission(local, connection.ownerId) : local.caseId ? permission(matterMap.get(String(local.caseId)) || {}, connection.ownerId) : { readable: true, writable: true });
      if (local && !access.readable) continue; // Never export after loss of participation.
      let remote = remoteMap.get(link.remoteId);
      if (link.deleted && local && (link.kind === 'matter' ? matterShape(local) : eventShape(local))) {
        await validateOutbound(connection, link.kind, local);
        const restored = link.kind === 'matter' ? matterShape(local) : eventShape(local);
        const identity = crypto.createHash('sha256').update(`${connection._id}:${connection.revision}:${link.kind}:${link.localId}:${hash(restored)}`).digest('hex').slice(0,32);
        let raw;
        try { raw = await providers.request(connection.provider, accessToken, { method: 'POST', body: providers.payload(connection.provider, restored, identity) }); }
        catch (error) { if (connection.provider !== 'google' || error.providerStatus !== 409) throw error; raw = await providers.request(connection.provider, accessToken, { id: identity }); }
        await saveLink(link, hash(restored), providers.normalize(connection.provider, raw)); continue;
      }
      if (link.deleted) continue;
      if (!remote) {
        try { remote = providers.normalize(connection.provider, await providers.request(connection.provider, accessToken, { id: link.remoteId })); }
        catch (error) { if (![404,410].includes(error.providerStatus)) throw error; remote = { id: link.remoteId, deleted: true }; }
      }
      const shape = local ? link.kind === 'matter' ? matterShape(local) : eventShape(local) : null;
      const localHash = shape ? hash(shape) : '', remoteHash = remote.deleted ? '' : hash(remote);
      let localChanged = localHash !== link.localHash, remoteChanged = remoteHash !== link.remoteHash;
      if (String(link._id) === resolution.linkId && ['local','remote'].includes(resolution.prefer)) {
        if (resolution.prefer === 'local') { localChanged = true; remoteChanged = false; }
        else { localChanged = false; remoteChanged = true; }
      }
      if (remote.recurring || local?.rrule || localChanged && remoteChanged && localHash !== remoteHash) {
        conflicts++; await Link.updateOne({ _id: link._id }, { $set: { conflict: true } }); continue;
      }
      if (remoteChanged) {
        if (local && !access.writable) { conflicts++; await Link.updateOne({ _id: link._id }, { $set: { conflict: true } }); continue; }
        try { await apply(connection, link, local, remote, user.role); }
        catch (error) { if ([403,409].includes(error.status)) { conflicts++; await Link.updateOne({ _id: link._id }, { $set: { conflict: true } }); continue; } throw error; }
        const next = remote.deleted ? null : link.kind === 'matter' ? matterShape({ ...local, deadlineDate: remote.start.slice(0, 10) }) : remote;
        await saveLink(link, next ? hash(next) : '', remote);
      } else if (localChanged) {
        if (!shape) {
          try { await providers.request(connection.provider, accessToken, { method: 'DELETE', id: link.remoteId, etag: remote.etag }); }
          catch (error) { if (![404,410].includes(error.providerStatus)) throw error; }
          await saveLink(link, '', { id: link.remoteId, deleted: true });
        } else {
          await validateOutbound(connection, link.kind, local);
          const saved = providers.normalize(connection.provider, await providers.request(connection.provider, accessToken, { method: 'PATCH', id: link.remoteId, etag: remote.etag, body: providers.payload(connection.provider, shape) }));
          await saveLink(link, localHash, saved);
        }
      } else if (link.conflict) await Link.updateOne({ _id: link._id }, { $set: { conflict: false } });
    }
    for (const remote of remotes) {
      if (!remote.identity || links.some(link => link.remoteId === remote.id)) continue;
      const matches = [...events.map(local => ({ kind: 'event', local, shape: eventShape(local) })), ...matters.filter(matterShape).map(local => ({ kind: 'matter', local, shape: matterShape(local) }))];
      const found = matches.find(item => crypto.createHash('sha256').update(`${connection._id}:${connection.revision}:${item.kind}:${item.local._id}`).digest('hex').slice(0,32) === remote.identity);
      if (found) {
        const link = { ...scope, kind: found.kind, localId: found.local._id, remoteId: remote.id };
        const uncertain = hash(found.shape) !== hash(remote);
        await saveLink(link, uncertain ? '' : hash(found.shape), remote, uncertain ? { remoteHash: '', conflict: true } : {}); if (uncertain) conflicts++; links.push(link);
      }
    }
    // Import only unlinked external events; their link and local record are
    // committed together, so a failed acknowledgement cannot duplicate imports.
    for (const remote of remotes) {
      if (remote.deleted || remote.recurring || links.some(link => link.remoteId === remote.id)) continue;
      await claim();
      const localId = new mongoose.Types.ObjectId(hash({ title: String(connection._id) + connection.revision + remote.id, start: '', end: '', isAllDay: false }).slice(0,24));
      const link = { ...scope, kind: 'event', localId, remoteId: remote.id };
      const existing = await Event.findById(localId).lean();
      if (!existing) await apply(connection, link, null, remote, user.role);
      await saveLink(link, hash(remote), remote);
    }
    const imported = new Set((await Link.find({ kind: 'event', localId: { $in: events.map(event => event._id) } }).select('localId').lean()).map(link => String(link.localId)));
    const candidates = [...events.filter(event => !imported.has(String(event._id)) && !event.rrule && (!event.caseId || permission(matterMap.get(String(event.caseId)) || {}, connection.ownerId).readable)).map(event => ({ kind: 'event', local: event, shape: eventShape(event) })), ...matters.filter(matter => permission(matter, connection.ownerId).readable && matterShape(matter)).map(matter => ({ kind: 'matter', local: matter, shape: matterShape(matter) }))];
    for (const candidate of candidates) {
      if (links.some(link => link.kind === candidate.kind && String(link.localId) === String(candidate.local._id))) continue;
      await claim();
      await validateOutbound(connection, candidate.kind, candidate.local);
      const identity = crypto.createHash('sha256').update(`${connection._id}:${connection.revision}:${candidate.kind}:${candidate.local._id}`).digest('hex').slice(0,32);
      // Persist a stable create identity before the remote mutation. Google IDs
      // and Microsoft transactionId make retries reuse the same logical event.
      let raw;
      try { raw = await providers.request(connection.provider, accessToken, { method: 'POST', body: providers.payload(connection.provider, candidate.shape, identity) }); }
      catch (error) { if (connection.provider !== 'google' || error.providerStatus !== 409) throw error; raw = await providers.request(connection.provider, accessToken, { id: identity }); }
      const remote = providers.normalize(connection.provider, raw);
      await saveLink({ ...scope, kind: candidate.kind, localId: candidate.local._id }, hash(candidate.shape), remote);
    }
    await check(connection);
    await Connection.updateOne({ _id: connection._id, lease, revision: connection.revision }, { $set: { lastSyncedAt: new Date(), lastError: conflicts ? 'Some events changed in both calendars or require LPC permissions. Review sync conflicts.' : '' } });
    publishNotificationEvent(connection.ownerId, 'notifications', { type: 'calendar_event_updated_refresh', at: new Date().toISOString() });
    return { synced: true, conflicts };
  } catch (error) {
    await Connection.updateOne({ _id: connection._id, lease, revision: connection.revision }, { $set: { lastError: ['CALENDAR_RECONNECT_REQUIRED','CALENDAR_ACCOUNT_CHANGED'].includes(error.publicCode) ? 'Reconnect your calendar to resume sync.' : 'Sync could not finish. Existing calendar data is kept.' , ...(error.providerStatus === 401 || error.publicCode === 'CALENDAR_ACCOUNT_CHANGED' ? { needsReconnect: true, ...(error.publicCode === 'CALENDAR_ACCOUNT_CHANGED' ? { credentials: '' } : {}) } : {}) } });
    if (error.publicCode) throw error;
    fail(503, 'SYNC_FAILED', 'Sync could not finish. Existing calendar data is kept. Try again shortly.');
  } finally { await Connection.updateOne({ _id: connection._id, lease }, { $set: { lease: '', leaseUntil: null } }); }
}
let timer, running = false;
function start() {
  if (timer || (process.env.NODE_ENV === 'test' && process.env.APP_ENV !== 'local-e2e')) return;
  const tick = async () => {
    if (running || mongoose.connection.readyState !== 1) return; running = true;
    try {
      const rows = await Connection.find({ disconnectedAt: null, needsReconnect: false, $or: [{ lastSyncedAt: null }, { lastSyncedAt: { $lt: new Date(Date.now() - 300000) } }] }).select('_id').sort({ updatedAt: 1, _id: 1 }).limit(100).lean();
      for (const row of rows) await sync(row._id).catch(() => {});
    } catch { /* A later worker pass retries unavailable reads without logging private data. */ } finally { running = false; }
  };
  timer = setInterval(tick, 60000); timer.unref();
  void tick();
}
function stop() { clearInterval(timer); timer = null; }
module.exports = { sync, start, stop, hash, eventShape, matterShape, permission };
