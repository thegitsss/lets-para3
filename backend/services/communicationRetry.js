const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const { fingerprint } = require("./matterDraftRevision");

function revision(record) {
  return fingerprint([String(record._id), record.status, record.attempts, record.claim || "", record.updatedAt]);
}

async function retry(req, Model, kind) {
  const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
  if (!/^[a-f0-9]{24}$/i.test(req.params.id || "")) fail(400, "Invalid email notice.");
  if (req.body?.confirmed !== true) fail(400, "Check the mail provider's delivery record before retrying.");
  if (!/^[a-f0-9]{64}$/.test(req.body?.revision || "")) fail(400, "Refresh this notice before retrying.");
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const record = await Model.findById(req.params.id).session(session).lean();
      if (!record || !["failed", "unknown", "disabled"].includes(record.status) || revision(record) !== req.body.revision) {
        fail(409, "This notice has changed. Refresh its status.");
      }
      await Model.updateOne({ _id: record._id }, { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), failure: "" } }, { session });
      await AuditLog.logFromReq(req, "admin.communication.retry_requested", {
        targetType: "other", targetId: record._id, meta: { kind, previousStatus: record.status }, session,
      });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    return { ok: true };
  } finally { await session.endSession(); }
}

module.exports = { revision, retry };
