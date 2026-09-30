const crypto = require('crypto');
const Case = require('../models/Case');
const {
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT
} = require('./platformFeePolicy');
const resolveParalegalFeePct = doc => typeof doc.feeParalegalPct === 'number' && Number.isFinite(doc.feeParalegalPct) ? doc.feeParalegalPct : DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;
function computeParalegalFeeFromGross(grossCents, caseDoc) {
  const gross = Math.max(0, Math.round(Number(grossCents || 0)));
  const pct = resolveParalegalFeePct(caseDoc);
  const fee = Math.max(0, Math.round(gross * (Number(pct) || 0) / 100));
  const net = Math.max(0, gross - fee);
  return {
    gross,
    feePct: pct,
    feeAmount: fee,
    net
  };
}
function computeGrossFromDesiredPayout(desiredNetCents, caseDoc, maxGrossCents) {
  const desiredNet = Math.max(0, Math.round(Number(desiredNetCents || 0)));
  const maxGross = Math.max(desiredNet, Math.round(Number(maxGrossCents || 0)));
  if (!Number.isFinite(desiredNet) || desiredNet <= 0) return null;
  for (let gross = desiredNet; gross <= maxGross; gross += 1) {
    const result = computeParalegalFeeFromGross(gross, caseDoc);
    if (result.net === desiredNet) return result;
  }
  return null;
}
function disputeRevision(c) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: String(c._id),
    updatedAt: c.updatedAt,
    status: c.status,
    amount: c.lockedTotalAmount ?? c.totalAmount,
    remaining: c.remainingAmount,
    feeParalegalPct: c.feeParalegalPct,
    feeAttorneyPct: c.feeAttorneyPct,
    released: c.paymentReleased,
    settlement: c.disputeSettlement,
    disputes: (c.disputes || []).map(d => ({
      id: String(d.disputeId || d._id),
      status: d.status
    }))
  })).digest('hex');
}
const fail = (message, statusCode = 409) => {
  throw Object.assign(new Error(message), {
    statusCode
  });
};
async function previewDispute({
  caseId,
  disputeId,
  action,
  payoutAmountCents
}, stripeClient) {
  if (!['refund', 'release_full', 'release_partial'].includes(action)) fail('Choose a valid settlement action.', 400);
  const c = await Case.findById(caseId).populate('attorney', 'firstName lastName email').populate('attorneyId', 'firstName lastName email').populate('paralegal', 'firstName lastName email').populate('paralegalId', 'firstName lastName email').populate('withdrawnParalegalId', 'firstName lastName email');
  if (!c) fail('Matter not found.', 404);
  const dispute = (c.disputes || []).find(d => String(d.disputeId || d._id) === String(disputeId));
  if (!dispute || dispute.status !== 'open' || c.status !== 'disputed' || c.paymentReleased || c.payoutFinalizedAt) fail('This dispute is no longer open for a financial decision.');
  const withdrawal = Boolean(c.withdrawnParalegalId && !c.paralegal && !c.paralegalId);
  const base = Number(withdrawal ? c.remainingAmount ?? c.lockedTotalAmount ?? c.totalAmount : c.lockedTotalAmount ?? c.totalAmount);
  if (!Number.isSafeInteger(base) || base < 0) fail('Matter funding amount is invalid.');
  if (action === 'release_partial' && (!Number.isSafeInteger(Number(payoutAmountCents)) || Number(payoutAmountCents) <= 0)) fail('Enter a valid payout amount.', 400);
  const plan = action === 'release_partial' ? computeGrossFromDesiredPayout(payoutAmountCents, c, base) : computeParalegalFeeFromGross(action === 'refund' ? 0 : base, c);
  if (!plan || plan.gross > base) fail('The requested payout exceeds available funds.', 400);
  let refundAmount = 0;
  let chargeAmount = null;
  let alreadyRefunded = 0;
  const feeAttorneyPct = typeof c.feeAttorneyPct === 'number' ? c.feeAttorneyPct : DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
  const attorneyFee = Math.max(0, Math.round(plan.gross * feeAttorneyPct / 100));
  if (!withdrawal || plan.net > 0) {
    if (!c.escrowIntentId) fail('This matter has no verified funding reference.');
    const stripe = stripeClient || require('../utils/stripe');
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(c.escrowIntentId, {
        expand: ['latest_charge']
      });
    } catch (_) {
      fail('The payment provider could not be checked. Try the preview again.', 502);
    }
    const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : pi.charges?.data?.[0];
    if (!charge) fail('Charge evidence is unavailable. Reconcile this matter before settling.');
    chargeAmount = Math.max(0, Number(charge.amount ?? pi.amount_received ?? pi.amount));
    alreadyRefunded = Math.max(0, Number(charge.amount_refunded || 0));
    if (!withdrawal && action === 'refund') refundAmount = Math.max(0, chargeAmount - alreadyRefunded);
    if (!withdrawal && action === 'release_partial') {
      const desired = Math.max(0, Math.min(chargeAmount, Math.round(base + Math.round(base * feeAttorneyPct / 100) - plan.gross - attorneyFee)));
      if (alreadyRefunded > desired) fail('A previous refund changed the funds available. Choose a lower payout.');
      refundAmount = Math.max(0, desired - alreadyRefunded);
    }
  }
  return {
    caseId: String(c._id),
    disputeId: String(disputeId),
    title: c.title,
    action,
    withdrawal,
    currency: c.currency || 'usd',
    attorney: c.attorney || c.attorneyId,
    paralegal: withdrawal ? c.withdrawnParalegalId : c.paralegal || c.paralegalId,
    baseAmount: base,
    grossAmount: plan.gross,
    payoutAmount: plan.net,
    paralegalFee: plan.feeAmount,
    attorneyFee: withdrawal ? null : attorneyFee,
    refundAmount,
    remainingForMatter: withdrawal ? base - plan.gross : 0,
    chargeAmount,
    alreadyRefunded,
    previewRevision: disputeRevision(c),
    checkedAt: new Date()
  };
}
module.exports = {
  computeParalegalFeeFromGross,
  computeGrossFromDesiredPayout,
  disputeRevision,
  previewDispute
};
