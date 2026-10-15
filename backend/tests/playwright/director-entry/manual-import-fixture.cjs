'use strict';

// Exercise the actual Director routes, session checks, mappers and persisted
// records. Only the mailbox transport is replaced, before the service is loaded.
const path = require('node:path');
const moduleId = require.resolve('../../../services/director/mailImportService');
const actual = require(moduleId);
const calls = [];
let implementation;
const emailId = require.resolve('../../../utils/email');
const serviceId = require.resolve('../../../services/director/directorPortalService');
const serviceBindings = new Map(), senderIds = new WeakMap();
let nextSenderId = 0;
function senderId(sender) {
  if (typeof sender !== 'function') throw Error('The installed synthetic email capture must be a function.');
  if (!senderIds.has(sender)) senderIds.set(sender, 'fixture-email-function-' + ++nextSenderId);
  return senderIds.get(sender);
}
async function start(options) {
  const previouslyLoaded = require.cache[serviceId]?.exports;
  const server = await require('../../helpers/financialLifecycleBrowserServer')(options);
  const service = require.cache[serviceId]?.exports, installedSender = require.cache[emailId]?.exports;
  const activeCalls = server.evidence().external.mail;
  // The actual service captures its sender on first module load. A later local
  // harness can replace require.cache without changing that captured function.
  // Retain its observed owning capture; never clear the application cache.
  if (!previouslyLoaded && service) serviceBindings.set(service, { service, sender: installedSender, calls: activeCalls });
  const owning = serviceBindings.get(service);
  if (!owning) { await server.close(); throw Error('The cached Director sender has no observed owning capture.'); }
  const binding = { owningSenderId: senderId(owning.sender), activeInstalledSenderId: senderId(installedSender),
    owningSenderIsActiveInstalledSender: owning.sender === installedSender, serviceFirstLoadedDuringThisStart: !previouslyLoaded };
  server.noticeEvidence = () => ({ ...binding, currentRequireCacheSenderId: senderId(require.cache[emailId].exports),
    serviceCacheStillSameObservedExports: require.cache[serviceId].exports === owning.service,
    actualOwningCaptureCalls: [...owning.calls], activeHarnessCaptureCalls: [...activeCalls], mockedTransportOnly: true });
  const reset = server.reset;
  server.reset = async () => { await reset(); owning.calls.length = 0; };
  return server;
}
require.cache[moduleId] = { id: moduleId, filename: moduleId, loaded: true, exports: {
  ...actual,
  fetchZohoMessages: async input => {
    calls.push({ ownerId: String(input.profile.userId), mailbox: input.profile.zohoEmail,
      folderKind: input.folderKind, fromDate: input.fromDate, toDate: input.toDate });
    if (!implementation) throw Error('No synthetic mailbox response has been configured.');
    return implementation(input);
  },
} };

function sentMessage(ownerId) {
  return { subject: 'On-demand paralegal support for your firm',
    toAddress: `"Synthetic Import Attorney" <import-${ownerId}@example.test>`,
    sentDate: new Date(Date.now() - 5000).toISOString(), messageId: `isolated-sent-${ownerId}` };
}
function configure(fn = input => input.folderKind === 'sent' ? [sentMessage(String(input.profile.userId))] : []) {
  calls.length = 0; implementation = fn;
}
function deferred() { let release; return { promise: new Promise(resolve => { release = resolve; }), release: value => release(value) }; }

async function snapshot() {
  const Profile = require('../../../models/DirectorProfile');
  const Record = require('../../../models/DirectorOutreachRecord');
  const Event = require('../../../models/DirectorOutreachEvent');
  return JSON.parse(JSON.stringify({
    profiles: (await Profile.find().sort({ userId: 1 }).lean()).map(row => ({ ...row, id: row._id, ownerId: row.userId })),
    records: await Record.find().sort({ _id: 1 }).lean(),
    events: await Event.find().sort({ _id: 1 }).lean(),
  }));
}

async function current(context, origin, actor, expect) {
  const response = await context.get(origin + '/api/auth/me');
  expect(response.status()).toBe(200); const payload = await response.json();
  expect(payload.user.id).toBe(actor.id); expect(payload.user.role).toBe('director');
  expect(payload.user.status).toBe('approved'); return payload.user;
}
async function review(context, origin, actor, expect) {
  await current(context, origin, actor, expect);
  const response = await context.get(origin + '/api/director/overview?expectedOwnerId=' + actor.id);
  expect(response.status()).toBe(200); const payload = await response.json();
  expect(payload.ownerId).toBe(actor.id); return payload;
}
async function csrf(context, origin, expect) {
  const response = await context.get(origin + '/api/csrf'); expect(response.status()).toBe(200);
  const token = (await response.json()).csrfToken; expect(token).toBeTruthy(); return token;
}
async function revoke(actor, kind) {
  const User = require('../../../models/User'), Session = require('../../../models/AuthSession');
  if (kind === 'disabled') await User.updateOne({ _id: actor.id }, { $set: { disabled: true } });
  else if (kind === 'auth-version') await User.updateOne({ _id: actor.id }, { $inc: { authVersion: 1 } });
  else if (kind === 'managed-session') await Session.updateMany({ userId: actor.id }, { $set: { revokedAt: new Date(), revokedReason: 'Isolated manual import authority diagnostic.' } });
  else throw Error('Unsupported diagnostic revocation.');
}

module.exports = { start, configure, sentMessage, deferred,
  snapshot, current, review, csrf, revoke, calls,
  sourceBoundary: path.relative(process.cwd(), moduleId) };
