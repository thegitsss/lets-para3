const { getCurrentPlatformFeePolicy } = require('./platformFeePolicy');
const cents = value => Number.isSafeInteger(value) && value >= 0;
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
function summarize(doc) {
  const amount = doc.lockedTotalAmount ?? doc.totalAmount;
  if (!cents(amount)) return { amount: null, basis: 'unavailable' };
  const rates = [doc.feeAttorneyPct, doc.feeParalegalPct];
  const recorded = [doc.feeAttorneyAmount, doc.feeParalegalAmount];
  // Positive stored fees are the case's historical snapshot, not today's rates.
  if (recorded.every(cents) && (recorded.some(value => value > 0) || amount === 0 || rates.every(value => value === 0))) {
    const total = recorded[0] + recorded[1];
    return { amount: cents(total) ? total : null, basis: cents(total) ? 'recorded' : 'unavailable' };
  }
  // Unfunded postings may not have their fee snapshot yet. Never substitute
  // current policy for a locked historical case with missing rates.
  if (!rates.every(percent)) {
    if (doc.lockedTotalAmount != null) return { amount: null, basis: 'unavailable' };
    const policy = getCurrentPlatformFeePolicy();
    rates[0] = policy.attorneyPercent; rates[1] = policy.paralegalPercent;
  }
  // Match Case.snapshotFees: round each side down to whole cents before combining.
  const total = Math.floor(amount * rates[0] / 100) + Math.floor(amount * rates[1] / 100);
  return { amount: cents(total) ? total : null, basis: cents(total) ? 'expected' : 'unavailable' };
}
module.exports = { summarize };
