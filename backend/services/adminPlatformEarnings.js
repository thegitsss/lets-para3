const Income = require('../models/PlatformIncome');
const account = require('./financialAccountBoundary');
const financial = require('./adminFinancialReport');
const { periodFor } = require('./adminExecutiveMetrics');
const { summarize } = require('./platformEarningsSummary');
const { fingerprint } = require('./matterDraftRevision');
const MAX_MONTHLY_ROWS = 50000, CASES_PER_READ = 250;
// Scope the evidence to fee-bearing cases in this month. Unrelated payment
// history must not consume the report's 10,000-row verification bound. Every
// selected case still uses the same funding/payout/retained-fee projection.
async function readPlatformEarnings(req, { now = new Date() } = {}) {
  const owner = await account.read(req, 'admin', req.query?.expectedOwnerId), period = periodFor(now);
  const query = { stripeMode: { $ne: 'test' }, $or: [
    { createdAt: { $gte: new Date(period.from), $lte: now } },
    { createdAt: { $not: { $type: 'date' } } },
  ] };
  const selected = () => Income.collection.find(query, { projection: { caseId: 1, operationKey: 1, attorneyId: 1, paralegalId: 1, feeAmount: 1, stripeMode: 1, createdAt: 1 } }).sort({ _id: 1 }).limit(MAX_MONTHLY_ROWS + 1).maxTimeMS(5000).toArray();
  const rows = await selected();
  if (rows.length > MAX_MONTHLY_ROWS) financial.fail(413, 'TOO_LARGE');
  const validId = value => /^[a-f0-9]{24}$/i.test(String(value || ''));
  const ids = [...new Set(rows.filter(row => validId(row.caseId)).map(row => String(row.caseId)))];
  const keys = [...new Set(rows.map(row => row.operationKey).filter(key => typeof key === 'string' && key))];
  const referenceCounts = async () => {
    const counts = [];
    for (let index = 0; index < keys.length; index += 500) counts.push(...await Income.collection.aggregate([
      { $match: { operationKey: { $in: keys.slice(index, index + 500) } } },
      { $group: { _id: '$operationKey', count: { $sum: 1 }, firstId: { $min: '$_id' }, lastId: { $max: '$_id' } } },
      { $sort: { _id: 1 } },
    ], { maxTimeMS: 5000 }).toArray());
    return counts;
  };
  const references = await referenceCounts();
  const duplicateKeys = new Set(references.filter(row => row.count !== 1).map(row => row._id));
  const projected = [], reports = [];
  for (let index = 0; index < ids.length; index += CASES_PER_READ) {
    const report = await financial.begin(req, { caseIds: ids.slice(index, index + CASES_PER_READ) }); reports.push(report);
    projected.push(...report.value.allIncome);
  }
  for (const row of rows.filter(row => !validId(row.caseId))) projected.push({ stripeMode: row.stripeMode, recordedAt: row.createdAt, state: 'needs_review', basis: 'income_to_verify', amount: null, currency: null });
  for (const row of projected) if (duplicateKeys.has(row.operationKey)) { row.state = 'needs_review'; row.amount = null; row.basis = 'income_to_verify'; }
  const earnings = summarize(projected, now);
  for (const report of reports) await report.verify();
  const [currentRows, currentReferences, currentOwner] = await Promise.all([selected(), referenceCounts(), account.read(req, 'admin', req.query?.expectedOwnerId)]);
  if (fingerprint(rows) !== fingerprint(currentRows) || fingerprint(references) !== fingerprint(currentReferences) || fingerprint(owner) !== fingerprint(currentOwner)) financial.fail(409, 'CHANGED');
  return { ...earnings, ownerId: String(owner._id), revision: fingerprint([owner, rows, references, reports.map(report => report.value.revision), period]), evidenceCases: ids.length };
}
module.exports = { readPlatformEarnings, MAX_MONTHLY_ROWS };
