"use strict";

const SUCCESSFUL_PAYOUT_MATCH = Object.freeze({ status: "paid" });

async function getAttorneyPaymentSummary(attorneyId, options = {}) {
  const summary = { ...await require('./attorneyPaymentSummary').read(attorneyId, options) };
  delete summary.items;
  return summary;
}

async function getParalegalEarnings(paralegalId, options = {}) {
  const now = options.now || new Date(), records = await require("./retainedPayoutProjection").readDetailed(paralegalId, { ...options, now });
  // These existing dashboard fields are explicitly USD. Other currencies stay
  // separate in the retained projection and are never relabeled as dollars.
  const usd = records.currencies.find(group => group.currency === "USD");
  const report = { ownerId: String(paralegalId?._id || paralegalId), ...require('./paralegalEarningsReport').project(records, now) };
  const multipleModes = report.currencies.filter(group => group.currency === 'USD').length > 1;
  return { month: multipleModes ? null : (usd?.month || 0) / 100, last30: multipleModes ? null : (usd?.last30 || 0) / 100, total: multipleModes ? null : (usd?.total || 0) / 100, ...(options.includeReport ? { report } : {}) };
}

module.exports = {
  SUCCESSFUL_PAYOUT_MATCH,
  getAttorneyPaymentSummary,
  getParalegalEarnings,
};
