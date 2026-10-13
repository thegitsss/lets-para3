const Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application');
const User = require('../models/User'), Block = require('../models/Block');
const { id, validId, refs, uniqueRecords, invalid } = require('./applicationIdentity');
const { applicationContextFromRecords } = require('./matterApplications');
const { assertAccount, openMatter, openPosting, PENDING_STATUSES } = require('./accountApplicationProjections');
const { fingerprint } = require('./matterDraftRevision');
const { presentApplicationProfileSnapshot } = require('../utils/profileSnapshots');
const { buildAuthenticatedProfilePhotoUrl } = require('./profilePhotoDelivery');
const fields = names => Object.fromEntries(names.split(' ').map(key => [key, 1]));
const text = value => typeof value === 'string' ? value : '';
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const changed = () => { throw Object.assign(new Error('Applications changed while loading. Refresh to review the current records.'), { status: 409, publicCode: 'APPLICATION_REVIEW_CHANGED' }); };
const baseFields = fields('title attorney attorneyId job jobId status archived paymentReleased escrowStatus paralegal paralegalId pendingParalegalId pendingParalegalInvitedAt');

// The earlier array contract excludes withdrawn records. Canonical outcomes
// still suppress their embedded mirrors; retained history remains in inventory.
// Counts are actionable applications, using the account/Home context rules.
async function source(caseIds, detailed) {
  const matterProjection = { ...baseFields, ...(detailed ? fields('applicants invites preEngagement') : fields('applicants.paralegalId applicants.status')) };
  const matters = caseIds.length ? await uniqueRecords(Case, { _id: { $in: caseIds.flatMap(refs) } }, matterProjection) : [];
  if (matters.length !== caseIds.length) changed();
  const linkedIds = matters.map(doc => doc.jobId || doc.job).filter(Boolean);
  if (linkedIds.some(value => !validId(value))) invalid();
  const jobs = matters.length ? await uniqueRecords(Job, { $or: [{ _id: { $in: linkedIds.flatMap(refs) } }, { caseId: { $in: caseIds.flatMap(refs) } }] }, fields('attorneyId caseId status')) : [];
  const contexts = new Map();
  for (const doc of matters) {
    if (doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)) invalid();
    const linked = doc.jobId || doc.job;
    const matches = jobs.filter(job => linked ? id(job._id) === id(linked) : id(job.caseId) === id(doc._id));
    const context = applicationContextFromRecords(doc, matches, { maxEmbedded: Infinity });
    if (context.warnings.includes('unreadable_records')) invalid();
    contexts.set(id(doc._id), context);
  }
  const jobIds = [...new Set([...contexts.values()].filter(value => value.job).map(value => id(value.job._id)))];
  const applications = jobIds.length ? await uniqueRecords(Application, { jobId: { $in: jobIds.flatMap(refs) } }, detailed ? fields('jobId paralegalId status createdAt coverLetter resumeURL linkedInURL profileSnapshot starredBy') : fields('jobId paralegalId status')) : [];
  if (applications.length) await uniqueRecords(Application, { _id: { $in: applications.flatMap(value => refs(value._id)) } }, { _id: 1 });
  const byJob = new Map();
  for (const app of applications) {
    if (!validId(app.paralegalId)) invalid();
    const jobKey = id(app.jobId), personKey = id(app.paralegalId);
    if (!byJob.has(jobKey)) byJob.set(jobKey, new Map());
    if (byJob.get(jobKey).has(personKey)) invalid();
    byJob.get(jobKey).set(personKey, app);
  }
  const ownerIds = [...new Set(matters.map(doc => id(doc.attorneyId || doc.attorney)).filter(validId))];
  const blocks = ownerIds.length ? await Block.collection.find({ active: { $ne: false }, $or: [{ blockerId: { $in: ownerIds.flatMap(refs) } }, { blockedId: { $in: ownerIds.flatMap(refs) } }] }, { projection: { blockerId: 1, blockedId: 1 }, maxTimeMS: 15000 }).sort({ _id: 1 }).toArray() : [];
  const pairs = new Set(blocks.flatMap(block => [`${id(block.blockerId)}:${id(block.blockedId)}`, `${id(block.blockedId)}:${id(block.blockerId)}`]));
  const rows = new Map();
  for (const doc of matters) {
    const context = contexts.get(id(doc._id)), ownerId = id(doc.attorneyId || doc.attorney);
    const records = new Map([...context.byPerson].map(([personId, record]) => [personId, { record, canonical: false }]));
    for (const [personId, record] of byJob.get(id(context.job?._id)) || []) records.set(personId, { record, canonical: true });
    const accepting = openMatter(doc) && (context.job ? openPosting(context.job, doc) : !(doc.jobId || doc.job));
    rows.set(id(doc._id), [...records].map(([personId, value]) => {
      const blocked = pairs.has(`${ownerId}:${personId}`), status = text(value.record.status).toLowerCase() || 'unknown';
      return { ...value, personId, blocked, pending: accepting && !blocked && (value.canonical ? PENDING_STATUSES.has(status) : status === 'pending') };
    }));
  }
  const peopleIds = detailed ? [...new Set([...rows.values()].flat().map(row => row.personId).concat(matters.flatMap(doc => [...(doc.invites || []).map(invite => id(invite.paralegalId)), id(doc.pendingParalegalId)]).filter(validId)))] : [];
  const people = peopleIds.length ? await uniqueRecords(User, { _id: { $in: peopleIds.flatMap(refs) } }, fields('firstName lastName email role status disabled deleted profileImage avatarURL bio about practiceAreas specialties skills experience yearsExperience location state')) : [];
  return { matters, rows, people, postings: new Map([...contexts].map(([caseId, context]) => [caseId, context.job])), revision: fingerprint([matters, jobs, applications, blocks, people]) };
}

async function begin(req, docs, { detailed = false } = {}) {
  await assertAccount(req, req.user.role);
  const caseIds = [...new Set(docs.map(doc => id(doc._id)))];
  if (caseIds.some(value => !validId(value))) invalid();
  const first = await source(caseIds, detailed);
  if (req.user.role === 'attorney' && first.matters.some(doc => ![doc.attorney, doc.attorneyId].some(value => id(value) === id(req.user.id)))) throw Object.assign(new Error('Matter not found.'), { status: 404, publicCode: 'APPLICATION_REVIEW_NOT_FOUND' });
  return {
    ...first,
    counts: new Map([...first.rows].map(([caseId, rows]) => [caseId, rows.filter(row => row.pending).length])),
    async verify() {
      const current = await source(caseIds, detailed);
      await assertAccount(req, req.user.role);
      if (current.revision !== first.revision) changed();
    },
  };
}

function present(snapshot, caseId, viewer, { withPreEngagement = false } = {}) {
  const doc = snapshot.matters.find(value => id(value._id) === id(caseId));
  const people = new Map(snapshot.people.map(person => [id(person._id), person]));
  const actorId = id(viewer.id || viewer._id), role = viewer.role;
  return (snapshot.rows.get(id(caseId)) || []).filter(row => row.record.status !== 'withdrawn' && (role !== 'attorney' || !row.blocked) && (role !== 'paralegal' || row.personId === actorId)).map(row => {
    const { record, canonical, personId } = row;
    const current = people.get(personId);
    const person = current?.role === 'paralegal' && current.status === 'approved' && !current.disabled && !current.deleted ? current : null;
    const invite = (doc.invites || []).find(value => id(value.paralegalId) === personId);
    const letter = text(canonical ? record.coverLetter : record.note) || (withPreEngagement && invite?.status === 'accepted' ? 'Accepted invitation' : '');
    const pre = doc.preEngagement;
    return {
      status: text(record.status) || 'unknown', appliedAt: date(canonical ? record.createdAt : record.appliedAt),
      note: letter, coverLetter: letter, resumeURL: text(record.resumeURL), linkedInURL: text(record.linkedInURL),
      profileSnapshot: presentApplicationProfileSnapshot(record.profileSnapshot, person || {}),
      applicationId: canonical ? id(record._id) : null,
      starred: ['attorney', 'admin'].includes(role) && Array.isArray(record.starredBy) && record.starredBy.some(value => id(value) === actorId),
      paralegalId: personId,
      paralegal: person ? { id: personId, firstName: person.firstName || null, lastName: person.lastName || null, name: [person.firstName, person.lastName].filter(Boolean).join(' ') || null, email: person.email || null, role: person.role, profileImage: person.profileImage || person.avatarURL ? buildAuthenticatedProfilePhotoUrl(person) : null } : null,
      ...(withPreEngagement ? { preEngagement: pre && id(pre.requestedParalegalId) === personId && ['submitted', 'approved', 'changes_requested'].includes(pre.status) ? {
        status: pre.status, confidentialityAgreementRequired: !!pre.confidentialityAgreementRequired, conflictsCheckRequired: !!pre.conflictsCheckRequired,
        conflictsDetails: pre.conflictsDetails || '', confidentialityDocument: pre.confidentialityDocument || null, paralegalConfidentialityDocument: pre.paralegalConfidentialityDocument || null,
        confidentialityAcknowledged: !!pre.confidentialityAcknowledged, confidentialityAcknowledgedAt: pre.confidentialityAcknowledgedAt || null,
        conflictsResponseType: pre.conflictsResponseType || '', conflictsDisclosureText: pre.conflictsDisclosureText || '', submittedAt: pre.submittedAt || null,
        reviewedAt: pre.reviewedAt || null, reviewedBy: pre.reviewedBy ? id(pre.reviewedBy) : null,
      } : null } : {}),
    };
  });
}

module.exports = { begin, present };
