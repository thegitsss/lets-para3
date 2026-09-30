const { buildAuthenticatedProfilePhotoUrl } = require('./profilePhotoDelivery');
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const User = require("../models/User");
const { findActiveSession } = require("./authSessionService");
const { fingerprint } = require("./matterDraftRevision");
const { invitationRecords } = require("./matterInvitations");
const { normalizeHttpUrl } = require("../utils/httpUrl");
const { id, validId, refs, uniqueRecords, one, normalizedId } = require("./applicationIdentity");

const PAGE_SIZE = 25;
const text = value => typeof value === "string" ? value : "";
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const statuses = new Set(["submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn"]);
const status = value => value === "pending" ? "submitted" : statuses.has(value) ? value : "unknown";
// Case.applicants has the earlier pending/accepted/rejected enum. Viewed and
// shortlisted live on Application; their compatible Matter entry stays pending.
const mirrorStatusMatches = (applicationStatus, matterStatus) => status(applicationStatus) === status(matterStatus) || matterStatus === "pending" && ["submitted", "viewed", "shortlisted"].includes(applicationStatus);
const fields = "attorney attorneyId title status archived readOnly job jobId applicants invites pendingParalegalId pendingParalegalInvitedAt paralegal paralegalId hiredAt hiringClaimToken hiringClaimStatus hiringClaimParalegalId escrowStatus paymentReleased pausedReason relistPending disputes preEngagement".split(" ");
const projection = Object.fromEntries(fields.map(key => [key, 1]));
const applicationProjection = Object.fromEntries("jobId paralegalId coverLetter resumeURL linkedInURL profileSnapshot scopeSnapshot requirementConfirmations status createdAt withdrawnAt statusHistory starredBy syncStatus".split(" ").map(key => [key, 1]));
const fail = (httpStatus, publicCode, message) => { throw Object.assign(new Error(message), { status: httpStatus, publicCode }); };
const changed = () => fail(409, "APPLICATION_REVIEW_CHANGED", "The applications changed during this read. Refresh to review the current records.");

async function owner(req, session) {
  const actorId = id(req.user?.id), caseId = req.params.caseId;
  if (!["attorney", "admin"].includes(req.user?.role)) fail(403, "APPLICATION_REVIEW_RESTRICTED", "Only the Matter attorney or an administrator can review its applications.");
  if (!validId(actorId) || !validId(caseId)) fail(400, "APPLICATION_REVIEW_INVALID", "Invalid Matter.");
  if (typeof req.query.expectedOwnerId !== 'string' || id(req.query.expectedOwnerId) !== actorId) fail(403, "APPLICATION_REVIEW_ACCOUNT_CHANGED", "The signed-in account changed. Sign in again to review applications.");
  const user = await one(User, actorId, { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 }, session);
  if (!user || user.role !== req.user.role || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0)) fail(403, "APPLICATION_REVIEW_ACCOUNT_CHANGED", "This account can no longer review applications.");
  if (req.authSessionId && !await findActiveSession(req.authSessionId, actorId)) fail(403, "APPLICATION_REVIEW_ACCOUNT_CHANGED", "Your session ended. Sign in again to review applications.");
  const doc = await one(Case, caseId, projection, session);
  if (!doc || user.role !== 'admin' && ![doc.attorney, doc.attorneyId].some(value => id(value) === actorId)) fail(404, "APPLICATION_REVIEW_NOT_FOUND", "This Matter is no longer available.");
  if (doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "This Matter's ownership needs verification before applications can be shown.");
  return { doc, user, revision: fingerprint([doc, user]) };
}

// Follow only a posting that belongs to this Matter and its recorded attorney.
// Use raw reads throughout: viewing applications must not seed or repair records.
function applicationContextFromRecords(doc, jobs, { maxEmbedded = 2000 } = {}) {
  if (doc.job && doc.jobId && id(doc.job) !== id(doc.jobId)) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "The posting linked to this Matter needs verification.");
  const linkedId = doc.jobId || doc.job;
  if (linkedId && !validId(linkedId)) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "The posting linked to this Matter needs verification.");
  const job = jobs[0];
  if (jobs.length > 1 || (job && (id(job.caseId) !== id(doc._id) || id(job.attorneyId) !== id(doc.attorneyId || doc.attorney)))) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "The posting linked to this Matter needs verification.");
  const warnings = linkedId && !job ? ["posting_missing"] : [];
  const embedded = Array.isArray(doc.applicants) ? doc.applicants : [];
  if (doc.applicants != null && !Array.isArray(doc.applicants)) warnings.push("unreadable_records");
  // A Case is already a bounded Mongo document; cap legacy join keys separately.
  if (embedded.length > maxEmbedded) fail(413, "APPLICATION_REVIEW_TOO_LARGE", "This Matter has too many earlier application records to review here. Contact support for help reviewing them.");
  const byPerson = new Map();
  for (const item of embedded) {
    if (!validId(item?.paralegalId)) { warnings.push("unreadable_records"); continue; }
    const key = id(item.paralegalId);
    if (byPerson.has(key)) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "Duplicate application records need verification before this list can be shown.");
    byPerson.set(key, item);
  }
  return { job, byPerson, warnings: [...new Set(warnings)] };
}
async function applicationContext(doc, session, options) {
  const linkedId = doc.jobId || doc.job;
  if (linkedId && !validId(linkedId)) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "The posting linked to this Matter needs verification.");
  const jobs = await Job.collection.find(linkedId ? { _id: { $in: refs(linkedId) } } : { caseId: { $in: refs(doc._id) } }, { projection: { attorneyId: 1, caseId: 1, status: 1 }, session }).limit(2).toArray();
  return applicationContextFromRecords(doc, jobs, options);
}

async function source(doc, query, session) {
  // A selected review needs only its own canonical/earlier join. It can remain
  // readable without sending every embedded applicant ID to MongoDB.
  const { job, byPerson, warnings } = await applicationContext(doc, session, { maxEmbedded: query.applicantId ? Infinity : 2000 });
  const jobFilter = job ? { jobId: { $in: refs(job._id) } } : null;
  if (query.applicantId) {
    const canonical = job ? await Application.collection.find({ ...jobFilter, paralegalId: { $in: refs(query.applicantId) } }, { projection: applicationProjection, session, maxTimeMS: 15000 }).limit(2).toArray() : [];
    if (canonical.length > 1) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "Duplicate application records need verification before this application can be shown.");
    if (canonical.some(item => !validId(item._id) || !validId(item.paralegalId))) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "Application records need verification before this list can be shown.");
    if (canonical.length) await uniqueRecords(Application, { _id: { $in: refs(canonical[0]._id) } }, { _id: 1 }, session);
    const mirror = byPerson.get(query.applicantId), earlier = !canonical.length && mirror ? [mirror] : [];
    return { job, canonical, earlier, byPerson, next: null, warnings, revision: fingerprint([job, canonical, earlier, null]) };
  }
  const mirrored = job && byPerson.size ? await Application.collection.find({ ...jobFilter, paralegalId: { $in: [...byPerson.keys()].flatMap(refs) } }, { projection: { paralegalId: 1 }, session }).limit(4001).toArray() : [];
  if (mirrored.length > 4000) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "Duplicate application records need verification before this list can be shown.");
  const represented = new Set(mirrored.map(item => id(item.paralegalId)));
  const legacy = [...byPerson.values()].filter(item => !represented.has(id(item.paralegalId))).sort((a, b) => (Date.parse(date(b.appliedAt)) || 0) - (Date.parse(date(a.appliedAt)) || 0) || id(a.paralegalId).localeCompare(id(b.paralegalId)));
  let canonical = [], earlier = [], next = null;
  if (!query.cursor.startsWith("m:")) {
    canonical = job ? await Application.collection.aggregate([
      { $match: jobFilter }, { $set: { normalizedApplicationId: normalizedId('$_id') } },
      ...(query.cursor ? [{ $match: { normalizedApplicationId: { $lt: id(query.cursor.slice(2)) } } }] : []),
      { $sort: { normalizedApplicationId: -1 } }, { $limit: PAGE_SIZE + 1 }, { $project: applicationProjection },
    ], { session, maxTimeMS: 15000 }).toArray() : [];
    if (canonical.some(item => !validId(item._id))) fail(409, 'APPLICATION_REVIEW_SOURCE_INVALID', 'Application records need verification before this list can be shown.');
    if (canonical.length) await uniqueRecords(Application, { _id: { $in: canonical.flatMap(item => refs(item._id)) } }, { _id: 1 }, session);
    if (canonical.length > PAGE_SIZE) { canonical.pop(); next = `a:${id(canonical.at(-1)._id)}`; }
    else if (canonical.length && legacy.length) next = "m:0";
    else if (!canonical.length) { earlier = legacy.slice(0, PAGE_SIZE); if (legacy.length > PAGE_SIZE) next = `m:${PAGE_SIZE}`; }
  } else {
    const offset = Number(query.cursor.slice(2));
    earlier = legacy.slice(offset, offset + PAGE_SIZE);
    if (legacy.length > offset + PAGE_SIZE) next = `m:${offset + PAGE_SIZE}`;
  }
  const people = new Set();
  for (const item of canonical) {
    if (!validId(item._id) || !validId(item.paralegalId) || people.has(id(item.paralegalId))) fail(409, "APPLICATION_REVIEW_SOURCE_INVALID", "Application records need verification before this list can be shown.");
    people.add(id(item.paralegalId));
  }
  return { job, canonical, earlier, byPerson, next, warnings: [...new Set(warnings)], revision: fingerprint([job, mirrored, canonical, earlier, next]) };
}

function snapshotProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { location: text(value.location), availability: text(value.availability), bio: text(value.bio), yearsExperience: Number.isFinite(value.yearsExperience) && value.yearsExperience >= 0 ? value.yearsExperience : null, languages: Array.isArray(value.languages) ? value.languages.filter(item => typeof item === "string") : [], specialties: Array.isArray(value.specialties) ? value.specialties.filter(item => typeof item === "string") : [] };
}
function shape(item, mirror, profile, blocked, actorId, doc, canonical) {
  const personId = id(item.paralegalId), available = !!profile && profile.role === "paralegal" && profile.status === "approved" && !profile.disabled && !profile.deleted && !blocked;
  const warnings = [];
  if (!canonical) warnings.push("earlier_record");
  else {
    if (["pending", "needs_reconciliation"].includes(item.syncStatus)) warnings.push("sync_pending");
    if (!mirror && status(item.status) !== "withdrawn") warnings.push("matter_entry_missing");
    if (mirror && (!mirrorStatusMatches(item.status, mirror.status) || text(item.coverLetter) !== text(mirror.note) || text(item.resumeURL) !== text(mirror.resumeURL) || text(item.linkedInURL) !== text(mirror.linkedInURL) || fingerprint(snapshotProfile(item.profileSnapshot)) !== fingerprint(snapshotProfile(mirror.profileSnapshot)))) warnings.push("records_differ");
  }
  const invites = invitationRecords(doc).records.filter(record => id(record.paralegalId) === personId);
  const linkedIn = normalizeHttpUrl(text(item.linkedInURL), { requiredHost: "linkedin.com" });
  return {
    applicationId: canonical ? id(item._id) : null, applicantId: personId,
    name: available ? [text(profile.firstName), text(profile.lastName)].filter(Boolean).join(" ") || "Paralegal applicant" : "Paralegal applicant",
    profileImage: available && (profile.profileImage || profile.avatarURL) ? buildAuthenticatedProfilePhotoUrl(profile) : null,
    profileAvailable: available, blocked, assigned: personId === id(doc.paralegalId || doc.paralegal),
    status: status(item.status), matterStatus: mirror ? status(mirror.status) : null,
    appliedAt: date(canonical ? item.createdAt : item.appliedAt), withdrawnAt: date(item.withdrawnAt),
    requirementConfirmations: (item.requirementConfirmations || []).map(value=>({requirement:String(value.requirement||""),meets:value.meets===true})),
    coverLetter: text(canonical ? item.coverLetter : item.note), profileSnapshot: snapshotProfile(item.profileSnapshot),
    resumeRecorded: !!text(item.resumeURL), linkedInRecorded: !!text(item.linkedInURL),
    linkedInReference: linkedIn.ok && linkedIn.value ? linkedIn.value : null,
    starred: Array.isArray(item.starredBy) && item.starredBy.some(value => id(value) === actorId),
    history: (Array.isArray(item.statusHistory) ? item.statusHistory : []).slice(-50).map(entry => ({ from: status(entry?.from), to: status(entry?.to), at: date(entry?.at) })),
    invitations: invites.map(({ status: invitationStatus, invitedAt, respondedAt }) => ({ status: invitationStatus, invitedAt, respondedAt })), warnings,
  };
}
async function read(req) {
  if (Object.keys(req.query).some(key => !["expectedOwnerId", "cursor", "applicantId"].includes(key))) fail(400, "APPLICATION_REVIEW_INVALID", "Invalid application page.");
  const cursor = req.query.cursor || "", applicantId = req.query.applicantId || "";
  if (typeof cursor !== "string" || !/^(?:a:[a-f0-9]{24}|m:(?:0|[1-9]\d{0,3}))?$/i.test(cursor) || (applicantId && !validId(applicantId)) || typeof applicantId !== "string" || (cursor && applicantId)) fail(400, "APPLICATION_REVIEW_INVALID", "Invalid application page. Return to the first page and try again.");
  const selectedId = applicantId ? id(applicantId) : '';
  const initial = await owner(req), first = await source(initial.doc, { cursor, applicantId: selectedId });
  const records = [...first.canonical, ...first.earlier];
  const profiles = records.length ? await uniqueRecords(User, { _id: { $in: records.flatMap(item => refs(item.paralegalId)) } }, { firstName: 1, lastName: 1, profileImage:1, avatarURL:1, role: 1, status: 1, disabled: 1, deleted: 1 }) : [];
  const { getBlockedUserIds } = require("../utils/blocks");
  const blocked = new Set((await getBlockedUserIds(req.user.id)).map(id));
  const current = await owner(req);
  if (current.revision !== initial.revision) changed();
  const latest = await source(current.doc, { cursor, applicantId: selectedId });
  if (latest.revision !== first.revision) changed();
  // Profiles can be removed while the application read is in flight.
  const currentProfiles = records.length ? await uniqueRecords(User, { _id: { $in: records.flatMap(item => refs(item.paralegalId)) } }, { firstName: 1, lastName: 1, profileImage:1, avatarURL:1, role: 1, status: 1, disabled: 1, deleted: 1 }) : [];
  if (fingerprint(profiles) !== fingerprint(currentProfiles)) changed();
  const currentBlocked = new Set((await getBlockedUserIds(req.user.id)).map(id));
  if (records.some(item => blocked.has(id(item.paralegalId)) !== currentBlocked.has(id(item.paralegalId)))) changed();
  const finalOwner = await owner(req); if (finalOwner.revision !== initial.revision) changed();
  const byId = new Map(profiles.map(profile => [id(profile._id), profile]));
  return { caseId: id(initial.doc._id), ownerId: id(req.user.id), caseTitle: text(initial.doc.title) || "Untitled Matter", caseStatus: text(initial.doc.status), archived: initial.doc.archived === true, selectedApplicantId: selectedId || null, cursor, next: first.next, warnings: first.warnings, applications: records.map((item, index) => shape(item, first.byPerson.get(id(item.paralegalId)), byId.get(id(item.paralegalId)), blocked.has(id(item.paralegalId)), id(req.user.id), initial.doc, index < first.canonical.length)) };
}
// Server-only document lookup. Reuse the same owner, posting and duplicate-record
// checks as the application reader; never substitute the current User profile.
async function selectedRecords(req, session) {
  if (typeof req.params.applicantId !== "string" || !validId(req.params.applicantId)) fail(400, "APPLICATION_REVIEW_INVALID", "Invalid applicant.");
  const applicantId = id(req.params.applicantId);
  const initial = await owner(req, session), records = await source(initial.doc, { applicantId, cursor: "" }, session);
  const record = records.canonical[0] || records.earlier[0];
  if (!record) fail(404, "APPLICATION_REVIEW_NOT_FOUND", "This application is no longer available.");
  if ((await owner(req, session)).revision !== initial.revision) changed();
  return { doc: initial.doc, user: initial.user, job: records.job, record, mirror: records.byPerson.get(applicantId), applicationId: records.canonical.length ? id(record._id) : null, resumeReference: text(record.resumeURL), revision: fingerprint([initial.revision, records.revision]) };
}
async function selectedSnapshot(req) { const { applicationId, resumeReference, revision } = await selectedRecords(req); return { applicationId, resumeReference, revision }; }
module.exports = { read, selectedSnapshot, selectedRecords, owner, applicationContext, applicationContextFromRecords, shapeApplication: shape, applicationProjection, snapshotProfile, mirrorStatusMatches, PAGE_SIZE };
