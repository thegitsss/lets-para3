const { Types } = require("mongoose");
const User = require("../models/User");
const { findActiveSession } = require("./authSessionService");
const valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const fail = () => { throw Object.assign(new Error("The attorney account could not be verified."), { status: 403, publicCode: "PAYMENT_SETUP_ACCOUNT_CHANGED" }); };
async function read(req, expectedOwnerId, extraFields = []) {
  const ownerId = String(req.user?.id || "");
  if (!valid(ownerId) || expectedOwnerId !== ownerId || req.user?.role !== "attorney") fail();
  const projection = Object.fromEntries(["role", "status", "disabled", "deleted", "authVersion", ...extraFields].map(key => [key, 1]));
  const user = await User.collection.findOne({ _id: new Types.ObjectId(ownerId) }, { projection });
  if (!user || user.role !== "attorney" || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, ownerId)) fail();
  return user;
}
module.exports = { read };
