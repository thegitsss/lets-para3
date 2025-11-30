// backend/utils/audit.js
const AuditLog = require("../models/AuditLog");

/**
 * Backward-compatible wrapper around AuditLog.logFromReq.
 *
 * Usage:
 *   // old style (still works)
 *   await logAction(req, "case.create", caseId)
 *
 *   // new rich style
 *   await logAction(req, "case.create", {
 *     targetType: "case",
 *     targetId: caseId,
 *     caseId,
 *     meta: { title }
 *   })
 */
async function logAction(req, action, target) {
  try {
    if (typeof target === "string") {
      await AuditLog.logFromReq(req, action, { targetId: target });
    } else {
      await AuditLog.logFromReq(req, action, target || {});
    }
  } catch (e) {
    console.warn("[audit] logAction error:", e?.message || e);
  }
}

/**
 * System-side logging without a request object.
 * Example:
 *   await systemLog("payment.intent.succeeded", {
 *     targetType: "payment",
 *     targetId: pi.id,
 *     caseId,
 *     meta: { amount: pi.amount, currency: pi.currency }
 *   });
 */
async function systemLog(action, opts = {}) {
  try {
    await AuditLog.create({
      actor: null,
      actorRole: "system",
      action,
      targetType: opts.targetType || null,
      targetId: opts.targetId || null,
      case: opts.caseId || null,
      meta: opts.meta || undefined,
      method: opts.method || undefined,
      path: opts.path || undefined,
      ip: opts.ip || undefined,
      ua: opts.ua || undefined,
    });
  } catch (e) {
    console.warn("[audit] systemLog error:", e?.message || e);
  }
}

module.exports = { logAction, systemLog };
