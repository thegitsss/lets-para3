const { id, refs, uniqueRecords } = require('./applicationIdentity');
const Case = require('../models/Case');
const Application = require('../models/Application');
const User = require('../models/User');
const { fingerprint } = require('./matterDraftRevision');
const { getBlockedUserIds } = require('../utils/blocks');
const { owner, applicationContext, applicationProjection, shapeApplication, PAGE_SIZE } = require('./matterApplications');

const STATUSES = ['submitted', 'viewed', 'shortlisted', 'accepted', 'rejected', 'withdrawn', 'unknown'];
const text = value => ({ $convert: { input: value, to: 'string', onError: '', onNull: '' } });
const date = value => ({ $convert: { input: value, to: 'date', onError: null, onNull: null } });
const normalizedId = value => ({ $toLower: text(value) });
const validId = value => ({ $regexMatch: { input: value, regex: /^[a-f0-9]{24}$/ } });
const status = value => ({ $switch: { branches: [{ case: { $eq: [value, 'pending'] }, then: 'submitted' }, ...STATUSES.map(key => ({ case: { $eq: [value, key] }, then: key }))], default: 'unknown' } });
const fail = (status, publicCode, message) => { throw Object.assign(new Error(message), { status, publicCode }); };
const changed = () => fail(409, 'APPLICATION_REVIEW_CHANGED', 'The applications changed during this read. Refresh to review the current records.');

function parseQuery(query) {
  const allowed = ['expectedOwnerId', 'page', 'sort', 'status', 'q', 'applicantId'];
  if (Object.keys(query).some(key => !allowed.includes(key) || typeof query[key] !== 'string')) fail(400, 'APPLICATION_REVIEW_INVALID', 'Invalid application view.');
  const page = query.page || '1', sort = query.sort || 'newest', selectedStatus = query.status || 'all', search = (query.q || '').trim(), applicantId = (query.applicantId || '').toLowerCase();
  if (!/^[1-9]\d{0,6}$/.test(page) || Number(page) > 1000000 || !['newest', 'oldest', 'name', 'starred'].includes(sort) || !['all', ...STATUSES].includes(selectedStatus) || (query.q || '').length > 200 || /[\u0000-\u001f\u007f]/.test(search) || applicantId && !/^[a-f0-9]{24}$/.test(applicantId)) fail(400, 'APPLICATION_REVIEW_INVALID', 'Invalid application view.');
  return { page: Number(page), sort, status: selectedStatus, search, applicantId };
}

// Canonical applications and earlier Matter entries share one metadata order.
// Letters, stored profiles and document references are loaded only for this page.
function pipeline(doc, job, actorId, blocked, filters) {
  const metadata = (kind, prefix = '') => ({
    kind: { $literal: kind }, priority: { $literal: kind === 'canonical' ? 0 : 1 },
    personId: normalizedId(`$${prefix}paralegalId`),
    recordId: kind === 'canonical' ? normalizedId('$_id') : { $literal: '' },
    status: status(`$${prefix}status`), appliedAt: date(`$${prefix}${kind === 'canonical' ? 'createdAt' : 'appliedAt'}`),
    starred: { $in: [actorId, { $map: { input: { $cond: [{ $isArray: `$${prefix}starredBy` }, `$${prefix}starredBy`, []] }, as: 'actor', in: normalizedId('$$actor') } }] },
  });
  const match = { valid: true };
  if (filters.applicantId) match.personId = filters.applicantId;
  else {
    if (filters.status !== 'all') match.status = filters.status;
    if (filters.search) match.$expr = { $regexMatch: { input: '$name', regex: filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' } };
  }
  const tie = { personId: 1 }, recent = { appliedAt: -1, ...tie };
  const sort = filters.sort === 'oldest' ? { missingDate: 1, appliedAt: 1, ...tie } : filters.sort === 'name' ? { name: 1, ...tie } : filters.sort === 'starred' ? { starred: -1, ...recent } : recent;
  return [
    { $match: { _id: doc._id } },
    { $project: { applicants: { $cond: [{ $isArray: '$applicants' }, '$applicants', []] } } },
    { $unwind: '$applicants' },
    { $project: metadata('earlier', 'applicants.') },
    ...(job ? [{ $unionWith: { coll: Application.collection.name, pipeline: [{ $match: { jobId: { $in: refs(job._id) } } }, { $project: metadata('canonical') }] } }] : []),
    { $set: { identityRefs: ['$recordId', { $toUpper: '$recordId' }, { $convert: { input: '$recordId', to: 'objectId', onError: null, onNull: null } }] } },
    { $lookup: { from: Application.collection.name, localField: 'identityRefs', foreignField: '_id', pipeline: [{ $project: { _id: 1 } }], as: 'identities' } },
    { $set: { valid: { $and: [validId('$personId'), { $or: [{ $eq: ['$kind', 'earlier'] }, validId('$recordId')] }] } } },
    { $sort: { priority: 1, recordId: 1 } },
    { $group: {
      _id: '$personId', record: { $first: '$$ROOT' },
      canonicalCount: { $sum: { $cond: [{ $eq: ['$kind', 'canonical'] }, 1, 0] } },
      earlierCount: { $sum: { $cond: [{ $eq: ['$kind', 'earlier'] }, 1, 0] } },
      invalidCanonical: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'canonical'] }, { $or: [{ $not: ['$valid'] }, { $gt: [{ $size: '$identities' }, 1] }] }] }, 1, 0] } },
      invalidEarlier: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'earlier'] }, { $not: ['$valid'] }] }, 1, 0] } },
    } },
    { $replaceWith: { $mergeObjects: ['$record', { canonicalCount: '$canonicalCount', earlierCount: '$earlierCount', invalidCanonical: '$invalidCanonical', invalidEarlier: '$invalidEarlier' }] } },
    { $set: { profileRefs: ['$personId', { $toUpper: '$personId' }, { $convert: { input: '$personId', to: 'objectId', onError: null, onNull: null } }] } },
    { $lookup: { from: User.collection.name, localField: 'profileRefs', foreignField: '_id', pipeline: [{ $project: { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1 } }], as: 'profiles' } },
    { $set: { profile: { $arrayElemAt: ['$profiles', 0] }, missingDate: { $cond: [{ $eq: ['$appliedAt', null] }, 1, 0] } } },
    { $set: { name: { $cond: [{ $and: [{ $eq: ['$profile.role', 'paralegal'] }, { $eq: ['$profile.status', 'approved'] }, { $not: ['$profile.disabled'] }, { $not: ['$profile.deleted'] }, { $not: [{ $in: ['$personId', blocked] }] }] }, { $trim: { input: { $concat: [text('$profile.firstName'), ' ', text('$profile.lastName')] } } }, 'Paralegal applicant'] } } },
    { $set: { name: { $cond: [{ $eq: ['$name', ''] }, 'Paralegal applicant', '$name'] } } },
    { $facet: {
      invalid: [{ $match: { $or: [{ invalidCanonical: { $gt: 0 } }, { valid: true, canonicalCount: { $gt: 1 } }, { valid: true, earlierCount: { $gt: 1 } }, { 'profiles.1': { $exists: true } }] } }, { $limit: 1 }, { $project: { _id: 1 } }],
      unreadable: [{ $match: { invalidEarlier: { $gt: 0 } } }, { $limit: 1 }, { $project: { _id: 1 } }],
      counts: [{ $match: { valid: true } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      total: [{ $match: match }, { $count: 'count' }],
      rows: [{ $match: match }, { $sort: sort }, { $skip: filters.applicantId ? 0 : (filters.page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }, { $project: { _id: 0, kind: 1, personId: 1, recordId: 1, status: 1, appliedAt: 1, name: 1, starred: 1 } }],
    } },
  ];
}

async function inventorySource(doc, actorId, blocked, filters) {
  const context = await applicationContext(doc, undefined, { maxEmbedded: Infinity });
  const [metadata] = await Case.aggregate(pipeline(doc, context.job, actorId, blocked, filters)).collation({ locale: 'en', strength: 3 }).option({ maxTimeMS: 15000, allowDiskUse: true });
  if (metadata.invalid.length) fail(409, 'APPLICATION_REVIEW_SOURCE_INVALID', 'Duplicate or unreadable application records need verification before this list can be shown.');
  const selectedIds = metadata.rows.filter(row => row.kind === 'canonical').flatMap(row => refs(row.recordId));
  const applications = selectedIds.length ? await uniqueRecords(Application, { _id: { $in: selectedIds } }, applicationProjection) : [];
  const byId = new Map(applications.map(item => [id(item._id).toLowerCase(), item]));
  const byPerson = new Map([...context.byPerson].map(([key, value]) => [key.toLowerCase(), value]));
  const records = metadata.rows.map(row => row.kind === 'canonical' ? byId.get(row.recordId) : byPerson.get(row.personId));
  if (records.some((record, index) => !record || id(record.paralegalId).toLowerCase() !== metadata.rows[index].personId)) changed();
  const warnings = [...new Set([...context.warnings, ...(metadata.unreadable.length ? ['unreadable_records'] : [])])];
  return { ...context, byPerson, metadata, records, warnings, revision: fingerprint([context.job, metadata, records]) };
}

async function read(req) {
  const filters = parseQuery(req.query), initial = await owner(req), actorId = id(req.user.id);
  const blocked = (await getBlockedUserIds(actorId)).map(value => id(value).toLowerCase()).sort();
  const first = await inventorySource(initial.doc, actorId, blocked, filters);
  const ids = first.metadata.rows.flatMap(row => refs(row.personId));
  const profileFields = { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1 };
  const profiles = ids.length ? await uniqueRecords(User, { _id: { $in: ids } }, profileFields) : [];
  const current = await owner(req); if (current.revision !== initial.revision) changed();
  const currentBlocked = (await getBlockedUserIds(actorId)).map(value => id(value).toLowerCase()).sort();
  if (fingerprint(blocked) !== fingerprint(currentBlocked)) changed();
  const latest = await inventorySource(current.doc, actorId, currentBlocked, filters); if (latest.revision !== first.revision) changed();
  const currentProfiles = ids.length ? await uniqueRecords(User, { _id: { $in: ids } }, profileFields) : [];
  if (fingerprint(profiles) !== fingerprint(currentProfiles)) changed();
  const finalOwner = await owner(req); if (finalOwner.revision !== initial.revision) changed();
  const byProfile = new Map(profiles.map(profile => [id(profile._id).toLowerCase(), profile]));
  const counts = Object.fromEntries(STATUSES.map(key => [key, 0])); for (const row of first.metadata.counts) counts[row._id] = row.count;
  const total = first.metadata.total[0]?.count || 0, page = filters.applicantId ? 1 : filters.page;
  const applications = first.records.map((record, index) => {
    const row = first.metadata.rows[index];
    return shapeApplication(record, first.byPerson.get(row.personId), byProfile.get(row.personId), blocked.includes(row.personId), actorId, initial.doc, row.kind === 'canonical');
  });
  const result = { caseId: id(initial.doc._id), ownerId: actorId, caseTitle: initial.doc.title || 'Untitled Matter', caseStatus: initial.doc.status || '', archived: initial.doc.archived === true, selectedApplicantId: filters.applicantId || null, filters, counts, total, page, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), complete: !first.warnings.length, warnings: first.warnings, applications };
  return { ...result, revision: fingerprint(result) };
}
module.exports = { read, parseQuery, pipeline };
