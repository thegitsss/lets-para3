// backend/middleware/ensureCaseParticipant.js
const mongoose = require("mongoose");
const Case = require("../models/Case");
const { caseParticipantIdentity, conflictMessage } = require("../utils/caseParticipantIdentity");

const isObjId = (value) => mongoose.Types.ObjectId.isValid(value);

async function evaluateCaseParticipant(req, caseId) {
  if (!caseId || !isObjId(caseId)) {
    const err = new Error("Case id required");
    err.statusCode = 400;
    throw err;
  }
  if (!req.user) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }

  const caseDoc = await Case.findById(caseId).select(
    "_id title status escrowStatus escrowIntentId paymentReleased attorney attorneyId paralegal paralegalId paralegalAccessRevokedAt withdrawnParalegalId withdrawalHistory pendingParalegalId invites readOnly tasksLocked hiredAt"
  );
  if (!caseDoc) {
    const err = new Error("Case not found");
    err.statusCode = 404;
    throw err;
  }

  const role = String(req.user.role || "").toLowerCase();
  const uid = String(req.user._id || req.user.id || "");

  if (role === "admin") {
    return { caseDoc, acl: { isAdmin: true, isAttorney: false, isParalegal: false } };
  }

  const { isAttorney, isParalegal, identityConflict } = caseParticipantIdentity(caseDoc, uid);
  const baseUrl = String(req.baseUrl || "");
  const path = String(req.path || "");
  const allowFinalizedParalegalReceipt =
    isParalegal &&
    caseDoc.paralegalAccessRevokedAt &&
    baseUrl.includes("/payments") &&
    path.includes("/receipt/paralegal");
  if (isParalegal && caseDoc.paralegalAccessRevokedAt && !allowFinalizedParalegalReceipt) {
    const err = new Error("Access denied");
    err.statusCode = 403;
    throw err;
  }
  if (identityConflict) {
    throw Object.assign(new Error(conflictMessage), { statusCode: 409, publicCode: "CASE_IDENTITY_CONFLICT" });
  }
  const isWithdrawnParalegal =
    caseDoc.withdrawnParalegalId && String(caseDoc.withdrawnParalegalId) === uid;
  const isHistoricalReceiptOwner = req.method === "GET" && baseUrl === "/api/payments" &&
    /^\/receipt\/paralegal\/[a-f0-9]{24}$/i.test(path) &&
    (caseDoc.withdrawalHistory || []).some((entry) => String(entry.withdrawnParalegalId) === uid);
  const isPendingParalegal =
    (caseDoc.pendingParalegalId && String(caseDoc.pendingParalegalId) === uid) ||
    (Array.isArray(caseDoc.invites) &&
      caseDoc.invites.some(
        (invite) =>
          invite?.paralegalId &&
          String(invite.paralegalId) === uid &&
          String(invite.status || "pending").toLowerCase() === "pending"
      ));

  if (!isAttorney && !isParalegal) {
    const allowWithdrawn =
      (isWithdrawnParalegal || isHistoricalReceiptOwner) &&
      (baseUrl.includes("/disputes") ||
        (baseUrl.includes("/payments") && path.includes("/receipt/paralegal")));
    if (allowWithdrawn) {
      return {
        caseDoc,
        acl: { isAdmin: false, isAttorney: false, isParalegal: false, isPendingParalegal: false, isWithdrawnParalegal: true },
      };
    }
    if (isPendingParalegal && String(req.method || "").toUpperCase() === "GET") {
      return {
        caseDoc,
        acl: { isAdmin: false, isAttorney: false, isParalegal: false, isPendingParalegal: true },
      };
    }
    const err = new Error("Access denied");
    err.statusCode = 403;
    throw err;
  }

  return {
    caseDoc,
    acl: { isAdmin: false, isAttorney, isParalegal, isPendingParalegal },
  };
}

/**
 * Verifies the authenticated user is either the attorney or paralegal on the
 * target case (admins are always allowed). Rejects when the case cannot be
 * located or does not belong to the requester.
 *
 * @param {string} paramKey - location of the case id (defaults to "caseId").
 */
function ensureCaseParticipant(paramKey = "caseId") {
  return async (req, res, next) => {
    try {
      const caseId =
        req.params?.[paramKey] || req.body?.[paramKey] || req.query?.[paramKey];
      const { caseDoc, acl } = await evaluateCaseParticipant(req, caseId);
      req.case = caseDoc;
      req.acl = Object.assign({}, req.acl, acl);
      return next();
    } catch (err) {
      if (err.statusCode) {
        if (err.publicCode) res.set("Cache-Control", "private, no-store");
        return res.status(err.statusCode).json({ ...(err.publicCode ? { code: err.publicCode } : {}), error: err.message });
      }
      return next(err);
    }
  };
}

async function assertCaseParticipant(req, caseId) {
  return evaluateCaseParticipant(req, caseId);
}

module.exports = ensureCaseParticipant;
module.exports.assertCaseParticipant = assertCaseParticipant;
