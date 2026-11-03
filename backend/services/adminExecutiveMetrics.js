const mongoose = require('mongoose');
const User = require('../models/User');
const Case = require('../models/Case');
const SupportTicket = require('../models/SupportTicket');
const AutonomousAction = require('../models/AutonomousAction');
const AuditLog = require('../models/AuditLog');
const ApprovalTask = require('../models/ApprovalTask');
const IncidentApproval = require('../models/IncidentApproval');
const SupportMessage = require('../models/SupportMessage');
const { readAutomationCycleStatus } = require('./automationCycleStatus');
const { dateOnlyFromZonedInstant } = require('../utils/businessDate');

const TIME_ZONE = 'America/New_York';
const READ_LIMIT = 50000;
const MAX_TIME_MS = 5000;
const WORK_STATUSES = ['in progress', 'in_progress', 'in-progress', 'active', 'assigned', 'awaiting_documents', 'reviewing', 'paused', 'disputed'];
const DEFINITIONS = Object.freeze({
  registration: 'Registered attorney and paralegal accounts still on LPC; deleted accounts are excluded. Suspended and denied registrations remain in the denominator.',
  firstPost: 'Attorneys with a matter posted after registration, divided by registered attorneys. This measures lifetime observed conversion.',
  activation: 'Approved paralegals with account access enabled, divided by registered paralegals. Account activation does not certify directory or payout readiness.',
  engagement: 'Paralegals with at least one recorded current or former engagement, divided by registered paralegals.',
  postedToHire: 'Matters with recorded hiring evidence, divided by posted matters. A relisted matter counts once and retains its hiring history.',
  timeToHire: 'Average hours from posting to recorded hire; records with missing or invalid dates are reported separately.',
  timeToComplete: 'Average hours from recorded hire to completion; records with missing or invalid dates are reported separately.',
  delivery: 'Provider-accepted automatic sends divided by known attempts this month. Acceptance does not prove inbox delivery or issue resolution.',
  ownerDecisions: 'Recorded admission, photo, access, settlement, content, incident decisions and manual support replies for this owner. Matching replies across channels count once.',
  customerExperience: 'Unresolved includes open, in-review and waiting tickets. Human requests count people explicitly asking for a person.',
  recordedAutomaticActions: 'Automatic actions marked complete this month, excluding undone actions. This does not measure overall workflow success.',
  operationalScope: 'Known test-mode matters are excluded. Accounts without a reliable test marker remain included; email addresses never determine test status.',
});
const key = value => value == null ? '' : String(value);
const percentage = (numerator, denominator, definition, evidenceMissing = 0) => ({
  numerator, denominator,
  rate: denominator && !evidenceMissing ? Math.round(numerator * 10000 / denominator) / 100 : null,
  unit: 'percent', evidenceMissing, definition,
});
function periodFor(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw Object.assign(new Error('Invalid reporting time.'), { statusCode: 400 });
  const month = dateOnlyFromZonedInstant(now, TIME_ZONE).slice(0, 7);
  const wall = new Date(`${month}-01T00:00:00.000Z`);
  const offsetText = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'shortOffset' }).formatToParts(wall).find(part => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offsetText || '');
  if (!match) throw new Error('The reporting period could not be established.');
  const offset = (Number(match[2]) * 60 + Number(match[3] || 0)) * 60000 * (match[1] === '+' ? 1 : -1);
  return { kind: 'calendar_month', timeZone: TIME_ZONE, month, from: new Date(wall.getTime() - offset).toISOString(), to: now.toISOString() };
}
const validDate = (field, now) => ({ $and: [{ $eq: [{ $type: field }, 'date'] }, { $lte: [field, now] }] });
const stringId = field => ({ $convert: { input: field, to: 'string', onError: null, onNull: null } });
const sumWhen = condition => ({ $sum: { $cond: [condition, 1, 0] } });
const aggregate = (Model, stages) => Model.aggregate(stages).option({ maxTimeMS: MAX_TIME_MS });
async function readAccounts(now) {
  const rows = await User.collection.find({ role: { $in: ['attorney', 'paralegal'] }, deleted: { $ne: true } }, {
    projection: { _id: 1, role: 1, status: 1, createdAt: 1, emailVerified: 1, disabled: 1 },
  }).limit(READ_LIMIT + 1).maxTimeMS(MAX_TIME_MS).toArray();
  if (rows.length > READ_LIMIT) throw new Error('The registration summary exceeded its verified read bound.');
  return rows.map(row => ({ ...row, dateKnown: row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime()) && row.createdAt <= now }));
}
async function readMarketplace(now, period) {
  const hired = { $or: [
    { $ne: [{ $ifNull: ['$paralegal', { $ifNull: ['$paralegalId', null] }] }, null] },
    { $eq: [{ $type: '$hiredAt' }, 'date'] },
    { $gt: [{ $size: { $ifNull: ['$withdrawalHistory', []] } }, 0] },
    { $ne: [{ $ifNull: ['$withdrawnParalegalId', null] }, null] },
    { $in: ['$status', [...WORK_STATUSES, 'completed']] },
  ] };
  const pipeline = [
    { $match: { stripeMode: { $ne: 'test' } } },
    { $project: {
      attorney: stringId({ $ifNull: ['$attorney', '$attorneyId'] }),
      paralegal: stringId({ $ifNull: ['$paralegal', '$paralegalId'] }),
      historicalParalegals: { $map: { input: { $ifNull: ['$withdrawalHistory', []] }, as: 'history', in: stringId('$$history.withdrawnParalegalId') } },
      withdrawnParalegal: stringId('$withdrawnParalegalId'),
      status: 1, archived: 1, createdAt: 1, hiredAt: 1, completedAt: 1,
      createdKnown: validDate('$createdAt', now), hiredKnown: validDate('$hiredAt', now), completedKnown: validDate('$completedAt', now),
      hired,
      blocked: { $or: [
        { $in: ['needs_reconciliation', ['$postingSyncStatus', '$hiringClaimStatus', '$completionClaimStatus']] },
        { $eq: ['$fundingIntegrityStatus', 'failed'] },
        { $gt: [{ $size: { $filter: { input: { $ifNull: ['$disputes', []] }, as: 'dispute', cond: { $not: [{ $in: ['$$dispute.status', ['resolved', 'rejected']] }] } } } }, 0] },
      ] },
      overdue: { $and: [
        { $ne: ['$archived', true] },
        { $in: ['$status', ['open', ...WORK_STATUSES]] },
        { $regexMatch: { input: { $ifNull: ['$deadlineDate', ''] }, regex: /^\d{4}-\d{2}-\d{2}$/ } },
        { $lt: ['$deadlineDate', dateOnlyFromZonedInstant(now, TIME_ZONE)] },
      ] },
    } },
    { $addFields: {
      completed: { $or: [{ $eq: ['$status', 'completed'] }, '$completedKnown'] },
      hireDurationKnown: { $and: ['$createdKnown', '$hiredKnown', { $gte: ['$hiredAt', '$createdAt'] }] },
      completionDurationKnown: { $and: ['$hiredKnown', '$completedKnown', { $gte: ['$completedAt', '$hiredAt'] }] },
    } },
    { $facet: {
      totals: [{ $group: {
        _id: null, posted: { $sum: 1 }, postedThisMonth: sumWhen({ $and: ['$createdKnown', { $gte: ['$createdAt', new Date(period.from)] }] }),
        missingPostDates: sumWhen({ $not: ['$createdKnown'] }), hired: sumWhen('$hired'),
        hiredThisMonth: sumWhen({ $and: ['$hiredKnown', { $gte: ['$hiredAt', new Date(period.from)] }] }),
        missingHireDates: sumWhen({ $and: ['$hired', { $not: ['$hiredKnown'] }] }),
        active: sumWhen({ $and: [{ $in: ['$status', WORK_STATUSES] }, { $ne: ['$archived', true] }] }),
        completed: sumWhen('$completed'), completedThisMonth: sumWhen({ $and: ['$completedKnown', { $gte: ['$completedAt', new Date(period.from)] }] }),
        missingCompletionDates: sumWhen({ $and: ['$completed', { $not: ['$completedKnown'] }] }),
        unfilled: sumWhen({ $and: [{ $eq: ['$status', 'open'] }, { $eq: ['$paralegal', null] }, { $ne: ['$archived', true] }] }),
        blocked: sumWhen('$blocked'), overdue: sumWhen('$overdue'),
        hireHours: { $avg: { $cond: ['$hireDurationKnown', { $divide: [{ $subtract: ['$hiredAt', '$createdAt'] }, 3600000] }, null] } },
        hireSamples: sumWhen('$hireDurationKnown'),
        completeHours: { $avg: { $cond: ['$completionDurationKnown', { $divide: [{ $subtract: ['$completedAt', '$hiredAt'] }, 3600000] }, null] } },
        completeSamples: sumWhen('$completionDurationKnown'),
      } }],
      firstPosts: [
        { $match: { attorney: { $ne: null } } },
        { $group: { _id: '$attorney', latestDate: { $max: { $cond: ['$createdKnown', '$createdAt', null] } }, missingDates: sumWhen({ $not: ['$createdKnown'] }) } },
      ],
      engagedPeople: [
        { $project: { people: { $setUnion: [
          { $cond: ['$hired', ['$paralegal'], []] }, '$historicalParalegals', ['$withdrawnParalegal'],
        ] } } },
        { $unwind: '$people' }, { $match: { people: { $ne: null } } }, { $group: { _id: '$people' } },
      ],
    } },
  ];
  const result = (await aggregate(Case, pipeline))[0] || { totals: [], firstPosts: [], engagedPeople: [] };
  const t = result.totals[0] || {};
  const number = field => t[field] || 0;
  const rounded = value => value == null ? null : Math.round(value * 100) / 100;
  return {
    value: {
      posted: number('posted'), postedThisMonth: number('missingPostDates') ? null : number('postedThisMonth'),
      hired: number('hired'), hiredThisMonth: number('missingHireDates') ? null : number('hiredThisMonth'),
      active: number('active'), completed: number('completed'), completedThisMonth: number('missingCompletionDates') ? null : number('completedThisMonth'),
      unfilled: number('unfilled'), blocked: number('blocked'), overdue: number('overdue'),
      postedToHire: percentage(number('hired'), number('posted'), DEFINITIONS.postedToHire),
      timeToHire: { hours: rounded(t.hireHours), samples: number('hireSamples'), missingDates: Math.max(0, number('hired') - number('hireSamples')), definition: DEFINITIONS.timeToHire },
      timeToComplete: { hours: rounded(t.completeHours), samples: number('completeSamples'), missingDates: Math.max(0, number('completed') - number('completeSamples')), definition: DEFINITIONS.timeToComplete },
      coverage: { missingPostDates: number('missingPostDates'), missingHireDates: number('missingHireDates'), missingCompletionDates: number('missingCompletionDates'), knownTestCasesExcluded: true },
    },
    postsByAttorney: new Map(result.firstPosts.map(row => [key(row._id), row])),
    engagedPeople: new Set(result.engagedPeople.map(row => key(row._id))),
  };
}
function acquisitionFor(accounts, marketplace, now, period) {
  const build = role => {
    const users = accounts.filter(row => row.role === role), missingDates = users.filter(row => !row.dateKnown).length;
    const base = { registered: users.length, registeredThisMonth: missingDates ? null : users.filter(row => row.createdAt >= new Date(period.from) && row.createdAt <= now).length, approved: users.filter(row => row.status === 'approved' && !row.disabled).length, missingRegistrationDates: missingDates };
    if (role === 'attorney') {
      if (!marketplace) return { ...base, firstPostConversion: null };
      let converted = 0, missing = 0;
      for (const user of users) {
        const post = marketplace.postsByAttorney.get(key(user._id));
        if (!post) continue;
        if (user.dateKnown && post.latestDate && post.latestDate >= user.createdAt) converted++;
        else missing++;
      }
      return { ...base, firstPostConversion: percentage(converted, users.length, DEFINITIONS.firstPost, missing) };
    }
    return { ...base,
      activation: percentage(users.filter(row => row.status === 'approved' && !row.disabled).length, users.length, DEFINITIONS.activation),
      engagement: marketplace ? percentage(users.filter(row => marketplace.engagedPeople.has(key(row._id))).length, users.length, DEFINITIONS.engagement) : null,
    };
  };
  return { attorneys: build('attorney'), paralegals: build('paralegal') };
}
async function readSupport() {
  const rows = await aggregate(SupportTicket, [
    { $match: { sourceLabel: { $ne: 'Control Room e2e harness' }, 'supportFactsSnapshot.harnessRunKey': { $not: /^cr-e2e-/i }, status: { $in: ['open', 'in_review', 'waiting_on_user', 'waiting_on_info'] } } },
    { $group: { _id: null, unresolved: { $sum: 1 }, waiting: sumWhen({ $in: ['$status', ['waiting_on_user', 'waiting_on_info']] }),
      needsOwner: sumWhen({ $eq: ['$requestKind', 'human'] }),
      urgent: sumWhen({ $eq: ['$urgency', 'high'] }), oldestOpenAt: { $min: '$createdAt' },
    } },
  ]);
  const row = rows[0] || {};
  return { unresolved: row.unresolved || 0, waiting: row.waiting || 0, needsOwner: row.needsOwner || 0, urgent: row.urgent || 0, oldestOpenAt: row.oldestOpenAt instanceof Date ? row.oldestOpenAt.toISOString() : null };
}
async function readAutomation(now, period) {
  const matchDate = { $gte: new Date(period.from), $lte: now };
  const [latestCycle, actions, receipts, legacy] = await Promise.all([
    readAutomationCycleStatus({ now }),
    AutonomousAction.countDocuments({ status: 'completed', createdAt: matchDate }).maxTimeMS(MAX_TIME_MS),
    aggregate(SupportTicket, [
      { $match: { 'emailReplies.automatedKind': { $exists: true, $nin: ['', null] } } },
      { $unwind: '$emailReplies' }, { $match: { 'emailReplies.automatedKind': { $exists: true, $nin: ['', null] } } },
      { $unwind: '$emailReplies.attemptOutcomes' }, { $match: { 'emailReplies.attemptOutcomes.recordedAt': matchDate } },
      { $group: { _id: '$emailReplies.attemptOutcomes.status', attempted: sumWhen({ $eq: ['$emailReplies.attemptOutcomes.attempted', true] }), uncertainClaims: sumWhen({ $eq: ['$emailReplies.attemptOutcomes.attempted', null] }) } },
    ]),
    aggregate(SupportTicket, [
      { $match: { 'emailReplies.automatedKind': { $exists: true, $nin: ['', null] } } }, { $unwind: '$emailReplies' },
      { $match: { 'emailReplies.automatedKind': { $exists: true, $nin: ['', null] }, 'emailReplies.createdAt': matchDate, 'emailReplies.attemptOutcomes.0': { $exists: false } } }, { $count: 'total' },
    ]),
  ]);
  const counts = Object.fromEntries(receipts.map(row => [row._id, row.attempted]));
  const uncertainClaims = receipts.reduce((total, row) => total + row.uncertainClaims, 0), legacyWithoutAttemptReceipts = legacy[0]?.total || 0;
  const attempts = ['accepted', 'failed', 'unknown'].reduce((total, state) => total + (counts[state] || 0), 0);
  return { latestCycle, recordedActionsThisMonth: actions, delivery: {
    accepted: counts.accepted || 0, failed: counts.failed || 0, unknown: counts.unknown || 0, uncertainClaims, attempts,
    successRate: attempts && !uncertainClaims && !legacyWithoutAttemptReceipts ? Math.round((counts.accepted || 0) * 10000 / attempts) / 100 : null,
    coverage: { legacyWithoutAttemptReceipts, complete: !uncertainClaims && !legacyWithoutAttemptReceipts }, definition: DEFINITIONS.delivery,
  } };
}
async function readOwner(ownerId, now, period) {
  if (!ownerId) return { decisionsThisMonth: null, recordedMinutes: null, timeCoverage: 'not_recorded', definition: DEFINITIONS.ownerDecisions };
  if (!mongoose.isValidObjectId(ownerId)) throw Object.assign(new Error('Your Admin account could not be confirmed.'), { statusCode: 403 });
  const actor = new mongoose.Types.ObjectId(String(ownerId)), dates = { $gte: new Date(period.from), $lte: now };
  const [audits, approvals, incidents, conversationReplies, emailReplies] = await Promise.all([
    AuditLog.countDocuments({ actor, actorRole: 'admin', createdAt: dates, action: { $in: [
      'admin.user.approved', 'admin.user.denied', 'admin.profile_photo.approved', 'admin.profile_photo.rejected', 'admin.user.suspended', 'admin.user.reinstated',
      'dispute.withdrawal.settle', 'dispute.settlement.refund', 'dispute.settlement.release',
    ] } }).maxTimeMS(MAX_TIME_MS),
    ApprovalTask.countDocuments({ 'decidedBy.userId': actor, 'decidedBy.actorType': 'user', decidedAt: dates }).maxTimeMS(MAX_TIME_MS),
    IncidentApproval.countDocuments({ decisionByUserId: actor, decidedAt: dates }).maxTimeMS(MAX_TIME_MS),
    aggregate(SupportMessage, [
      { $match: { 'metadata.adminId': { $in: [String(ownerId), actor] }, 'metadata.kind': 'team_reply', createdAt: dates } },
      { $group: { _id: { $ifNull: ['$metadata.adminReplyRequestId', { $concat: ['message:', { $toString: '$_id' }] }] } } },
    ]),
    aggregate(SupportTicket, [
      { $match: { 'emailReplies.adminId': actor } }, { $unwind: { path: '$emailReplies', includeArrayIndex: 'replyIndex' } },
      { $match: { 'emailReplies.adminId': actor, 'emailReplies.automatedKind': { $in: [null, ''] }, 'emailReplies.createdAt': dates, 'emailReplies.delivery': { $in: ['accepted', 'unknown', 'pending', 'disabled', 'failed'] } } },
      { $group: { _id: { $ifNull: ['$emailReplies.requestId', { $concat: ['email:', { $toString: '$_id' }, ':', { $toString: '$replyIndex' }] }] } } },
    ]),
  ]);
  const replies = new Set([...conversationReplies, ...emailReplies].map(row => key(row._id))).size;
  return { decisionsThisMonth: audits + approvals + incidents + replies, bySource: { audits, approvals, incidents, supportReplies: replies }, recordedMinutes: null, timeCoverage: 'not_recorded', decisionCoverage: 'supported_recorded_decisions', definition: DEFINITIONS.ownerDecisions };
}
async function readExecutiveMetrics({ now = new Date(), ownerId } = {}) {
  const period = periodFor(now);
  if (ownerId != null && !mongoose.isValidObjectId(ownerId)) throw Object.assign(new Error('Your Admin account could not be confirmed.'), { statusCode: 403 });
  const names = ['accounts', 'marketplace', 'customerExperience', 'automation', 'owner'];
  const results = await Promise.allSettled([readAccounts(now), readMarketplace(now, period), readSupport(), readAutomation(now, period), readOwner(ownerId, now, period)]);
  const values = Object.fromEntries(names.map((name, index) => [name, results[index].status === 'fulfilled' ? results[index].value : null]));
  const sources = Object.fromEntries(names.map((name, index) => [name === 'accounts' ? 'acquisition' : name, { available: results[index].status === 'fulfilled', checkedAt: now.toISOString() }]));
  const limitations = [DEFINITIONS.operationalScope, 'Conversion rates are lifetime observations; new registrations have had less time to convert.', 'Founder review time and end-to-end automation resolution rates are not recorded; provider acceptance is not completion.'];
  const sourceLabels = { accounts: 'Registration', marketplace: 'Marketplace', customerExperience: 'Support', automation: 'Automation', owner: 'Owner decision' };
  for (const [index, result] of results.entries()) if (result.status === 'rejected') limitations.push(`${sourceLabels[names[index]]} measurements are temporarily unavailable.`);
  return { schemaVersion: 1, checkedAt: now.toISOString(), period, sources,
    acquisition: values.accounts ? acquisitionFor(values.accounts, values.marketplace, now, period) : null,
    marketplace: values.marketplace?.value || null, customerExperience: values.customerExperience, automation: values.automation, owner: values.owner,
    definitions: DEFINITIONS, limitations,
  };
}
module.exports = { readExecutiveMetrics, periodFor, acquisitionFor, percentage, DEFINITIONS };
