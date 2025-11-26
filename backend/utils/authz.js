// backend/utils/authz.js
const { Types } = require("mongoose");
const Case = require("../models/Case");

/**
 * Tiny helpers you can reuse elsewhere
 */
const isObjId = (v) => Types.ObjectId.isValid(v);
const toId = (v) => (v ? String(v) : "");
const sameId = (a, b) => toId(a) === toId(b);

/**
 * requireRole("admin"), requireRole("attorney","admin"), etc.
 * Sends 401 if unauthenticated, 403 if authenticated but lacks role.
 */
function requireRole(...roles) {
  const roleSet = new Set(roles.map(String));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roleSet.has(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

/**
 * requireSelfOrAdmin("userId")
 * Looks in params/body/query for the id key (default: userId).
 * Sends 401 if unauthenticated, 400 if missing target id, 403 if not self/admin.
 */
function requireSelfOrAdmin(paramKey = "userId") {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const targetId = req.params?.[paramKey] || req.body?.[paramKey] || req.query?.[paramKey];
    if (!targetId) return res.status(400).json({ error: "Missing target id" });
    if (req.user.role === "admin" || sameId(targetId, req.user.id)) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
}

/**
 * requireCaseAccess("caseId", opts?)
 *
 * Default policy: allow if user is admin OR case.attorney OR case.paralegal.
 *
 * Options:
 *  - hideExistence (bool, default true):
 *      Return 404 instead of 403 when forbidden to prevent ID probing.
 *  - alsoAllow (fn(req, caseDoc) -> bool|Promise<bool>):
 *      Additional custom predicate.
 *  - allowApplicants (bool|{ statuses?: string[] }):
 *      If true, allow a paralegal who has applied to the case. You may restrict by statuses (default: any).
 *  - project (string or object):
 *      Additional mongoose select/projection to include on the fetched case (merged with required fields).
 *
 * Behavior:
 *  - Attaches the found case document to req.case for downstream handlers.
 *  - Populates req.acl with helpful flags: { isAdmin, isAttorney, isParalegal, isApplicant }
 */
function requireCaseAccess(paramKey = "caseId", opts = {}) {
  const {
    hideExistence = true,
    alsoAllow,
    allowApplicants = false,
    project,
  } = opts;

  // Normalize applicant options
  const applicantStatuses =
    typeof allowApplicants === "object" && Array.isArray(allowApplicants.statuses)
      ? new Set(allowApplicants.statuses.map(String))
      : null;
  const checkApplicants = !!allowApplicants;

  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const rawId = req.params?.[paramKey] || req.body?.[paramKey] || req.query?.[paramKey];
      if (!rawId || !isObjId(rawId)) {
        return res.status(400).json({ error: "Invalid case id" });
      }

      // Build a minimal projection; add applicants only if needed
      // Always include attorney/paralegal to evaluate access quickly.
      let select = "_id attorney paralegal status readOnly paralegalAccessRevokedAt";
      if (checkApplicants) select += " applicants";
      if (project) {
        // Allow caller to ask for more fields (e.g., "status title")
        // Be careful not to drop mandatory fields
        if (typeof project === "string") select += " " + project;
        else if (project && typeof project === "object") {
          // Convert object projection to string (only for inclusion keys)
          const includeKeys = Object.entries(project)
            .filter(([, v]) => v)
            .map(([k]) => k);
          if (includeKeys.length) select += " " + includeKeys.join(" ");
        }
      }

      const c = await Case.findById(rawId).select(select);
      if (!c) {
        return res.status(404).json({ error: "Case not found" });
      }

      const uid = toId(req.user.id);
      const isAdmin = req.user.role === "admin";
      const isAttorney = sameId(c.attorney, uid);
      const isParalegal = sameId(c.paralegal, uid);
      const paralegalRevoked = isParalegal && !isAdmin && !!c.paralegalAccessRevokedAt;

      if (paralegalRevoked) {
        return res
          .status(hideExistence ? 404 : 403)
          .json({ error: hideExistence ? "Case not found" : "Access revoked" });
      }

      let isApplicant = false;
      if (checkApplicants && Array.isArray(c.applicants) && req.user.role === "paralegal") {
        isApplicant = c.applicants.some((a) => {
          const match = sameId(a?.paralegalId, uid);
          if (!match) return false;
          if (!applicantStatuses) return true; // any status allowed
          return a?.status && applicantStatuses.has(String(a.status));
        });
      }

      let allowed = isAdmin || isAttorney || isParalegal || isApplicant;

      if (!allowed && typeof alsoAllow === "function") {
        try {
          // User-defined extra predicate; do not throw if it fails.
          allowed = !!(await alsoAllow(req, c));
        } catch {
          // ignore errors in predicate
        }
      }

      if (!allowed) {
        return res
          .status(hideExistence ? 404 : 403)
          .json({ error: hideExistence ? "Case not found" : "Forbidden" });
      }

      // Attach convenience access flags for downstream handlers
      req.acl = Object.assign({}, req.acl, {
        isAdmin,
        isAttorney,
        isParalegal,
        isApplicant,
        caseReadOnly: !!c.readOnly,
        caseStatus: c.status || null,
      });
      req.case = c;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  requireRole,
  requireSelfOrAdmin,
  requireCaseAccess,

  // Optional helpers if you want them elsewhere
  isObjId,
  sameId,
};
