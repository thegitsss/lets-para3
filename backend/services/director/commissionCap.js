// One lifetime allowance per director, shared by every referred attorney.
// Eligibility and fee evidence belong to the caller; this function only
// allocates the allowance and never creates or changes a payment.
const COMMISSION_CAP = 50;
const id = value => String(value?._id || value || '');
const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : Infinity;
function allocateCommissionCap(entries) {
  const byDirector = new Map(), byRecord = new Map();
  for (const entry of entries) {
    const directorId = id(entry.directorUserId), recordId = id(entry.recordId);
    if (!byDirector.has(directorId)) byDirector.set(directorId, []);
    byDirector.get(directorId).push(entry);
    if (!byRecord.has(recordId)) byRecord.set(recordId, []);
  }
  const totals = new Map();
  for (const [directorId, candidates] of byDirector) {
    candidates.sort((left, right) => {
      const difference = time(left.completedAt) - time(right.completedAt);
      if (Number.isFinite(difference) && difference !== 0) return difference;
      if (time(left.completedAt) !== time(right.completedAt)) return time(left.completedAt) < time(right.completedAt) ? -1 : 1;
      return id(left.caseId).localeCompare(id(right.caseId)) || id(left.recordId).localeCompare(id(right.recordId));
    });
    // A Matter consumes one slot even if an inconsistent referral inventory
    // happens to present it more than once for the same director.
    const selected = new Set();
    for (const entry of candidates) {
      const caseId = id(entry.caseId);
      if (selected.size >= COMMISSION_CAP || selected.has(caseId)) continue;
      selected.add(caseId); byRecord.get(id(entry.recordId)).push(entry);
    }
    totals.set(directorId, selected.size);
  }
  return { byRecord, totals };
}
module.exports = { COMMISSION_CAP, allocateCommissionCap };
