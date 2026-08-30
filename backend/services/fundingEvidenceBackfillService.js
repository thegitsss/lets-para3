"use strict";

const crypto = require("crypto");
const { expectedCaseFunding, paymentIntentAmount, validatePaymentIntentForCase } = require("../utils/paymentIntegrity");
const { operationFingerprint } = require("./paymentOperationService");

const FUNDING_ID_FIELDS = ["paymentIntentId", "escrowIntentId", "hiringClaimPaymentIntentId"];
const EVIDENCE_FIELDS = [
  "stripePaymentIntentId",
  "stripeChargeId",
  "stripeBalanceTransactionId",
  "grossAmount",
  "processingFeeAmount",
  "netAmount",
  "currency",
  "stripeMode",
  "livemode",
];

function integerCents(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function fundingOperationKey(caseId, paymentIntentId) {
  return `funding:${String(caseId)}:${String(paymentIntentId)}`;
}

function maskIdentifier(value) {
  const raw = String(value || "");
  if (!raw) return "";
  const prefix = raw.includes("_") ? raw.slice(0, raw.indexOf("_") + 1) : "ref_";
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 10);
  return `${prefix}…${digest}`;
}

function distinctFundingIntentIds(caseDoc = {}) {
  const related = Array.isArray(caseDoc.relatedPaymentIntentIds) ? caseDoc.relatedPaymentIntentIds : [];
  return [...new Set([
    ...FUNDING_ID_FIELDS.map((field) => String(caseDoc[field] || "").trim()),
    ...related.map((value) => String(value || "").trim()),
  ].filter(Boolean))];
}

function distinctRelatedIds(caseDoc = {}, field) {
  const values = Array.isArray(caseDoc[field]) ? caseDoc[field] : [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeExternalObject(value) {
  if (!value) return null;
  if (typeof value === "string") return { id: value };
  return value;
}

function uniqueObjectsById(values = []) {
  const seen = new Set();
  return values.filter((value) => {
    const id = String(value?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function resolveCharge(stripeClient, paymentIntent, fallbackChargeIds = []) {
  const candidates = uniqueObjectsById([
    normalizeExternalObject(paymentIntent?.latest_charge),
    ...(Array.isArray(paymentIntent?.charges?.data)
      ? paymentIntent.charges.data.map(normalizeExternalObject)
      : []),
    ...fallbackChargeIds.map(normalizeExternalObject),
  ].filter(Boolean));
  if (!candidates.length) return { reasons: ["charge_unmatched"] };
  if (candidates.length > 1) return { reasons: ["multiple_charges_ambiguous"] };
  let charge = candidates[0];
  if (!charge.balance_transaction || typeof charge.balance_transaction === "string") {
    charge = await stripeClient.charges.retrieve(charge.id, { expand: ["balance_transaction"] });
  }
  return { charge, reasons: [] };
}

async function resolveBalanceTransaction(stripeClient, charge, fallbackBalanceTransactionIds = []) {
  const candidates = uniqueObjectsById([
    normalizeExternalObject(charge?.balance_transaction),
    ...fallbackBalanceTransactionIds.map(normalizeExternalObject),
  ].filter(Boolean));
  if (candidates.length > 1) return { reasons: ["multiple_balance_transactions_ambiguous"] };
  let balanceTransaction = candidates[0] || null;
  if (!balanceTransaction?.id) return { reasons: ["balance_transaction_unmatched"] };
  if (
    integerCents(balanceTransaction.amount) === null ||
    integerCents(balanceTransaction.fee) === null ||
    integerCents(balanceTransaction.net) === null
  ) {
    balanceTransaction = await stripeClient.balanceTransactions.retrieve(balanceTransaction.id);
  }
  return { balanceTransaction, reasons: [] };
}

function buildEvidence(caseDoc, paymentIntent, charge, balanceTransaction) {
  const grossAmount = integerCents(balanceTransaction?.amount);
  const processingFeeAmount = integerCents(balanceTransaction?.fee);
  const netAmount = integerCents(balanceTransaction?.net);
  const currency = String(balanceTransaction?.currency || paymentIntent?.currency || "").toLowerCase();
  const livemode = paymentIntent?.livemode;
  return {
    caseId: String(caseDoc?._id || caseDoc?.id || ""),
    stripePaymentIntentId: String(paymentIntent?.id || ""),
    stripeChargeId: String(charge?.id || ""),
    stripeBalanceTransactionId: String(balanceTransaction?.id || ""),
    grossAmount,
    processingFeeAmount,
    netAmount,
    currency,
    stripeMode: typeof livemode === "boolean" ? (livemode ? "live" : "test") : "unknown",
    livemode: typeof livemode === "boolean" ? livemode : null,
  };
}

function validateEvidence(caseDoc, paymentIntent, charge, balanceTransaction, evidence) {
  const reasons = [];
  if (paymentIntent?.status !== "succeeded") reasons.push("payment_intent_not_succeeded");
  if (charge?.refunded || Number(charge?.amount_refunded || 0) > 0) reasons.push("charge_refunded");
  if (charge?.disputed || charge?.dispute) reasons.push("charge_disputed");
  if (charge?.paid === false || charge?.captured === false || charge?.status === "failed") {
    reasons.push("charge_not_successful");
  }

  const integrity = validatePaymentIntentForCase(paymentIntent, caseDoc);
  reasons.push(...integrity.reasons.map((reason) => `case_${reason}`));

  const intentGross = paymentIntentAmount(paymentIntent);
  const chargeGross = integerCents(charge?.amount);
  if (chargeGross === null || chargeGross !== intentGross) reasons.push("charge_amount_mismatch");
  if (
    evidence.grossAmount === null ||
    evidence.processingFeeAmount === null ||
    evidence.netAmount === null ||
    evidence.grossAmount < 0 ||
    evidence.processingFeeAmount < 0 ||
    evidence.netAmount < 0
  ) {
    reasons.push("invalid_balance_transaction_amounts");
  } else {
    if (evidence.grossAmount !== intentGross) reasons.push("balance_transaction_amount_mismatch");
    if (evidence.grossAmount - evidence.processingFeeAmount !== evidence.netAmount) {
      reasons.push("balance_transaction_net_mismatch");
    }
  }
  if (!evidence.currency) reasons.push("currency_missing");
  if (String(charge?.currency || "").toLowerCase() !== evidence.currency) reasons.push("charge_currency_mismatch");
  if (String(paymentIntent?.currency || "").toLowerCase() !== evidence.currency) reasons.push("intent_currency_mismatch");
  if (evidence.livemode === null) reasons.push("livemode_missing");
  if (typeof charge?.livemode === "boolean" && charge.livemode !== evidence.livemode) reasons.push("livemode_mismatch");
  if (balanceTransaction?.type && balanceTransaction.type !== "charge") reasons.push("balance_transaction_type_mismatch");
  return [...new Set(reasons)];
}

function operationMatchesEvidence(operation, evidence) {
  const conflicts = [];
  const missing = {};
  for (const field of EVIDENCE_FIELDS) {
    const actual = operation?.[field];
    const expected = evidence[field];
    const absent = actual === undefined || actual === null || actual === "";
    if (absent) {
      missing[field] = expected;
    } else if (String(actual) !== String(expected)) {
      conflicts.push(field);
    }
  }
  return { conflicts, missing };
}

function findRelatedOperations(operations, operationKey, evidence) {
  return operations.filter((operation) =>
    operation.operationKey === operationKey ||
    String(operation.stripePaymentIntentId || "") === evidence.stripePaymentIntentId ||
    String(operation.stripeChargeId || "") === evidence.stripeChargeId ||
    String(operation.stripeBalanceTransactionId || "") === evidence.stripeBalanceTransactionId
  );
}

async function inspectFundingCandidate({ caseDoc, operations = [], stripeClient, paymentIntent: suppliedPaymentIntent }) {
  const caseId = String(caseDoc?._id || caseDoc?.id || "");
  let ids = distinctFundingIntentIds(caseDoc);
  const base = { caseId, caseRef: maskIdentifier(caseId), reasons: [], refundedAmount: 0 };
  if (!ids.length) {
    const chargeIds = distinctRelatedIds(caseDoc, "relatedChargeIds");
    const balanceTransactionIds = distinctRelatedIds(caseDoc, "relatedBalanceTransactionIds");
    if (chargeIds.length > 1 || balanceTransactionIds.length > 1) {
      return { ...base, action: "review", reasons: ["multiple_external_identifiers_ambiguous"] };
    }
    try {
      let chargeId = chargeIds[0] || "";
      if (!chargeId && balanceTransactionIds[0]) {
        const balanceTransaction = await stripeClient.balanceTransactions.retrieve(balanceTransactionIds[0]);
        chargeId = String(balanceTransaction?.source?.id || balanceTransaction?.source || "");
      }
      if (chargeId) {
        const charge = await stripeClient.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
        const inferredPaymentIntentId = String(charge?.payment_intent?.id || charge?.payment_intent || "");
        if (inferredPaymentIntentId) ids = [inferredPaymentIntentId];
      }
    } catch (_error) {
      return { ...base, action: "review", reasons: ["payment_intent_unmatched"] };
    }
  }
  if (!ids.length) return { ...base, action: "review", reasons: ["payment_intent_unmatched"] };
  if (ids.length > 1) {
    return {
      ...base,
      action: "review",
      paymentIntentRefs: ids.map(maskIdentifier),
      reasons: ["multiple_payment_intents_ambiguous"],
    };
  }

  const paymentIntentId = ids[0];
  base.paymentIntentRef = maskIdentifier(paymentIntentId);
  let paymentIntent = suppliedPaymentIntent;
  if (!paymentIntent || String(paymentIntent.id || "") !== paymentIntentId) {
    try {
      paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge.balance_transaction", "charges.data.balance_transaction"],
      });
    } catch (_error) {
      return { ...base, action: "review", reasons: ["payment_intent_unmatched"] };
    }
  }

  let chargeResult;
  try {
    const intentOperations = operations.filter((operation) =>
      operation.operationKey === fundingOperationKey(caseId, paymentIntentId) ||
      String(operation.stripePaymentIntentId || operation.stripeObjectId || "") === paymentIntentId
    );
    chargeResult = await resolveCharge(
      stripeClient,
      paymentIntent,
      [
        ...intentOperations.map((operation) => operation.stripeChargeId).filter(Boolean),
        ...distinctRelatedIds(caseDoc, "relatedChargeIds"),
      ]
    );
  } catch (_error) {
    return { ...base, action: "review", reasons: ["charge_unmatched"] };
  }
  if (chargeResult.reasons.length) return { ...base, action: "review", reasons: chargeResult.reasons };
  const charge = chargeResult.charge;
  base.chargeRef = maskIdentifier(charge.id);
  base.refundedAmount = Math.max(0, Number(charge.amount_refunded || 0));

  let balanceResult;
  try {
    balanceResult = await resolveBalanceTransaction(
      stripeClient,
      charge,
      operations
        .filter((operation) => String(operation.stripeChargeId || "") === String(charge.id || ""))
        .map((operation) => operation.stripeBalanceTransactionId)
        .filter(Boolean)
        .concat(distinctRelatedIds(caseDoc, "relatedBalanceTransactionIds"))
    );
  } catch (_error) {
    return { ...base, action: "review", reasons: ["balance_transaction_unmatched"] };
  }
  if (balanceResult.reasons.length) return { ...base, action: "review", reasons: balanceResult.reasons };
  const balanceTransaction = balanceResult.balanceTransaction;
  base.balanceTransactionRef = maskIdentifier(balanceTransaction.id);

  const evidence = buildEvidence(caseDoc, paymentIntent, charge, balanceTransaction);
  const reasons = validateEvidence(caseDoc, paymentIntent, charge, balanceTransaction, evidence);
  if (reasons.length) return { ...base, action: "review", reasons, evidence };

  const operationKey = fundingOperationKey(caseId, paymentIntentId);
  const related = findRelatedOperations(operations, operationKey, evidence);
  if (related.length > 1) {
    return { ...base, action: "review", reasons: ["duplicate_operation_evidence"], evidence, operationKey };
  }
  if (!related.length) return { ...base, action: "create", evidence, operationKey };

  const existing = related[0];
  if (existing.kind !== "funding" || existing.operationKey !== operationKey || existing.status !== "succeeded") {
    return { ...base, action: "review", reasons: ["existing_operation_conflict"], evidence, operationKey };
  }
  const comparison = operationMatchesEvidence(existing, evidence);
  if (comparison.conflicts.length) {
    return {
      ...base,
      action: "review",
      reasons: comparison.conflicts.map((field) => `existing_${field}_conflict`),
      evidence,
      operationKey,
    };
  }
  if (Object.keys(comparison.missing).length) {
    return {
      ...base,
      action: "update",
      evidence,
      missing: comparison.missing,
      evidenceVerifiedAtMissing: !existing.evidenceVerifiedAt,
      operationKey,
      operationId: existing._id,
    };
  }
  return { ...base, action: "unchanged", evidence, operationKey, operationId: existing._id };
}

async function persistInspection(inspection, PaymentOperation, now = new Date()) {
  if (inspection.action === "create") {
    const evidence = inspection.evidence;
    return PaymentOperation.create({
      operationKey: inspection.operationKey,
      caseId: evidence.caseId,
      kind: "funding",
      fingerprint: operationFingerprint(evidence),
      status: "succeeded",
      amount: evidence.grossAmount,
      stripeObjectId: evidence.stripePaymentIntentId,
      ...evidence,
      attempts: 1,
      lastAttemptAt: now,
      completedAt: now,
      evidenceVerifiedAt: now,
    });
  }
  if (inspection.action === "update") {
    const additions = { ...inspection.missing };
    if (inspection.evidenceVerifiedAtMissing) additions.evidenceVerifiedAt = now;
    return PaymentOperation.findOneAndUpdate(
      {
        _id: inspection.operationId,
        operationKey: inspection.operationKey,
        kind: "funding",
        status: "succeeded",
      },
      { $set: additions },
      { returnDocument: "after" }
    );
  }
  return null;
}

async function reconcileFundingEvidence({
  caseDoc,
  paymentIntent,
  stripeClient,
  PaymentOperation,
  now = new Date(),
}) {
  const caseId = caseDoc?._id || caseDoc?.id;
  const operations = await PaymentOperation.find({ caseId, kind: "funding" }).lean();
  const inspection = await inspectFundingCandidate({
    caseDoc,
    operations,
    stripeClient,
    paymentIntent,
  });
  if (["create", "update"].includes(inspection.action)) {
    await persistInspection(inspection, PaymentOperation, now);
  } else if (inspection.action === "review" && distinctFundingIntentIds(caseDoc).length === 1) {
    const paymentIntentId = distinctFundingIntentIds(caseDoc)[0];
    const operationKey = fundingOperationKey(caseId, paymentIntentId);
    if (operations.some((operation) => operation.operationKey === operationKey && operation.status === "succeeded")) {
      return inspection;
    }
    await PaymentOperation.findOneAndUpdate(
      { operationKey },
      {
        $setOnInsert: {
          operationKey,
          caseId,
          kind: "funding",
          fingerprint: operationFingerprint({ caseId: String(caseId), paymentIntentId }),
          amount: expectedCaseFunding(caseDoc).totalAmount,
          currency: String(caseDoc.currency || "usd").toLowerCase(),
          stripeObjectId: paymentIntentId,
          stripePaymentIntentId: paymentIntentId,
          attempts: 1,
        },
        $set: {
          status: "needs_reconciliation",
          lastAttemptAt: now,
          lastError: inspection.reasons.join(",").slice(0, 2000),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
  }
  return inspection;
}

function addReason(report, reasons = []) {
  for (const reason of reasons) {
    report.reviewByReason[reason] = (report.reviewByReason[reason] || 0) + 1;
  }
}

function addAmount(target, key, value) {
  target[key] += Number(value || 0);
}

function duplicateEvidenceGroups(operations = []) {
  const fields = ["stripePaymentIntentId", "stripeChargeId", "stripeBalanceTransactionId"];
  const duplicates = [];
  for (const field of fields) {
    const counts = new Map();
    operations.forEach((operation) => {
      const value = String(operation?.[field] || "");
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    });
    counts.forEach((count, value) => {
      if (count > 1) duplicates.push({ field, reference: maskIdentifier(value), count });
    });
  }
  return duplicates;
}

async function buildFundingEvidenceReport({
  cases,
  operations,
  payouts = [],
  stripeClient,
  apply = false,
  PaymentOperation,
  now = new Date(),
}) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    generatedAt: now.toISOString(),
    counts: {
      historicalCaseRecords: cases.length,
      historicalFundingTransactions: 0,
      recordedLiveMode: 0,
      recordedTestMode: 0,
      recordedUnknownMode: 0,
      liveMode: 0,
      testMode: 0,
      unknownMode: 0,
      matched: 0,
      reviewRequired: 0,
      duplicateEvidence: 0,
      expectedCreates: 0,
      expectedUpdates: 0,
      unchangedVerified: 0,
      appliedCreates: 0,
      appliedUpdates: 0,
    },
    aggregates: {
      grossCharges: 0,
      processingFees: 0,
      netCharges: 0,
      stripeRefundsObserved: 0,
      recordedRefunds: operations
        .filter((operation) => operation.kind === "refund")
        .reduce((sum, operation) => sum + Number(operation.refundAmount || 0), 0),
      payoutsByStatus: payouts.reduce((summary, payout) => {
        const status = String(payout.status || "unknown");
        summary[status] = (summary[status] || 0) + Number(payout.amountPaid || 0);
        return summary;
      }, {}),
    },
    reviewByReason: {},
    reviewItems: [],
    duplicateEvidence: duplicateEvidenceGroups(operations),
    expectedFieldChanges: {
      creates: { records: 0, fields: [...EVIDENCE_FIELDS, "operationKey", "caseId", "kind", "status", "amount"] },
      updates: { records: 0, fields: {} },
    },
  };
  report.counts.duplicateEvidence = report.duplicateEvidence.length;

  for (const caseDoc of cases) {
    const intentCount = distinctFundingIntentIds(caseDoc).length;
    report.counts.historicalFundingTransactions += intentCount || 1;
    const recordedMode = String(caseDoc?.stripeMode || "unknown").toLowerCase();
    const recordedModeKey = recordedMode === "live"
      ? "recordedLiveMode"
      : recordedMode === "test"
        ? "recordedTestMode"
        : "recordedUnknownMode";
    report.counts[recordedModeKey] += intentCount || 1;
    const inspection = await inspectFundingCandidate({ caseDoc, operations, stripeClient });
    addAmount(report.aggregates, "stripeRefundsObserved", inspection.refundedAmount);
    if (inspection.action === "review") {
      report.counts.reviewRequired += 1;
      addReason(report, inspection.reasons);
      report.reviewItems.push({
        caseRef: inspection.caseRef,
        paymentIntentRef: inspection.paymentIntentRef || "",
        chargeRef: inspection.chargeRef || "",
        balanceTransactionRef: inspection.balanceTransactionRef || "",
        reasons: inspection.reasons,
      });
      continue;
    }

    report.counts.matched += 1;
    const modeKey = inspection.evidence.stripeMode === "live"
      ? "liveMode"
      : inspection.evidence.stripeMode === "test"
        ? "testMode"
        : "unknownMode";
    report.counts[modeKey] += 1;
    addAmount(report.aggregates, "grossCharges", inspection.evidence.grossAmount);
    addAmount(report.aggregates, "processingFees", inspection.evidence.processingFeeAmount);
    addAmount(report.aggregates, "netCharges", inspection.evidence.netAmount);

    if (inspection.action === "create") {
      report.counts.expectedCreates += 1;
      report.expectedFieldChanges.creates.records += 1;
    }
    if (inspection.action === "update") {
      report.counts.expectedUpdates += 1;
      report.expectedFieldChanges.updates.records += 1;
      Object.keys(inspection.missing || {}).forEach((field) => {
        report.expectedFieldChanges.updates.fields[field] =
          (report.expectedFieldChanges.updates.fields[field] || 0) + 1;
      });
    }
    if (inspection.action === "unchanged") report.counts.unchangedVerified += 1;
    if (apply && ["create", "update"].includes(inspection.action)) {
      await persistInspection(inspection, PaymentOperation, now);
      report.counts[inspection.action === "create" ? "appliedCreates" : "appliedUpdates"] += 1;
    }
  }
  return report;
}

module.exports = {
  EVIDENCE_FIELDS,
  buildEvidence,
  buildFundingEvidenceReport,
  duplicateEvidenceGroups,
  distinctFundingIntentIds,
  distinctRelatedIds,
  fundingOperationKey,
  inspectFundingCandidate,
  maskIdentifier,
  operationMatchesEvidence,
  persistInspection,
  reconcileFundingEvidence,
  validateEvidence,
};
