const crypto = require("crypto");
const Case = require("../models/Case");

function buildFundingFingerprint({ caseId, amount, currency = "usd", mode = "escrow" }) {
  return [mode, String(caseId || ""), String(amount || 0), String(currency || "usd").toLowerCase()].join(":");
}

async function ensureFundingRequestKey(caseId, fingerprint, { forceNew = false } = {}) {
  if (!caseId) return crypto.randomUUID();

  if (forceNew) {
    const key = crypto.randomUUID();
    await Case.updateOne(
      { _id: caseId },
      { $set: { fundingRequestKey: key, fundingRequestFingerprint: fingerprint } }
    );
    return key;
  }

  const current = await Case.findById(caseId)
    .select("fundingRequestKey fundingRequestFingerprint")
    .lean();
  if (current?.fundingRequestKey && current.fundingRequestFingerprint === fingerprint) {
    return current.fundingRequestKey;
  }

  const nextKey = crypto.randomUUID();
  const claimed = await Case.findOneAndUpdate(
    {
      _id: caseId,
      $or: [
        { fundingRequestKey: { $exists: false } },
        { fundingRequestKey: "" },
        { fundingRequestFingerprint: { $ne: fingerprint } },
      ],
    },
    {
      $set: {
        fundingRequestKey: nextKey,
        fundingRequestFingerprint: fingerprint,
      },
    },
    {
      new: true,
      projection: { fundingRequestKey: 1 },
    }
  ).lean();

  if (claimed?.fundingRequestKey) return claimed.fundingRequestKey;

  const refreshed = await Case.findById(caseId).select("fundingRequestKey").lean();
  return refreshed?.fundingRequestKey || nextKey;
}

module.exports = {
  buildFundingFingerprint,
  ensureFundingRequestKey,
};
