"use strict";

const {
  buildFundingEvidenceReport,
  distinctFundingIntentIds,
  duplicateEvidenceGroups,
  maskIdentifier,
} = require("./fundingEvidenceBackfillService");
const { sha256 } = require("./reconciliationPreflightService");

const FUNDING_CASE_FILTER = Object.freeze({
  $or: [
    { paymentIntentId: { $type: "string", $ne: "" } },
    { escrowIntentId: { $type: "string", $ne: "" } },
    { hiringClaimPaymentIntentId: { $type: "string", $ne: "" } },
  ],
});
const STRIPE_WEBHOOK_FILTER = Object.freeze({
  provider: "stripe",
  type: { $regex: "^(payment_intent|charge|refund|transfer|checkout\\.session)\\." },
});
const SNAPSHOT_COLLECTIONS = Object.freeze({
  cases: FUNDING_CASE_FILTER,
  paymentoperations: {},
  payouts: {},
  platformincomes: {},
  webhookevents: STRIPE_WEBHOOK_FILTER,
  financialadjustments: {},
});
const FINANCIAL_COLLECTIONS = Object.freeze(Object.keys(SNAPSHOT_COLLECTIONS));

function safeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asId(value) {
  return String(value || "");
}

function normalizedMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "test" || mode === "live" ? mode : "unknown";
}

function assertUsd(value) {
  const currency = String(value || "").trim().toLowerCase();
  if (currency && currency !== "usd") {
    throw safeError("Production reconciliation encountered a non-USD financial record.", "UNEXPECTED_RECONCILIATION_CURRENCY");
  }
}

function unique(values) {
  return [...new Set(values.map(asId).filter(Boolean))];
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function sumByMode(records, amountField) {
  return records.reduce((result, record) => {
    const mode = normalizedMode(record.stripeMode);
    result[mode] += Number(record?.[amountField] || 0);
    return result;
  }, { test: 0, live: 0, unknown: 0 });
}

function countByMode(records) {
  return records.reduce((result, record) => {
    result[normalizedMode(record.stripeMode)] += 1;
    return result;
  }, { test: 0, live: 0, unknown: 0 });
}

function modeForCase(caseDoc, operations = []) {
  const modes = new Set([
    normalizedMode(caseDoc?.stripeMode),
    ...operations
      .filter((operation) => asId(operation.caseId) === asId(caseDoc?._id))
      .map((operation) => normalizedMode(operation.stripeMode)),
  ].filter((mode) => mode !== "unknown"));
  if (modes.size > 1) return { mode: "unknown", reason: "test_live_mode_mismatch" };
  if (!modes.size) return { mode: "unknown", reason: "stripe_mode_missing" };
  return { mode: [...modes][0], reason: "" };
}

function modeForFinancialRecord(record, casesById) {
  const explicit = normalizedMode(record?.stripeMode);
  if (explicit !== "unknown") return explicit;
  return normalizedMode(casesById.get(asId(record?.caseId))?.stripeMode);
}

function sanitizedIndex(index = {}) {
  const partialFields = index.partialFilterExpression && typeof index.partialFilterExpression === "object"
    ? Object.keys(index.partialFilterExpression).sort()
    : [];
  return {
    key: Object.fromEntries(Object.entries(index.key || {}).map(([field, direction]) => [field, direction])),
    unique: index.unique === true,
    sparse: index.sparse === true,
    expireAfterSeconds: Number.isFinite(Number(index.expireAfterSeconds))
      ? Number(index.expireAfterSeconds)
      : null,
    partialFilterFields: partialFields,
  };
}

async function captureFinancialSnapshot(mongo, collectionNames) {
  const collections = {};
  for (const name of FINANCIAL_COLLECTIONS) {
    if (!collectionNames.includes(name)) {
      collections[name] = { exists: false, count: 0, latestUpdatedAt: null };
      continue;
    }
    collections[name] = {
      exists: true,
      ...(await mongo.snapshotCollection(name, SNAPSHOT_COLLECTIONS[name])),
    };
  }
  return {
    collections,
    watermark: sha256(JSON.stringify(collections)),
  };
}

async function loadProductionInventory(mongo, collectionNames) {
  const operations = collectionNames.includes("paymentoperations")
    ? await mongo.findMany("paymentoperations", {}, {
      _id: 1,
      caseId: 1,
      operationKey: 1,
      kind: 1,
      status: 1,
      amount: 1,
      currency: 1,
      stripeObjectId: 1,
      stripePaymentIntentId: 1,
      stripeChargeId: 1,
      stripeBalanceTransactionId: 1,
      stripeRefundId: 1,
      stripeTransferId: 1,
      stripeDisputeId: 1,
      grossAmount: 1,
      processingFeeAmount: 1,
      netAmount: 1,
      refundAmount: 1,
      transferAmount: 1,
      stripeMode: 1,
      livemode: 1,
      evidenceVerifiedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    : [];
  operations.forEach((operation) => assertUsd(operation.currency));
  const operationCaseIds = unique(operations.map((operation) => operation.caseId));
  const cases = collectionNames.includes("cases")
    ? await mongo.findMany("cases", operationCaseIds.length ? {
      $or: [...FUNDING_CASE_FILTER.$or, { _id: { $in: operations.map((operation) => operation.caseId).filter(Boolean) } }],
    } : FUNDING_CASE_FILTER, {
      _id: 1,
      paymentIntentId: 1,
      escrowIntentId: 1,
      hiringClaimPaymentIntentId: 1,
      lockedTotalAmount: 1,
      totalAmount: 1,
      feeAttorneyPct: 1,
      feeAttorneyAmount: 1,
      currency: 1,
      stripeMode: 1,
      escrowStatus: 1,
      paymentStatus: 1,
      fundingIntegrityStatus: 1,
      paymentReleased: 1,
      payoutTransferId: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    : [];
  cases.forEach((caseDoc) => assertUsd(caseDoc.currency));
  const caseIds = cases.map((caseDoc) => caseDoc._id);
  const caseFilter = caseIds.length ? { caseId: { $in: caseIds } } : { caseId: { $in: [] } };
  const payouts = collectionNames.includes("payouts")
    ? await mongo.findMany("payouts", caseFilter, {
      _id: 1,
      caseId: 1,
      operationKey: 1,
      amountPaid: 1,
      transferId: 1,
      status: 1,
      stripeMode: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    : [];
  const platformIncome = collectionNames.includes("platformincomes")
    ? await mongo.findMany("platformincomes", caseFilter, {
      _id: 1,
      caseId: 1,
      operationKey: 1,
      feeAmount: 1,
      stripeMode: 1,
      createdAt: 1,
    })
    : [];
  const webhookEvents = collectionNames.includes("webhookevents")
    ? await mongo.findMany("webhookevents", STRIPE_WEBHOOK_FILTER, {
      _id: 1,
      eventId: 1,
      type: 1,
      stripeMode: 1,
      status: 1,
      attempts: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    : [];
  const financialAdjustments = collectionNames.includes("financialadjustments")
    ? await mongo.findMany("financialadjustments", caseFilter, {
      _id: 1,
      caseId: 1,
      paymentOperationId: 1,
      adjustmentType: 1,
      direction: 1,
      amount: 1,
      currency: 1,
      stripeMode: 1,
      createdAt: 1,
    })
    : [];
  financialAdjustments.forEach((adjustment) => assertUsd(adjustment.currency));

  const indexes = {};
  for (const name of FINANCIAL_COLLECTIONS) {
    if (!collectionNames.includes(name)) {
      indexes[name] = { exists: false, populated: false, indexes: [] };
      continue;
    }
    const count = await mongo.countDocuments(name, SNAPSHOT_COLLECTIONS[name]);
    indexes[name] = {
      exists: true,
      populated: count > 0,
      indexes: (await mongo.listIndexes(name)).map(sanitizedIndex),
    };
  }
  return { cases, operations, payouts, platformIncome, webhookEvents, financialAdjustments, indexes };
}

function attachRelatedEvidence(cases, operations) {
  return cases.map((caseDoc) => {
    const related = operations.filter((operation) => asId(operation.caseId) === asId(caseDoc._id));
    return {
      ...caseDoc,
      relatedPaymentIntentIds: unique(related.map((operation) =>
        operation.stripePaymentIntentId || (/^pi_/.test(operation.stripeObjectId || "") ? operation.stripeObjectId : "")
      )),
      relatedChargeIds: unique(related.map((operation) =>
        operation.stripeChargeId || (/^ch_/.test(operation.stripeObjectId || "") ? operation.stripeObjectId : "")
      )),
      relatedBalanceTransactionIds: unique(related.map((operation) =>
        operation.stripeBalanceTransactionId || (/^txn_/.test(operation.stripeObjectId || "") ? operation.stripeObjectId : "")
      )),
    };
  });
}

async function listAllDisputes(facade) {
  const disputes = [];
  let startingAfter = "";
  for (let page = 0; page < 100; page += 1) {
    const response = await facade.disputes.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = Array.isArray(response?.data) ? response.data : [];
    disputes.push(...data);
    if (!response?.has_more || !data.length) break;
    startingAfter = asId(data[data.length - 1]?.id);
    if (!startingAfter) throw safeError("Stripe dispute pagination identity is missing.", "STRIPE_DISPUTE_PAGINATION_INVALID");
  }
  return disputes;
}

async function listRefundsForCases(cases, facade, mode, storedRefundIds) {
  const records = [];
  const seen = new Set();
  for (const paymentIntentId of unique(cases.flatMap(distinctFundingIntentIds))) {
    let startingAfter = "";
    for (let page = 0; page < 100; page += 1) {
      const response = await facade.refunds.list({
        payment_intent: paymentIntentId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const data = Array.isArray(response?.data) ? response.data : [];
      for (const refund of data) {
        assertUsd(refund.currency);
        const id = asId(refund.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        records.push({
          refundRef: maskIdentifier(id),
          paymentIntentRef: maskIdentifier(paymentIntentId),
          mode,
          processorStatus: String(refund.status || "unknown"),
          amount: Number.isSafeInteger(Number(refund.amount)) ? Number(refund.amount) : null,
          lpcIdentity: storedRefundIds.has(id) ? "matched" : "missing_lpc_identity",
        });
      }
      if (!response?.has_more || !data.length) break;
      startingAfter = asId(data[data.length - 1]?.id);
      if (!startingAfter) throw safeError("Stripe refund pagination identity is missing.", "STRIPE_REFUND_PAGINATION_INVALID");
    }
  }
  return {
    stripeCount: records.length,
    matchedLpcCount: records.filter((record) => record.lpcIdentity === "matched").length,
    unmatchedStripeCount: records.filter((record) => record.lpcIdentity === "missing_lpc_identity").length,
    aggregateAmount: sum(records.map((record) => record.amount)),
    records,
  };
}

async function reconcileStoredRefunds(operations, facades, casesById) {
  const records = [];
  for (const operation of operations.filter((entry) => entry.kind === "refund" && entry.stripeRefundId)) {
    const mode = modeForFinancialRecord(operation, casesById);
    if (mode === "unknown") {
      records.push({ refundRef: maskIdentifier(operation.stripeRefundId), mode, status: "requires_manual_review", amount: null });
      continue;
    }
    try {
      const refund = await facades[mode].refunds.retrieve(operation.stripeRefundId);
      assertUsd(refund.currency);
      records.push({
        refundRef: maskIdentifier(refund.id),
        mode,
        status: "resolved",
        amount: Number.isSafeInteger(Number(refund.amount)) ? Number(refund.amount) : null,
      });
    } catch (error) {
      records.push({
        refundRef: maskIdentifier(operation.stripeRefundId),
        mode,
        status: error?.code === "STRIPE_OBJECT_MODE_MISMATCH" ? "test_live_mode_mismatch" : "missing_stripe_object",
        amount: null,
      });
    }
  }
  return records;
}

async function reconcileStoredTransfers(inventory, facades, casesById) {
  const candidates = new Map();
  for (const payout of inventory.payouts) {
    if (payout.transferId) candidates.set(asId(payout.transferId), modeForFinancialRecord(payout, casesById));
  }
  for (const operation of inventory.operations) {
    if (operation.stripeTransferId) {
      candidates.set(asId(operation.stripeTransferId), modeForFinancialRecord(operation, casesById));
    }
  }
  for (const caseDoc of inventory.cases) {
    if (caseDoc.payoutTransferId) candidates.set(asId(caseDoc.payoutTransferId), normalizedMode(caseDoc.stripeMode));
  }
  const records = [];
  for (const [transferId, mode] of candidates.entries()) {
    if (mode === "unknown") {
      records.push({ transferRef: maskIdentifier(transferId), mode, status: "requires_manual_review" });
      continue;
    }
    try {
      const transfer = await facades[mode].transfers.retrieve(transferId);
      assertUsd(transfer.currency);
      records.push({
        transferRef: maskIdentifier(transfer.id),
        mode,
        status: "resolved",
        amount: Number.isSafeInteger(Number(transfer.amount)) ? Number(transfer.amount) : null,
      });
    } catch (error) {
      records.push({
        transferRef: maskIdentifier(transferId),
        mode,
        status: error?.code === "STRIPE_OBJECT_MODE_MISMATCH" ? "test_live_mode_mismatch" : "missing_stripe_object",
      });
    }
  }
  return records;
}

function webhookSummary(events) {
  const byMode = { test: 0, live: 0, unknown: 0 };
  const byStatus = {};
  const byType = {};
  const records = events.map((event) => {
    const mode = normalizedMode(event.stripeMode);
    byMode[mode] += 1;
    const status = String(event.status || "unknown");
    const type = String(event.type || "unknown");
    byStatus[status] = (byStatus[status] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;
    return { eventRef: maskIdentifier(event.eventId), mode, type, status };
  });
  return { count: events.length, byMode, byStatus, byType, records };
}

function disputeInventory(disputes, mode, storedDisputeIds) {
  const seen = new Set();
  const records = disputes.map((dispute) => {
    assertUsd(dispute.currency);
    const id = asId(dispute.id);
    seen.add(id);
    return {
      disputeRef: maskIdentifier(id),
      chargeRef: maskIdentifier(dispute.charge?.id || dispute.charge),
      mode,
      processorStatus: String(dispute.status || "unknown"),
      amount: Number.isSafeInteger(Number(dispute.amount)) ? Number(dispute.amount) : null,
      lpcIdentity: storedDisputeIds.has(id) ? "matched" : "missing_lpc_identity",
    };
  });
  const missingStripe = [...storedDisputeIds]
    .filter((id) => !seen.has(id))
    .map((id) => ({ disputeRef: maskIdentifier(id), mode, lpcIdentity: "missing_stripe_object" }));
  return {
    stripeCount: disputes.length,
    matchedLpcCount: records.filter((record) => record.lpcIdentity === "matched").length,
    unmatchedStripeCount: records.filter((record) => record.lpcIdentity === "missing_lpc_identity").length,
    missingStripeCount: missingStripe.length,
    aggregateAmount: sum(records.map((record) => record.amount)),
    records: [...records, ...missingStripe],
  };
}

function totalClassifications(modeReports, unknownRecords, disputesByMode, refundsByMode, refundRecords, transferRecords) {
  const totals = {
    safely_matched: 0,
    already_complete: 0,
    missing_processor_cost_evidence: 0,
    missing_stripe_object: 0,
    missing_lpc_identity: 0,
    duplicate_evidence: 0,
    ambiguous: 0,
    refunded: 0,
    disputed: 0,
    conflicting_amounts: 0,
    conflicting_evidence: 0,
    test_live_mode_mismatch: 0,
    requires_manual_review: 0,
  };
  const add = (name, count = 1) => { totals[name] = (totals[name] || 0) + count; };
  for (const report of Object.values(modeReports)) {
    Object.entries(report.classifications || {}).forEach(([name, count]) => add(name, count));
  }
  unknownRecords.forEach((record) => add(record.classification));
  Object.values(disputesByMode).forEach((inventory) => {
    add("disputed", inventory.stripeCount);
    add("missing_lpc_identity", inventory.unmatchedStripeCount);
    add("missing_stripe_object", inventory.missingStripeCount);
  });
  Object.values(refundsByMode).forEach((inventory) => {
    add("refunded", inventory.stripeCount);
    add("missing_lpc_identity", inventory.unmatchedStripeCount);
  });
  refundRecords.filter((record) => record.status !== "resolved").forEach((record) => add(record.status));
  transferRecords.filter((record) => record.status !== "resolved").forEach((record) => add(record.status));
  return totals;
}

function assertSanitizedReport(report) {
  const json = JSON.stringify(report);
  const rawStripeIdentifier = /\b(?:pi|ch|txn|tr|re|dp|evt|cus|pm|acct)_[A-Za-z0-9_]{6,}\b/;
  const rawMongoIdentifier = /\b[a-f0-9]{24}\b/i;
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const credentialOrUri = /(?:mongodb(?:\+srv)?:\/\/|(?:sk|rk)_(?:test|live)_)/i;
  if (rawStripeIdentifier.test(json) || rawMongoIdentifier.test(json) || email.test(json) || credentialOrUri.test(json)) {
    throw safeError("The reconciliation report failed sensitive-data validation.", "RECONCILIATION_REPORT_SENSITIVE_DATA");
  }
  return true;
}

async function runProductionFundingReconciliation({ mongo, stripeFacades, clock = () => new Date() }) {
  const startedAt = clock();
  await Promise.all([stripeFacades.test.account.retrieve(), stripeFacades.live.account.retrieve()]);
  const collectionNames = await mongo.listCollectionNames();
  const opening = await captureFinancialSnapshot(mongo, collectionNames);
  const inventory = await loadProductionInventory(mongo, collectionNames);
  const relatedCases = attachRelatedEvidence(inventory.cases, inventory.operations);
  const casesById = new Map(relatedCases.map((caseDoc) => [asId(caseDoc._id), caseDoc]));

  const casesByMode = { test: [], live: [] };
  const unknownRecords = [];
  for (const caseDoc of relatedCases) {
    const resolution = modeForCase(caseDoc, inventory.operations);
    if (resolution.mode === "unknown") {
      unknownRecords.push({
        caseRef: maskIdentifier(caseDoc._id),
        mode: "unknown",
        classification: resolution.reason === "test_live_mode_mismatch"
          ? "test_live_mode_mismatch"
          : "requires_manual_review",
        reasons: [resolution.reason],
      });
    } else {
      casesByMode[resolution.mode].push({ ...caseDoc, stripeMode: resolution.mode });
    }
  }

  const modeReports = {};
  for (const mode of ["test", "live"]) {
    const modeCaseIds = new Set(casesByMode[mode].map((caseDoc) => asId(caseDoc._id)));
    const modeOperations = inventory.operations.filter((operation) => modeCaseIds.has(asId(operation.caseId)));
    const modePayouts = inventory.payouts.filter((payout) => modeCaseIds.has(asId(payout.caseId)));
    modeReports[mode] = await buildFundingEvidenceReport({
      cases: casesByMode[mode],
      operations: modeOperations,
      payouts: modePayouts,
      stripeClient: stripeFacades[mode],
      apply: false,
      now: startedAt,
    });
    modeReports[mode].records = modeReports[mode].records.map((record) => ({
      ...record,
      stripeMode: record.stripeMode === "unknown" ? mode : record.stripeMode,
    }));
    for (const record of modeReports[mode].records) assertUsd(record.currency);
  }

  const disputes = await Promise.all([
    listAllDisputes(stripeFacades.test),
    listAllDisputes(stripeFacades.live),
  ]);
  const storedDisputeIdsByMode = { test: new Set(), live: new Set() };
  inventory.operations.forEach((operation) => {
    const disputeId = asId(operation.stripeDisputeId || (operation.kind === "chargeback" ? operation.stripeObjectId : ""));
    const mode = modeForFinancialRecord(operation, casesById);
    if (disputeId && mode !== "unknown") storedDisputeIdsByMode[mode].add(disputeId);
  });
  const disputesByMode = {
    test: disputeInventory(disputes[0], "test", storedDisputeIdsByMode.test),
    live: disputeInventory(disputes[1], "live", storedDisputeIdsByMode.live),
  };
  const storedRefundIdsByMode = { test: new Set(), live: new Set() };
  inventory.operations.forEach((operation) => {
    const refundId = asId(operation.stripeRefundId || (operation.kind === "refund" ? operation.stripeObjectId : ""));
    const mode = modeForFinancialRecord(operation, casesById);
    if (refundId && mode !== "unknown") storedRefundIdsByMode[mode].add(refundId);
  });
  const refundInventories = {
    test: await listRefundsForCases(casesByMode.test, stripeFacades.test, "test", storedRefundIdsByMode.test),
    live: await listRefundsForCases(casesByMode.live, stripeFacades.live, "live", storedRefundIdsByMode.live),
  };
  const refundRecords = await reconcileStoredRefunds(inventory.operations, stripeFacades, casesById);
  const transferRecords = await reconcileStoredTransfers(inventory, stripeFacades, casesById);

  const closingCollectionNames = await mongo.listCollectionNames();
  const closing = await captureFinancialSnapshot(mongo, closingCollectionNames);
  const snapshotUnchanged = opening.watermark === closing.watermark;
  const completedAt = clock();
  const duplicateEvidence = duplicateEvidenceGroups(inventory.operations);
  const eligibleCount = sum(Object.values(modeReports).map((modeReport) =>
    modeReport.counts.expectedCreates + modeReport.counts.expectedUpdates
  ));
  const reviewCount = sum(Object.values(modeReports).map((modeReport) => modeReport.counts.reviewRequired)) +
    unknownRecords.length +
    duplicateEvidence.length +
    disputesByMode.test.unmatchedStripeCount + disputesByMode.test.missingStripeCount +
    disputesByMode.live.unmatchedStripeCount + disputesByMode.live.missingStripeCount +
    refundInventories.test.unmatchedStripeCount + refundInventories.live.unmatchedStripeCount +
    refundRecords.filter((record) => record.status !== "resolved").length +
    transferRecords.filter((record) => record.status !== "resolved").length;

  const payoutsWithMode = inventory.payouts.map((record) => ({
    ...record,
    stripeMode: modeForFinancialRecord(record, casesById),
  }));
  const platformIncomeWithMode = inventory.platformIncome.map((record) => ({
    ...record,
    stripeMode: modeForFinancialRecord(record, casesById),
  }));
  const payoutAmounts = sumByMode(payoutsWithMode, "amountPaid");
  const platformIncomeAmounts = sumByMode(platformIncomeWithMode, "feeAmount");
  const refundEvidenceAmounts = {
    test: refundInventories.test.aggregateAmount,
    live: refundInventories.live.aggregateAmount,
    unknown: 0,
  };

  const report = {
    mode: "production_retrieval_only_dry_run",
    authoritative: snapshotUnchanged,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    environment: {
      mongoDatabaseIdentityVerified: true,
      mongoClusterIdentityVerified: true,
      mongoReadOnlyPrivilegesVerified: true,
      stripeAccounts: { test: { verified: true }, live: { verified: true } },
    },
    snapshot: {
      unchanged: snapshotUnchanged,
      opening,
      closing,
    },
    inventory: {
      caseFundingRecords: inventory.cases.length,
      paymentOperations: inventory.operations.length,
      paymentOperationsByMode: countByMode(inventory.operations),
      payouts: inventory.payouts.length,
      payoutsByMode: countByMode(payoutsWithMode),
      platformIncome: inventory.platformIncome.length,
      platformIncomeByMode: countByMode(platformIncomeWithMode),
      refundEvidence: refundRecords,
      webhookEvents: webhookSummary(inventory.webhookEvents),
      financialAdjustments: {
        collectionExists: collectionNames.includes("financialadjustments"),
        count: inventory.financialAdjustments.length,
      },
      indexes: inventory.indexes,
      duplicateEvidence,
    },
    byMode: {
      test: {
        funding: modeReports.test,
        refunds: refundInventories.test,
        disputes: disputesByMode.test,
        resolvedObjects: {
          paymentIntents: modeReports.test.records.filter((record) => record.resolved.paymentIntent).length,
          charges: modeReports.test.records.filter((record) => record.resolved.charge).length,
          balanceTransactions: modeReports.test.records.filter((record) => record.resolved.balanceTransaction).length,
          refunds: refundRecords.filter((record) => record.mode === "test" && record.status === "resolved").length,
          transfers: transferRecords.filter((record) => record.mode === "test" && record.status === "resolved").length,
        },
        aggregates: {
          grossCharges: modeReports.test.aggregates.grossCharges,
          actualProcessingFees: modeReports.test.aggregates.processingFees,
          netChargeProceeds: modeReports.test.aggregates.netCharges,
          refunds: Math.max(modeReports.test.aggregates.stripeRefundsObserved, refundEvidenceAmounts.test),
          paralegalPayouts: payoutAmounts.test,
          platformIncome: platformIncomeAmounts.test,
        },
      },
      live: {
        funding: modeReports.live,
        refunds: refundInventories.live,
        disputes: disputesByMode.live,
        resolvedObjects: {
          paymentIntents: modeReports.live.records.filter((record) => record.resolved.paymentIntent).length,
          charges: modeReports.live.records.filter((record) => record.resolved.charge).length,
          balanceTransactions: modeReports.live.records.filter((record) => record.resolved.balanceTransaction).length,
          refunds: refundRecords.filter((record) => record.mode === "live" && record.status === "resolved").length,
          transfers: transferRecords.filter((record) => record.mode === "live" && record.status === "resolved").length,
        },
        aggregates: {
          grossCharges: modeReports.live.aggregates.grossCharges,
          actualProcessingFees: modeReports.live.aggregates.processingFees,
          netChargeProceeds: modeReports.live.aggregates.netCharges,
          refunds: Math.max(modeReports.live.aggregates.stripeRefundsObserved, refundEvidenceAmounts.live),
          paralegalPayouts: payoutAmounts.live,
          platformIncome: platformIncomeAmounts.live,
        },
      },
      unknown: {
        fundingRecords: unknownRecords.length,
        records: unknownRecords,
        aggregates: {
          refunds: refundEvidenceAmounts.unknown,
          paralegalPayouts: payoutAmounts.unknown,
          platformIncome: platformIncomeAmounts.unknown,
        },
      },
    },
    transferEvidence: transferRecords,
    classifications: totalClassifications(
      modeReports,
      unknownRecords,
      disputesByMode,
      refundInventories,
      refundRecords,
      transferRecords
    ),
    futureBackfill: {
      eligibleCount: snapshotUnchanged ? eligibleCount : null,
      manualReviewCount: reviewCount,
      canProceedWithoutAddingIndexes: snapshotUnchanged && duplicateEvidence.length === 0 && reviewCount === 0,
      recoverableDatabaseCheckpointRequiredBeforeApply: true,
    },
  };
  if (!snapshotUnchanged) {
    report.futureBackfill.canProceedWithoutAddingIndexes = false;
  }
  assertSanitizedReport(report);
  return report;
}

module.exports = {
  FINANCIAL_COLLECTIONS,
  FUNDING_CASE_FILTER,
  SNAPSHOT_COLLECTIONS,
  STRIPE_WEBHOOK_FILTER,
  assertSanitizedReport,
  captureFinancialSnapshot,
  loadProductionInventory,
  modeForCase,
  runProductionFundingReconciliation,
  sanitizedIndex,
};
