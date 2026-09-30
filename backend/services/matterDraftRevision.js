const crypto = require("crypto");
const fields = ["title", "practiceArea", "state", "compAmount", "experience", "deadline", "description", "tasks", "requirements", "sourceDescription", "appliedSourceDescription", "pendingRequirement", "status"];
const fingerprint = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revisionFor = (doc) => fingerprint([String(doc._id), String(doc.owner), doc.__v ?? null, doc.updatedAt || null, fields.map((key) => doc[key])]);
const requestIdValid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function snapshotFilter(doc) {
  const exact = (value) => value === undefined ? { $exists: false } : value;
  return { _id: doc._id, owner: doc.owner, __v: exact(doc.__v), updatedAt: exact(doc.updatedAt), ...Object.fromEntries(fields.map((key) => [key, exact(doc[key])])) };
}
module.exports = { fingerprint, revisionFor, requestIdValid, snapshotFilter };
