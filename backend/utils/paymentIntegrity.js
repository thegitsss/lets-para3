const {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
} = require("../services/platformFeePolicy");

function cents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function expectedCaseFunding(caseDoc = {}) {
  const baseAmount = cents(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount);
  const feePercent =
    Number.isFinite(caseDoc.feeAttorneyPct) && caseDoc.feeAttorneyPct >= 0
      ? Number(caseDoc.feeAttorneyPct)
      : DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
  const storedFee = cents(caseDoc.feeAttorneyAmount);
  const feeAmount =
    storedFee > 0 || feePercent === 0
      ? storedFee
      : Math.max(0, Math.round(baseAmount * (feePercent / 100)));

  return {
    baseAmount,
    feePercent,
    feeAmount,
    totalAmount: baseAmount + feeAmount,
    currency: String(caseDoc.currency || "usd").toLowerCase(),
  };
}

function paymentIntentAmount(paymentIntent = {}) {
  const received = cents(paymentIntent.amount_received);
  return received > 0 ? received : cents(paymentIntent.amount);
}

function validatePaymentIntentForCase(paymentIntent, caseDoc) {
  const expected = expectedCaseFunding(caseDoc);
  const reasons = [];
  const caseId = String(caseDoc?._id || caseDoc?.id || "");
  const intentId = String(paymentIntent?.id || "");
  const recordedIntentIds = [caseDoc?.escrowIntentId, caseDoc?.paymentIntentId]
    .filter(Boolean)
    .map(String);
  const metadataCaseId = String(paymentIntent?.metadata?.caseId || "");
  const transferGroup = String(paymentIntent?.transfer_group || "");
  const currency = String(paymentIntent?.currency || "").toLowerCase();
  const amount = paymentIntentAmount(paymentIntent);

  if (!intentId) reasons.push("missing_payment_intent_id");
  if (recordedIntentIds.length && intentId && !recordedIntentIds.includes(intentId)) {
    reasons.push("payment_intent_id_mismatch");
  }
  if (!caseId || metadataCaseId !== caseId) reasons.push("case_metadata_mismatch");
  if (transferGroup !== `case_${caseId}`) reasons.push("transfer_group_mismatch");
  if (!expected.baseAmount || amount !== expected.totalAmount) reasons.push("amount_mismatch");
  if (!currency || currency !== expected.currency) reasons.push("currency_mismatch");

  const knownMode = String(caseDoc?.stripeMode || "unknown").toLowerCase();
  if (typeof paymentIntent?.livemode === "boolean" && ["live", "test"].includes(knownMode)) {
    const intentMode = paymentIntent.livemode ? "live" : "test";
    if (intentMode !== knownMode) reasons.push("stripe_mode_mismatch");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    expected,
    actual: { amount, currency, transferGroup, metadataCaseId, intentId },
  };
}

module.exports = {
  expectedCaseFunding,
  paymentIntentAmount,
  validatePaymentIntentForCase,
};
