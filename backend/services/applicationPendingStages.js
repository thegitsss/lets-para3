const Job = require('../models/Job'), Application = require('../models/Application');
const { PENDING_STATUSES } = require('./accountApplicationProjections');
const { normalizedId } = require('./applicationIdentity');
const refs = value => [normalizedId(value), { $toUpper: normalizedId(value) }, { $convert: { input: value, to: 'objectId', onError: null, onNull: null } }];
const valid = value => ({ $regexMatch: { input: normalizedId(value), regex: /^[a-f0-9]{24}$/ } });
const present = value => ({ $not: [{ $in: [{ $ifNull: [value, null] }, [null, '', false]] }] });
const normalStatus = value => ({ $toLower: { $trim: { input: { $convert: { input: value, to: 'string', onError: '', onNull: '' } } } } });
const array = value => ({ $cond: [{ $isArray: value }, value, []] });

// A physical ID join needs only these metadata fields. Keep its projection
// immediately after the equality lookup, without a per-record foreign pipeline.
const identityLookupStages = (from, localField, as, fields, limit) => [
  { $lookup: { from, localField, foreignField: '_id', as } },
  { $set: { [as]: { $map: {
    input: limit ? { $slice: [`$${as}`, limit] } : `$${as}`,
    as: 'matchedIdentity', in: Object.fromEntries(fields.map(field => [field, `$$matchedIdentity.${field}`])),
  } } } },
];

// Metadata-only counterpart of the shared legacy/account projection. Keep
// pagination in MongoDB: do not fetch an owner's entire application history.
function applicationPendingStages(ownerId, blocked = []) {
  const linked = { $ifNull: ['$jobId', '$job'] };
  return [
    { $set: { __applicationLinked: linked, __applicationCaseRefs: { $cond: [present(linked), [], refs('$_id')] }, __applicationJobRefs: refs(linked) } },
    ...identityLookupStages(Job.collection.name, '__applicationJobRefs', '__applicationLinkedJobs', ['_id', 'attorneyId', 'caseId', 'status'], 2),
    // Legacy string caseId references are outside the unique ObjectId index.
    // Retain the database-side bound that detects ambiguous reverse matches.
    { $lookup: { from: Job.collection.name, localField: '__applicationCaseRefs', foreignField: 'caseId', pipeline: [{ $project: { attorneyId: 1, caseId: 1, status: 1 } }, { $limit: 2 }], as: '__applicationReverseJobs' } },
    { $set: { __applicationJobs: { $cond: [present('$__applicationLinked'), '$__applicationLinkedJobs', '$__applicationReverseJobs'] }, __applicationEarlier: array('$applicants') } },
    { $set: { __applicationJob: { $arrayElemAt: ['$__applicationJobs', 0] } } },
    { $set: { __applicationActualJobRefs: { $cond: [present('$__applicationJob._id'), refs('$__applicationJob._id'), []] } } },
    { $lookup: { from: Application.collection.name, localField: '__applicationActualJobRefs', foreignField: 'jobId', pipeline: [
      { $project: { paralegalId: 1, status: 1, identityRefs: refs('$_id') } },
      ...identityLookupStages(Application.collection.name, 'identityRefs', 'identities', ['_id']),
      { $group: { _id: normalizedId('$paralegalId'), status: { $first: '$status' }, count: { $sum: 1 }, invalid: { $max: { $cond: [{ $or: [{ $not: [valid('$_id')] }, { $not: [valid('$paralegalId')] }, { $gt: [{ $size: '$identities' }, 1] }] }, 1, 0] } } } },
    ], as: '__applicationCanonical' } },
    { $set: {
      __applicationPeople: { $map: { input: '$__applicationCanonical', as: 'record', in: '$$record._id' } },
      __applicationEarlierPeople: { $map: { input: '$__applicationEarlier', as: 'record', in: normalizedId('$$record.paralegalId') } },
      __applicationInvalid: { $or: [
        { $and: [present('$attorney'), present('$attorneyId'), { $ne: [normalizedId('$attorney'), normalizedId('$attorneyId')] }] },
        { $and: [present('$job'), present('$jobId'), { $ne: [normalizedId('$job'), normalizedId('$jobId')] }] },
        { $and: [present('$__applicationLinked'), { $not: [valid('$__applicationLinked')] }] },
        { $gt: [{ $size: '$__applicationJobs' }, 1] },
        { $and: [present('$__applicationJob._id'), { $or: [{ $ne: [normalizedId('$__applicationJob.caseId'), normalizedId('$_id')] }, { $ne: [normalizedId('$__applicationJob.attorneyId'), ownerId] }] }] },
        { $gt: [{ $size: { $filter: { input: '$__applicationCanonical', as: 'record', cond: { $or: [{ $gt: ['$$record.count', 1] }, { $gt: ['$$record.invalid', 0] }] } } } }, 0] },
        { $and: [present('$applicants'), { $not: [{ $isArray: '$applicants' }] }] },
        { $gt: [{ $size: { $filter: { input: '$__applicationEarlier', as: 'record', cond: { $not: [valid('$$record.paralegalId')] } } } }, 0] },
      ] },
    } },
    { $set: {
      __applicationInvalid: { $or: ['$__applicationInvalid', { $ne: [{ $size: '$__applicationEarlierPeople' }, { $size: { $setUnion: ['$__applicationEarlierPeople', []] } }] }] },
      __inventoryApplicants: { $cond: [{ $and: [
        { $eq: [normalStatus('$status'), 'open'] }, { $ne: ['$archived', true] }, { $ne: ['$paymentReleased', true] },
        { $ne: [normalStatus('$escrowStatus'), 'funded'] }, { $not: [present('$paralegal')] }, { $not: [present('$paralegalId')] },
        { $cond: [present('$__applicationJob._id'), { $eq: [normalStatus('$__applicationJob.status'), 'open'] }, { $not: [present('$__applicationLinked')] }] },
      ] }, { $add: [
        { $size: { $filter: { input: '$__applicationCanonical', as: 'record', cond: { $and: [{ $in: [normalStatus('$$record.status'), [...PENDING_STATUSES]] }, { $not: [{ $in: ['$$record._id', blocked] }] }] } } } },
        { $size: { $filter: { input: '$__applicationEarlier', as: 'record', cond: { $and: [{ $eq: [normalStatus('$$record.status'), 'pending'] }, { $not: [{ $in: [normalizedId('$$record.paralegalId'), '$__applicationPeople'] }] }, { $not: [{ $in: [normalizedId('$$record.paralegalId'), blocked] }] }] } } } },
      ] }, 0] },
    } },
    { $unset: ['__applicationLinkedJobs', '__applicationReverseJobs', '__applicationActualJobRefs', '__applicationLinked', '__applicationCaseRefs', '__applicationJobRefs', '__applicationJobs', '__applicationJob', '__applicationEarlier', '__applicationCanonical', '__applicationPeople', '__applicationEarlierPeople'] },
  ];
}

module.exports = { applicationPendingStages };
