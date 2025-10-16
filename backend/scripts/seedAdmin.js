// backend/utils/audit.js
// Lightweight helpers to write structured audit logs consistently.

const AuditLog = require("../models/AuditLogs"); // match your filename

/**
 * Pull a stable actor id/role from the request (works with your verifyToken).
 */
function getActorFromReq(req) {
  const actor = req?.user?.id || req?.user?._id || null;
  const actorRole = req?.user?.role || (actor ? "user" : "system");
  return { actor, actorRole };
}

/**
 * Small meta sanitizer to avoid huge blobs and secrets.
 * - flattens JSON-able values
 * - drops keys that look like secrets/tokens
 * - caps total serialized size
 */
function sanitizeMeta(metaIn) {
  const MAX = 8 * 1024; // 8KB cap
  const SECRET_RX = /(secret|password|token|authorization|cookie|set-cookie|apikey|api_key)/i;

  if (!metaIn || typeof metaIn !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(metaIn)) {
    if (SECRET_RX.test(k)) continue;
    try {
      // Keep primitives and JSON-safe objects/arrays
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
        out[k] = v;
      } else if (Array.isArray(v) || typeof v === "object") {
        // shallow clone only
        out[k] = JSON.parse(JSON.stringify(v));
      }
    } catch {
      // ignore unserializable values
    }
  }
  // Size cap (approx)
  let str = "";
  try { str = JSON.stringify(out) } catch { return {}; }
  if (str.length > MAX) {
    // crude truncation
    const ratio = MAX / str.length;
    const trimmed = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === "string") trimmed[k] = v.slice(0, Math.max(16, Math.floor(v.length * ratio)));
      else trimmed[k] = v;
    }
    return trimmed;
  }
  return out;
}

/**
 * Core write. Safe: will never throw (returns null on failure).
 *
 * @param {object} req - Express request (for actor/ip/ua/method/path)
 * @param {string} action - e.g. "case.create", "payment.intent.create"
 * @param {object} [opts]
 *   - targetType?: "user"|"case"|"message"|"payment"|"dispute"|"document"|"other"
 *   - targetId?: string|ObjectId
 *   - caseId?: string|ObjectId
 *   - meta?: object
 */
async function logAction(req, action, opts = {}) {
  try {
    if (process.env.AUDIT_DISABLED === "true") return null;

    const { actor, actorRole } = getActorFromReq(req);
    const { targetType = "other", targetId, caseId, meta } = opts;

    const doc = {
      actor,
      actorRole: actorRole || "system",
      action,
      targetType,
      targetId: targetId || undefined,
      case: caseId || undefined,
      ip: req?.ip,
      ua: req?.headers?.["user-agent"],
      method: req?.method,
      path: req?.originalUrl,
      meta: sanitizeMeta(meta || {}),
    };

    return await AuditLog.create(doc);
  } catch (err) {
    // Never block the user flow because auditing failed
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[audit] failed to write log:", err?.message || err);
    }
    return null;
  }
}

/**
 * Convenience: wrap an async route handler to automatically log on success/failure.
 * Usage:
 *   router.post('/x', auditRoute('thing.create', (req, res) => {...}))
 */
function auditRoute(action, handler, { onSuccessMeta, onErrorMeta } = {}) {
  return async (req, res, next) => {
    try {
      const result = await handler(req, res, next);
      // Best-effort success log
      try {
        await logAction(req, action, {
          meta: typeof onSuccessMeta === "function" ? onSuccessMeta(req, result) : onSuccessMeta,
        });
      } catch {}
      return result;
    } catch (err) {
      // Best-effort error log (don’t swallow the error)
      try {
        await logAction(req, `${action}.error`, {
          meta: {
            ...(typeof onErrorMeta === "function" ? onErrorMeta(req, err) : onErrorMeta),
            message: err?.message,
          },
        });
      } catch {}
      return next(err);
    }
  };
}

/**
 * Attaches a convenience `req.audit(action, opts)` method for downstream handlers.
 * Mount once: `app.use(auditMiddleware())`
 */
function auditMiddleware() {
  return (req, _res, next) => {
    req.audit = (action, opts) => logAction(req, action, opts);
    next();
  };
}

module.exports = {
  logAction,
  auditRoute,
  auditMiddleware,
  sanitizeMeta,   // exported for tests
  getActorFromReq // exported for tests
};
