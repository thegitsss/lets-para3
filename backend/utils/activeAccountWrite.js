const { reportOperationalFailure } = require("./operationalFailure");
const mongoose = require("mongoose");
const User = require("../models/User");

function accountChanged() {
  return Object.assign(new Error("This account is no longer available. Sign in again before continuing."), {
    status: 403, statusCode: 403, publicCode: "ACCOUNT_CHANGED", code: "ACCOUNT_CHANGED",
  });
}

// Fresh participation and account closure must write the same User document.
// A read-only status check cannot arbitrate an already authenticated request.
async function lockActiveAccounts(userIds, session, { authVersion, ownerId, requireApproved = true } = {}) {
  if (!session?.inTransaction()) throw new Error("An active-account write requires a transaction");
  const ids = [...new Set(userIds.filter(Boolean).map(value => String(value?.toHexString?.() || value?._id || value?.id || value)))].sort();
  function activeFilter(id) {
    if (!mongoose.isObjectIdOrHexString(id)) throw accountChanged();
    const filter = { _id: new mongoose.Types.ObjectId(id), ...(requireApproved ? { status: "approved" } : {}), disabled: { $ne: true }, deleted: { $ne: true } };
    if (authVersion !== undefined && String(ownerId) === id) {
      const value = Number(authVersion);
      if (!Number.isSafeInteger(value) || value < 0) throw accountChanged();
      if (value === 0) filter.$or = [{ authVersion: 0 }, { authVersion: { $exists: false } }];
      else filter.authVersion = value;
    }
    return filter;
  }
  for (const id of ids) {
    const filter = activeFilter(id);
    const result = await User.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      if (ownerId && String(ownerId) !== id) {
        // Keep deterministic lock ordering, while giving initiating-account
        // loss precedence when both parties are unavailable in this snapshot.
        if (!await User.collection.findOne(activeFilter(String(ownerId)), { session, projection: { _id: 1 } })) throw accountChanged();
        throw Object.assign(new Error("A participant's account changed. Review the current Matter before continuing."), { status: 409, statusCode: 409, publicCode: "ACCOUNT_PARTICIPANT_CHANGED", code: "ACCOUNT_PARTICIPANT_CHANGED" });
      }
      throw accountChanged();
    }
  }
}

async function withActiveAccountWrite(userIds, work, options) {
  const session = await mongoose.startSession();
  let result;
  try {
    session.startTransaction();
    await lockActiveAccounts(userIds, session, options);
    result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("utils.activeAccountWrite.transaction_abort"));
    if (error?.hasErrorLabel?.("UnknownTransactionCommitResult")) throw Object.assign(new Error("The result could not be confirmed. Check the current state before trying again."), { status: 503, statusCode: 503, publicCode: "ACCOUNT_WRITE_UNCONFIRMED" });
    if (error?.code === 112 || error?.hasErrorLabel?.("TransientTransactionError")) throw Object.assign(new Error("The account or Matter changed. Review the current state before trying again."), { status: 409, statusCode: 409, publicCode: "ACCOUNT_WRITE_CHANGED" });
    throw error;
  } finally {
    result?.$session?.(null);
    result?.caseDoc?.$session?.(null);
    await session.endSession();
  }
}

module.exports = { lockActiveAccounts, withActiveAccountWrite, accountChanged };
