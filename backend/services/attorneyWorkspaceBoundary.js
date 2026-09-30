const { Types } = require("mongoose");
const Case = require("../models/Case"), account = require("./attorneyAccountBoundary");
const { fingerprint } = require("./matterDraftRevision");
const fail = (status, suffix) => { throw Object.assign(new Error("Matter access could not be verified."), { status, publicCode: `WORKSPACE_${suffix}` }); };
async function snapshot(req) {
  let user;
  try { user = await account.read(req, req.query.expectedOwnerId); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; }
  const facts = await Case.collection.findOne({ _id: new Types.ObjectId(req.params.caseId) });
  if (!facts) fail(404, "NOT_FOUND");
  if (![facts.attorney, facts.attorneyId].some(ref => String(ref || "").toLowerCase() === String(user._id).toLowerCase())) fail(403, "RESTRICTED");
  return fingerprint([user, facts]);
}
async function begin(req, res) {
  if (req.query.expectedOwnerId === undefined) return null;
  res.set("Cache-Control", "private, no-store");
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  return snapshot(req);
}
async function finish(req, before) {
  if (before !== null && before !== await snapshot(req)) fail(409, "CHANGED");
}
const sendError = (res, error) => res.status(error.status || 503).json({ code: error.publicCode || "WORKSPACE_UNAVAILABLE", error: "The Matter changed or its access could not be verified. Refresh to try again." });
module.exports = { begin, finish, sendError };
