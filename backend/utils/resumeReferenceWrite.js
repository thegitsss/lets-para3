const { reportOperationalFailure } = require("./operationalFailure");
const mongoose = require("mongoose");
const User = require("../models/User");
const { captureFilter } = require("./accountWriteGuard");
const { accountChanged } = require("./activeAccountWrite");

function conflict() {
  const error = new Error("Your résumé changed. Review your current profile before submitting again.");
  error.status = 409;
  error.publicCode = "RESUME_CHANGED";
  return error;
}

// Capture before any asynchronous eligibility/provider work. Preserve a missing
// stored field separately from a Mongoose default, null, or an empty string.
function captureResumeReference(user) {
  if (!user) throw conflict();
  const { _id, $and } = captureFilter(user, ["resumeURL"]);
  return { _id, $and };
}

async function withResumeReferenceWrite(filter, write) {
  if (!filter?._id || !Array.isArray(filter.$and)) throw conflict();
  const session = await mongoose.startSession();
  let result;
  try {
    session.startTransaction();
    // A real write, not a no-op: replacement/removal must serialize against this
    // User document until the retained Application/Case reference commits.
    const locked = await User.collection.updateOne({ ...filter, status: "approved", disabled: { $ne: true }, deleted: { $ne: true } }, { $inc: { __v: 1 } }, { session });
    if (locked.matchedCount !== 1 || locked.modifiedCount !== 1) {
      const current = await User.findById(filter._id).select("status disabled deleted").session(session).lean();
      if (!current || current.status !== "approved" || current.disabled || current.deleted) throw accountChanged();
      throw conflict();
    }
    result = await write(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("utils.resumeReferenceWrite.transaction_abort"));
    // Do not retry a mutable application document or an uncertain submission.
    if (error?.hasErrorLabel?.("UnknownTransactionCommitResult")) {
      const unconfirmed = new Error("Submission could not be confirmed. Check your applications before trying again.");
      unconfirmed.status = 503;
      unconfirmed.publicCode = "APPLICATION_SUBMISSION_UNCONFIRMED";
      throw unconfirmed;
    }
    if (error?.code === 112 || error?.hasErrorLabel?.("TransientTransactionError")) throw conflict();
    throw error;
  } finally {
    result?.$session?.(null);
    await session.endSession();
  }
}

module.exports = { captureResumeReference, withResumeReferenceWrite };
