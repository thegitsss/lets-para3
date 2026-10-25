const { Types } = require("mongoose");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const { withActiveAccountWrite, accountChanged } = require("../utils/activeAccountWrite");

class NoteWriteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.publicCode = code; }
}

async function withWrite(req, policy, work) {
  const ownerId = String(req.user?.id || "");
  if (!/^[a-f0-9]{24}$/i.test(ownerId)) throw accountChanged();
  if (policy !== "case" && policy !== "weekly") throw new Error("Unknown private note policy");
  const owner = new Types.ObjectId(ownerId), authVersion = Number(req.authVersion ?? req.auth?.payload?.av ?? 0);
  return withActiveAccountWrite([ownerId], async (session) => {
    // Approval is checked after locking the actual actor. The existing weekly
    // API permits an active Admin whose status is pending; other roles must be
    // approved. Case notes retain approved Attorney/Admin access only.
    const actor = await User.collection.findOne({ _id: owner }, { session, projection: { _id: 1, role: 1, status: 1 } });
    const approved = String(actor?.status || "").toLowerCase() === "approved";
    const allowed = policy === "case"
      ? approved && (actor?.role === "attorney" || actor?.role === "admin")
      : String(actor?.role || "").toLowerCase() === "admin" || approved;
    if (!allowed) throw accountChanged();
    const activeSession = () => ({ sessionId: req.authSessionId, userId: owner, revokedAt: null, expiresAt: { $gt: new Date() } });
    if (req.authSessionId) {
      const locked = await AuthSession.collection.updateOne(activeSession(), { $inc: { __v: 1 } }, { session });
      if (locked.matchedCount !== 1 || locked.modifiedCount !== 1) throw accountChanged();
    }
    const result = await work(session, actor);
    // Keep the managed-session expiry check current after the data operation.
    // Independent revocation/ownership changes arbitrate on the locked SID.
    if (req.authSessionId && !await AuthSession.collection.findOne(activeSession(), { session, projection: { _id: 1 } })) throw accountChanged();
    return result;
  }, { ownerId, authVersion, requireApproved: false });
}

function respond(error, res, { conflictCode, conflictMessage } = {}) {
  const known = error instanceof NoteWriteError || ["ACCOUNT_CHANGED", "ACCOUNT_WRITE_CHANGED", "ACCOUNT_WRITE_UNCONFIRMED"].includes(error?.publicCode);
  if (!known) return false;
  res.set("Cache-Control", "no-store");
  const changed = error.publicCode === "ACCOUNT_WRITE_CHANGED" && conflictCode;
  res.status(error.status || error.statusCode || 503).json({ error: changed ? conflictMessage : error.message, ...(error.publicCode ? { code: changed ? conflictCode : error.publicCode } : {}) });
  return true;
}

module.exports = { NoteWriteError, withWrite, respond };
