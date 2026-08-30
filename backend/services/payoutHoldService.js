"use strict";

const PaymentOperation = require("../models/PaymentOperation");

const ACTIVE_ADMIN_REVIEW_STATES = Object.freeze(["pending_review", "acknowledged"]);

class PayoutHeldForChargebackError extends Error {
  constructor() {
    super("This payout is frozen for administrative payment review.");
    this.name = "PayoutHeldForChargebackError";
    this.code = "PAYOUT_HELD_FOR_CHARGEBACK";
    this.statusCode = 409;
  }
}

async function getPayoutHold(caseId, { PaymentOperationModel = PaymentOperation } = {}) {
  if (!caseId) return { held: false, operation: null };
  const operation = await PaymentOperationModel.findOne({
    caseId,
    kind: "chargeback",
    payoutPosition: "pre_payout",
    administrativeStatus: { $in: ACTIVE_ADMIN_REVIEW_STATES },
  }).sort({ processorEventCreatedAt: -1, createdAt: -1 });
  return { held: Boolean(operation), operation };
}

async function assertPayoutNotHeld(caseId, options = {}) {
  const hold = await getPayoutHold(caseId, options);
  if (hold.held) throw new PayoutHeldForChargebackError();
  return hold;
}

async function createPayoutTransfer({
  caseId,
  stripeClient,
  payload,
  stripeOptions,
  bypassTransfer = null,
  PaymentOperationModel = PaymentOperation,
}) {
  await assertPayoutNotHeld(caseId, { PaymentOperationModel });
  const transfer = bypassTransfer || await stripeClient.transfers.create(payload, stripeOptions);
  await PaymentOperationModel.updateMany(
    {
      caseId,
      kind: "chargeback",
      payoutPosition: "pre_payout",
      administrativeStatus: { $in: ACTIVE_ADMIN_REVIEW_STATES },
    },
    {
      $set: {
        payoutPosition: "post_payout",
        status: "needs_reconciliation",
        lastError: "A payout transfer completed concurrently with chargeback processing; admin reconciliation is required.",
      },
    }
  );
  await PaymentOperationModel.updateMany(
    {
      caseId,
      kind: "chargeback",
      payoutPosition: "pre_payout",
    },
    { $set: { payoutPosition: "post_payout" } }
  );
  return transfer;
}

module.exports = {
  ACTIVE_ADMIN_REVIEW_STATES,
  PayoutHeldForChargebackError,
  assertPayoutNotHeld,
  createPayoutTransfer,
  getPayoutHold,
};
