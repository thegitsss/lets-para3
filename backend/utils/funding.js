const crypto = require("crypto");
const Case = require("../models/Case");

function buildFundingFingerprint({ caseId, amount, currency = "usd", mode = "escrow", targetId } = {}) {
  const parts = [mode, String(caseId || "")];
  // Hiring keys historically bind a selected paralegal; other funding flows do not.
  // Preserve both established formats so deploys never rotate an in-flight Stripe key.
  if (targetId !== undefined) parts.push(String(targetId || ""));
  parts.push(String(amount || 0), String(currency || "usd").toLowerCase());
  return parts.join(":");
}

async function ensureFundingRequestKey(caseId, fingerprint, { forceNew = false } = {}) {
  const conflict = () => { throw Object.assign(new Error("The existing funding request must be checked before another payment is prepared."), { status: 409, publicCode: "FUNDING_REQUEST_UNRESOLVED" }); };
  if (!caseId || !fingerprint) return conflict();

  const current = await Case.findById(caseId)
    .select("fundingRequestKey fundingRequestFingerprint")
    .lean();
  if (!current) return conflict();
  if (current.fundingRequestKey && !forceNew && current.fundingRequestFingerprint === fingerprint) {
    return current.fundingRequestKey;
  }
  // A changed amount, selected paralegal or checkout surface is not evidence
  // that an earlier provider request failed. Its durable key cannot rotate.
  // Callers may clear a claim only after verifying the earlier cancellation.
  if (current.fundingRequestKey) return conflict();

  const nextKey = crypto.randomUUID();
  const claimed = await Case.findOneAndUpdate(
    {
      _id: caseId,
      $or: [
        { fundingRequestKey: { $exists: false } },
        { fundingRequestKey: "" },
        { fundingRequestKey: null },
      ],
    },
    {
      $set: {
        fundingRequestKey: nextKey,
        fundingRequestFingerprint: fingerprint,
      },
    },
    {
      returnDocument: "after",
      projection: { fundingRequestKey: 1 },
    }
  ).lean();

  if (claimed?.fundingRequestKey) return claimed.fundingRequestKey;

  const refreshed = await Case.findById(caseId).select("fundingRequestKey fundingRequestFingerprint").lean();
  if (refreshed?.fundingRequestKey && refreshed.fundingRequestFingerprint === fingerprint) return refreshed.fundingRequestKey;
  return conflict();
}

module.exports = {
  buildFundingFingerprint,
  ensureFundingRequestKey,
};
