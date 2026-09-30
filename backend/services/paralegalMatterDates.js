const mongoose = require("mongoose");
const Case = require("../models/Case");
const account = require("./financialAccountBoundary");
const { caseParticipantIdentity } = require("../utils/caseParticipantIdentity");
const { normalizeCaseStatus } = require("../utils/caseState");
const { lockActiveAccounts } = require("../utils/activeAccountWrite");
const { createMatterCalendar } = require("./matterCalendar");
const { exact, matterFields, matterRevision } = require("./attorneyMatterFiles");

const fail = (status, suffix) => { throw Object.assign(new Error("Private reminders are no longer available for this Matter."), { status, publicCode: `WORKSPACE_DATE_${suffix}` }); };
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);

async function actor(req) {
  const expected = req.method === "GET" ? req.query?.expectedOwnerId : req.body?.expectedOwnerId;
  if (!validId(expected)) fail(403, "ACCOUNT_CHANGED");
  return account.read(req, "paralegal", expected);
}

async function matter(req, session) {
  const user = await actor(req);
  if (!validId(req.params.caseId)) fail(400, "INVALID");
  const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) }, { session });
  if (!doc) fail(404, "NOT_FOUND");
  const identity = caseParticipantIdentity(doc, String(user._id));
  if (identity.identityConflict) fail(409, "MATTER_CHANGED");
  if (!identity.isParalegal || doc.paralegalAccessRevokedAt || doc.purgedAt || doc.paymentReleased || ["completed", "closed", "cancelled", "canceled", "expired"].includes(normalizeCaseStatus(doc.status))) fail(403, "RESTRICTED");
  if (req.method !== "GET" && (doc.readOnly || doc.archived || doc.completionClaimStatus || doc.completionClaimToken || doc.hiringClaimStatus || doc.hiringClaimToken)) fail(409, "MATTER_CHANGED");
  return doc;
}

async function lock(req, session) {
  await lockActiveAccounts([req.user.id], session, { ownerId: req.user.id, authVersion: Number(req.auth?.payload?.av || 0) });
}

function validateInput({ action, values }) {
  if (!["create", "update", "delete"].includes(action)) fail(400, "INVALID");
  if (Object.keys(values).some(key => !["title", "start", "end", "isAllDay", "timezone", "type"].includes(key))) fail(400, "INVALID");
  if (values.type !== undefined && values.type !== "deadline") fail(400, "INVALID");
  if (action === "create" && (values.type !== "deadline" || values.isAllDay !== true)) fail(400, "INVALID");
}

module.exports = createMatterCalendar({
  access: { actor, matter, lock, exact, matterFields, matterRevision },
  role: "paralegal",
  kind: "paralegal_calendar_action",
  eventType: "deadline",
  validateInput,
});
