// Synthetic retained financial records, never provider calls. Shared by the
// commission read tests so a positive assertion cannot rely on a fee estimate.
module.exports = async function retain({ attorney, paralegal, amount = 40000, attorneyFee = 8800, currency = 'usd', stripeMode = 'test', completedAt = new Date(Date.now() - 60000) }) {
  const mongoose = require('mongoose');
  if (!['jest', 'financial_lifecycle_browser'].includes(mongoose.connection.name)) throw Error('Director evidence fixtures require an owned disposable database');
  const Case = require('../../models/Case'), Operation = require('../../models/PaymentOperation'), Payout = require('../../models/Payout'), Income = require('../../models/PlatformIncome');
  const doc = await Case.create({ title: 'Synthetic retained director commission', details: 'Private financial evidence fixture.', attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: 'completed', totalAmount: amount, lockedTotalAmount: amount, remainingAmount: amount, feeAttorneyAmount: attorneyFee, feeAttorneyPct: attorneyFee / amount * 100, feeParalegalPct: 18, currency, stripeMode, escrowStatus: 'funded', fundingIntegrityStatus: 'verified', paymentReleased: true, payoutStatus: 'paid', completedAt, paidOutAt: completedAt });
  const suffix = String(doc._id), intent = `pi_director_${suffix}`, transfer = `tr_director_${suffix}`, key = `case_payout:${suffix}`, paralegalFee = Math.round(amount * 0.18);
  await Case.collection.updateOne({ _id: doc._id }, { $set: { escrowIntentId: intent, paymentIntentId: intent, payoutTransferId: transfer } });
  const funding = await Operation.create({ caseId: doc._id, operationKey: `funding:${suffix}:${intent}`, kind: 'funding', fingerprint: suffix, status: 'succeeded', amount: amount + attorneyFee, currency, stripeMode, livemode: stripeMode === 'live', stripePaymentIntentId: intent, stripeObjectId: intent, stripeChargeId: `ch_director_${suffix}`, stripeBalanceTransactionId: `txn_director_${suffix}`, grossAmount: amount + attorneyFee, processingFeeAmount: 1400, netAmount: amount + attorneyFee - 1400, evidenceVerifiedAt: new Date(completedAt.getTime() - 60000) });
  const operation = await Operation.create({ caseId: doc._id, operationKey: key, kind: 'case_payout', fingerprint: suffix, status: 'succeeded', amount: amount - paralegalFee, transferAmount: amount - paralegalFee, currency, stripeMode, stripeTransferId: transfer, stripeObjectId: transfer });
  const payout = await Payout.create({ caseId: doc._id, paralegalId: paralegal._id, operationKey: key, amountPaid: amount - paralegalFee, transferId: transfer, status: 'paid', stripeMode, createdAt: completedAt });
  const income = await Income.create({ caseId: doc._id, attorneyId: attorney._id, paralegalId: paralegal._id, operationKey: key, feeAmount: attorneyFee + paralegalFee, stripeMode });
  return { matter: doc, funding, operation, payout, income };
};
