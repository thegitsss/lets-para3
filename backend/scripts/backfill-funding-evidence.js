#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Case = require("../models/Case");
const PaymentOperation = require("../models/PaymentOperation");
const Payout = require("../models/Payout");
const stripe = require("../utils/stripe");
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require("../utils/mongooseOperationPolicy");
const { buildFundingEvidenceReport } = require("../services/fundingEvidenceBackfillService");

const APPLY = process.argv.includes("--apply");
const APPLY_CONFIRMATION = "apply-reviewed-funding-evidence";

function argumentValue(name, args = process.argv) {
  const prefix = `${name}=`;
  const match = args.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function assertApplyGuard(expectedChanges, { apply = APPLY, args = process.argv } = {}) {
  if (!apply) return;
  if (argumentValue("--confirm", args) !== APPLY_CONFIRMATION) {
    throw new Error(`Apply mode requires --confirm=${APPLY_CONFIRMATION}.`);
  }
  const expected = Number(argumentValue("--expected-records", args));
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== expectedChanges) {
    throw new Error(`Apply mode expected ${expectedChanges} changes; pass --expected-records=${expectedChanges}.`);
  }
}

async function loadInputs() {
  const referencedOperations = await PaymentOperation.find({
    $or: [
      { kind: "funding" },
      { stripePaymentIntentId: { $type: "string", $ne: "" } },
      { stripeObjectId: /^pi_/ },
      { stripeObjectId: /^ch_/ },
      { stripeObjectId: /^txn_/ },
    ],
  }).select("caseId").lean();
  const operationCaseIds = referencedOperations.map((operation) => operation.caseId).filter(Boolean);
  const cases = await Case.find({
    $or: [
      { paymentIntentId: { $type: "string", $ne: "" } },
      { escrowIntentId: { $type: "string", $ne: "" } },
      { hiringClaimPaymentIntentId: { $type: "string", $ne: "" } },
      { _id: { $in: operationCaseIds } },
    ],
  })
    .select(
      "paymentIntentId escrowIntentId hiringClaimPaymentIntentId lockedTotalAmount totalAmount feeAttorneyPct feeAttorneyAmount currency stripeMode escrowStatus paymentStatus fundingIntegrityStatus"
    )
    .sort({ _id: 1 })
    .lean();
  const caseIds = cases.map((caseDoc) => caseDoc._id);
  const [operations, payouts] = await Promise.all([
    PaymentOperation.find({ caseId: { $in: caseIds } }).lean(),
    Payout.find({ caseId: { $in: caseIds } }).select("caseId amountPaid status stripeMode").lean(),
  ]);
  const operationsByCase = operations.reduce((map, operation) => {
    const caseId = String(operation.caseId || "");
    const paymentIntentId = String(
      operation.stripePaymentIntentId || (/^pi_/.test(operation.stripeObjectId || "") ? operation.stripeObjectId : "")
    );
    if (caseId) {
      const references = map.get(caseId) || { paymentIntentIds: [], chargeIds: [], balanceTransactionIds: [] };
      if (paymentIntentId) references.paymentIntentIds.push(paymentIntentId);
      const chargeId = String(
        operation.stripeChargeId || (/^ch_/.test(operation.stripeObjectId || "") ? operation.stripeObjectId : "")
      );
      const balanceTransactionId = String(
        operation.stripeBalanceTransactionId ||
          (/^txn_/.test(operation.stripeObjectId || "") ? operation.stripeObjectId : "")
      );
      if (chargeId) references.chargeIds.push(chargeId);
      if (balanceTransactionId) references.balanceTransactionIds.push(balanceTransactionId);
      map.set(caseId, references);
    }
    return map;
  }, new Map());
  return {
    cases: cases.map((caseDoc) => ({
      ...caseDoc,
      relatedPaymentIntentIds: operationsByCase.get(String(caseDoc._id))?.paymentIntentIds || [],
      relatedChargeIds: operationsByCase.get(String(caseDoc._id))?.chargeIds || [],
      relatedBalanceTransactionIds:
        operationsByCase.get(String(caseDoc._id))?.balanceTransactionIds || [],
    })),
    operations,
    payouts,
  };
}

async function run({ apply = APPLY, mongoUri = process.env.MONGO_URI, stripeClient = stripe } = {}) {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
  }
  const inputs = await loadInputs();
  const dryRun = await buildFundingEvidenceReport({ ...inputs, stripeClient, apply: false });
  console.log(JSON.stringify(dryRun, null, 2));
  if (!apply) return dryRun;

  const expectedChanges = dryRun.counts.expectedCreates + dryRun.counts.expectedUpdates;
  assertApplyGuard(expectedChanges, { apply });
  if (dryRun.counts.reviewRequired > 0) {
    throw new Error(`Apply mode is blocked while ${dryRun.counts.reviewRequired} transaction(s) require manual review.`);
  }
  if (dryRun.counts.duplicateEvidence > 0) {
    throw new Error(`Apply mode is blocked while ${dryRun.counts.duplicateEvidence} duplicate evidence group(s) remain.`);
  }

  const refreshedInputs = await loadInputs();
  const refreshedDryRun = await buildFundingEvidenceReport({
    ...refreshedInputs,
    stripeClient,
    apply: false,
  });
  const approvedSignature = JSON.stringify({
    counts: dryRun.counts,
    aggregates: dryRun.aggregates,
    reviewByReason: dryRun.reviewByReason,
    duplicateEvidence: dryRun.duplicateEvidence,
    expectedFieldChanges: dryRun.expectedFieldChanges,
  });
  const refreshedSignature = JSON.stringify({
    counts: refreshedDryRun.counts,
    aggregates: refreshedDryRun.aggregates,
    reviewByReason: refreshedDryRun.reviewByReason,
    duplicateEvidence: refreshedDryRun.duplicateEvidence,
    expectedFieldChanges: refreshedDryRun.expectedFieldChanges,
  });
  if (approvedSignature !== refreshedSignature) {
    throw new Error("Funding evidence changed after the guarded dry run; rerun review before applying.");
  }
  const applyReport = await buildFundingEvidenceReport({
    ...refreshedInputs,
    stripeClient,
    apply: true,
    PaymentOperation,
  });
  console.log(JSON.stringify(applyReport, null, 2));
  return applyReport;
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { APPLY_CONFIRMATION, assertApplyGuard, loadInputs, run };
