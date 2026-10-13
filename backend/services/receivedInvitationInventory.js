const { Types } = require('mongoose');
const Case = require('../models/Case');
const { read: accountRead } = require('./financialAccountBoundary');
const { fingerprint } = require('./matterDraftRevision');
const { getBlockedUserIds } = require('../utils/blocks');
const id = value => String(value?._id || value?.id || value?.userId || value || '');
const refs = value => [new Types.ObjectId(id(value)), id(value)];
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const validId = value => /^[a-f0-9]{24}$/i.test(value);
const fields = 'title details briefSummary practiceArea state locationState tasks requirements totalAmount lockedTotalAmount currency status escrowStatus deadline deadlineDate zoomLink paymentReleased escrowIntentId jobId createdAt updatedAt attorney attorneyId pendingParalegalId pendingParalegalInvitedAt invites minimumYearsExperience experiencePreference';
const fail = (status, publicCode, message) => { throw Object.assign(new Error(message), { status, publicCode }); };
const changed = () => fail(409, 'INVITATION_CHANGED', 'The invitation queue changed. Refresh to load the current invitations.');
const text = value => ({ $convert: { input: value, to: 'string', onError: '', onNull: '' } });
const person = prefix => text({ $ifNull: [`${prefix}._id`, `${prefix}.id`, `${prefix}.userId`, prefix] });

async function metadata(actorId, blocked) {
  const array = { $cond: [{ $isArray: '$invites' }, '$invites', []] };
  const filter = { archived: { $ne: true }, $or: [{ 'invites.paralegalId': { $in: refs(actorId) } }, { pendingParalegalId: { $in: refs(actorId) } }] };
  if (blocked.length) { filter.attorney = { $nin: blocked.flatMap(refs) }; filter.attorneyId = { $nin: blocked.flatMap(refs) }; }
  const rows = await Case.aggregate([
    { $match: filter },
    { $project: {
      attorney: 1, attorneyId: 1, updatedAt: 1, pendingParalegalId: 1, pendingParalegalInvitedAt: 1,
      invalidArray: { $and: [{ $ne: [{ $ifNull: ['$invites', null] }, null] }, { $not: [{ $isArray: '$invites' }] }] },
      ownEntries: { $map: { input: { $filter: { input: array, as: 'entry', cond: { $eq: [person('$$entry.paralegalId'), actorId] } } }, as: 'entry', in: { status: '$$entry.status', invitedAt: '$$entry.invitedAt' } } },
    } },
    { $sort: { updatedAt: -1, _id: -1 } },
  ]).option({ maxTimeMS: 15000 });
  const decisions=await require('../models/MatterRequirementDecision').find({paralegalId:actorId,matterKey:{$in:rows.map(row=>id(row._id))}}).select('matterKey').lean();
  const excluded=new Set(decisions.map(row=>row.matterKey));
  return rows.flatMap(row => {
    if(excluded.has(id(row._id)))return [];
    if (row.invalidArray || row.ownEntries.length > 1 || row.ownEntries.some(entry => !['pending', 'accepted', 'declined', 'expired'].includes(entry.status))) fail(409, 'INVITATION_SOURCE_INVALID', 'An invitation has inconsistent records. Contact support for help reviewing it.');
    const invite = row.ownEntries.find(entry => entry.status === 'pending') || (!row.ownEntries.length && id(row.pendingParalegalId) === actorId ? { status: 'pending', invitedAt: row.pendingParalegalInvitedAt || null } : null);
    if (!invite) return [];
    if (!validId(id(row.attorney || row.attorneyId)) || row.attorney && row.attorneyId && id(row.attorney) !== id(row.attorneyId)) fail(409, 'INVITATION_SOURCE_INVALID', 'An invitation has inconsistent Matter ownership. Contact support for help reviewing it.');
    return [{ _id: row._id, attorneyId: id(row.attorney || row.attorneyId), updatedAt: row.updatedAt || null, invite: { paralegalId: actorId, status: 'pending', invitedAt: date(invite.invitedAt), respondedAt: null } }];
  });
}

async function read(req, caseSummary) {
  const actorId = id(req.user?.id), account = await accountRead(req, 'paralegal', req.query.expectedOwnerId);
  if (Object.keys(req.query).some(key => !['expectedOwnerId','limit','cursor'].includes(key) || typeof req.query[key] !== 'string')) fail(400, 'INVITATION_INVALID', 'Invalid invitation page.');
  const limitText = req.query.limit || '50', cursor = req.query.cursor || '';
  if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 200 || cursor && !/^[a-f0-9]{64}:(?:0|[1-9]\d{0,8})$/.test(cursor)) fail(400, 'INVITATION_INVALID', 'Invalid invitation page.');
  const limit = Number(limitText), offset = cursor ? Number(cursor.split(':')[1]) : 0;
  const blocked = (await getBlockedUserIds(actorId)).map(id).sort(), all = await metadata(actorId, blocked), revision = fingerprint([account, blocked, all]);
  if (cursor && cursor.split(':')[0] !== revision) changed();
  if (offset > all.length) fail(400, 'INVITATION_INVALID', 'Invalid invitation page.');
  const selected = all.slice(offset, offset + limit), byId = new Map(selected.map(row => [id(row._id), row]));
  const documents = () => selected.length ? Case.find({ _id: { $in: selected.map(row => row._id) } }).select(fields).populate('attorney', 'firstName lastName role avatarURL').populate('attorneyId', 'firstName lastName role avatarURL').sort({ _id: 1 }).lean() : Promise.resolve([]);
  const docs = await documents();
  if (docs.length !== selected.length) changed();
  const summaries = new Map(docs.map(doc => {
    const row = byId.get(id(doc._id));
    if (!row || id(doc.attorney || doc.attorneyId) !== row.attorneyId) changed();
    // A received invitation exposes this paralegal's invitation and reviewable
    // scope, not the identities/responses of other invited paralegals.
    const summary = caseSummary({ ...doc, invites: [row.invite], pendingParalegalId: actorId, pendingParalegalInvitedAt: row.invite.invitedAt }, { viewerRole: 'paralegal', viewerId: actorId });
    if (summary.attorney) delete summary.attorney.email;
    return [id(doc._id), { ...summary, inviteStatus: 'pending', inviteInvitedAt: row.invite.invitedAt }];
  }));
  if (fingerprint(await documents()) !== fingerprint(docs)) changed();
  const currentBlocked = (await getBlockedUserIds(actorId)).map(id).sort();
  const currentAccount = await accountRead(req, 'paralegal', req.query.expectedOwnerId);
  if (fingerprint([currentAccount, currentBlocked, await metadata(actorId, currentBlocked)]) !== revision) changed();
  const end = offset + selected.length, hasMore = end < all.length;
  return { ownerId: actorId, revision, items: selected.map(row => summaries.get(id(row._id))), page: { total: all.length, offset, limit, hasMore, nextCursor: hasMore ? `${revision}:${end}` : null } };
}
module.exports = { read, metadata };
