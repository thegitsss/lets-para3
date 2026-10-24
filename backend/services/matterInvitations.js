const validId = value => /^[a-f0-9]{24}$/i.test(String(value || ""));
const id = value => String(value?._id || value?.id || value || "");
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const statuses = new Set(["pending", "accepted", "declined", "expired"]);

// Read raw records: Mongoose defaults and legacy seeding must not invent dates
// or persist a migration while an attorney is viewing invitation history.
function invitationRecords(doc) {
  let complete = doc.invites == null || Array.isArray(doc.invites);
  const records = (Array.isArray(doc.invites) ? doc.invites : []).flatMap(invite => {
    if (!validId(id(invite?.paralegalId))) { complete = false; return []; }
    const status = String(invite.status || "").toLowerCase();
    return [{ paralegalId: id(invite.paralegalId), status: statuses.has(status) ? status : "unknown", invitedAt: date(invite.invitedAt), respondedAt: date(invite.respondedAt) }];
  });
  if (doc.pendingParalegalId && !records.some(item => item.paralegalId === id(doc.pendingParalegalId))) {
    if (validId(id(doc.pendingParalegalId))) records.push({ paralegalId: id(doc.pendingParalegalId), status: "pending", invitedAt: date(doc.pendingParalegalInvitedAt), respondedAt: null });
    else complete = false;
  }
  return { records: records.sort((a, b) => (Date.parse(b.invitedAt) || 0) - (Date.parse(a.invitedAt) || 0)), complete };
}
function shapeInvitations(doc, actorId, records, profiles, complete, blocked = []) {
  const byId = new Map(profiles.map(profile => [id(profile._id), profile]));
  return { caseId: id(doc._id), ownerId: String(actorId), caseTitle: doc.title || "Untitled Matter", complete, invites: records.map(record => {
    const profile = byId.get(record.paralegalId);
    const available = !blocked.includes(record.paralegalId) && !!profile && profile.role === "paralegal" && !profile.deleted && !profile.disabled && profile.status === "approved";
    const name = available ? [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() : "";
    return { paralegal: { id: record.paralegalId, name: name || "Invited paralegal", available, profileImage: available && (profile.profileImage || profile.avatarURL) ? `/api/users/profile-photo/${record.paralegalId}` : null }, status: record.status, invitedAt: record.invitedAt, respondedAt: record.respondedAt };
  }) };
}
async function read(req) {
  // Reuse the fresh account and unambiguous Matter-owner boundary. The original
  // endpoint permits an omitted expectedOwnerId for existing read-only clients.
  const { owner } = require('./matterApplications');
  const User = require('../models/User');
  const { getBlockedUserIds } = require('../utils/blocks');
  const { fingerprint } = require('./matterDraftRevision');
  const actorId = id(req.user.id);
  const checked = { ...req, query: { ...req.query, expectedOwnerId: req.query.expectedOwnerId ?? actorId } };
  const changed = () => { throw Object.assign(new Error('Invitation records changed during this read.'), { status: 409, publicCode: 'INVITATION_CHANGED' }); };
  const initial = await owner(checked);
  const { records, complete } = invitationRecords(initial.doc);
  const blocked = (await getBlockedUserIds(actorId)).map(id).sort();
  const profileRead = () => records.length ? User.find({ _id: { $in: records.map(item => item.paralegalId) } }).select('firstName lastName role status disabled deleted avatarURL profileImage').sort({ _id: 1 }).lean() : Promise.resolve([]);
  const profiles = await profileRead();
  if ((await owner(checked)).revision !== initial.revision) changed();
  if (fingerprint(await profileRead()) !== fingerprint(profiles)) changed();
  if (fingerprint((await getBlockedUserIds(actorId)).map(id).sort()) !== fingerprint(blocked)) changed();
  if ((await owner(checked)).revision !== initial.revision) changed();
  return shapeInvitations(initial.doc, actorId, records, profiles, complete, blocked);
}
module.exports = { invitationRecords, shapeInvitations, read };
