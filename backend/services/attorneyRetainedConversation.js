const { Types } = require("mongoose"), Message = require("../models/Message"), User = require("../models/User");
const files = require("./attorneyMatterFiles"), exportsPolicy = require("./matterExports"), conversation = require("./attorneyConversation");
const { fingerprint } = require("./matterDraftRevision");
const { isEncrypted } = require("../utils/dataEncryption");
const valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const fail = (status, suffix) => { throw Object.assign(new Error("Retained messages are unavailable. Refresh the Matter to check its records."), { status, publicCode: `WORKSPACE_HISTORY_${suffix}` }); };
async function access(req) {
  const user = await files.actor(req), matter = await files.matter(req), policy = exportsPolicy.accessFor(matter);
  if (policy.access !== "available") fail(["expired", "purged"].includes(policy.access) ? 410 : 403, policy.access.toUpperCase());
  return { matter, retentionEndsAt: policy.retentionEndsAt, fingerprint: fingerprint([user, matter, policy]) };
}
const sortDate = { $convert: { input: "$createdAt", to: "date", onError: null, onNull: null } };
const stamp = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const cursorFor = raw => Buffer.from(JSON.stringify([stamp(raw._sortAt), String(raw._id)])).toString("base64url");
function decode(value) {
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail(400, "INVALID");
    const pair = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(pair) || pair.length !== 2 || !valid(pair[1]) || pair[0] !== null && (typeof pair[0] !== "string" || new Date(pair[0]).toISOString() !== pair[0])) fail(400, "INVALID");
    return { _sortAt: pair[0] === null ? null : new Date(pair[0]), _id: new Types.ObjectId(pair[1]) };
  } catch { fail(400, "INVALID"); }
}
function prior(target, inclusive = false) {
  const same = { _sortAt: target._sortAt, _id: { [inclusive ? "$lte" : "$lt"]: target._id } };
  return target._sortAt === null ? same : { $or: [{ _sortAt: { $lt: target._sortAt } }, { _sortAt: null }, same] };
}
async function read(req) {
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "cursor", "messageId"].includes(key)) || query.cursor && query.messageId || query.messageId !== undefined && !valid(query.messageId)) fail(400, "INVALID");
  const start = await access(req), base = { caseId: { $in: [start.matter._id, String(start.matter._id)] }, deleted: { $ne: true } };
  let targetMissing = false, boundary = query.cursor ? prior(decode(query.cursor)) : null;
  if (query.messageId) {
    const target = (await Message.collection.aggregate([{ $match: { ...base, _id: new Types.ObjectId(query.messageId) } }, { $set: { _sortAt: sortDate } }]).toArray())[0];
    if (target) boundary = prior(target, true); else targetMissing = true;
  }
  const pipeline = [{ $match: base }, { $set: { _sortAt: sortDate } }, ...(boundary ? [{ $match: boundary }] : []), { $sort: { _sortAt: -1, _id: -1 } }, { $limit: 51 }];
  const readPage = () => Message.collection.aggregate(pipeline, { allowDiskUse: true, maxTimeMS: 10000 }).toArray();
  const rows = await readPage(), page = rows.slice(0, 50), peopleIds = [...new Set(page.map(raw => String(raw.senderId || "")).filter(valid))];
  const people = await User.collection.find({ _id: { $in: peopleIds.map(id => new Types.ObjectId(id)) } }, { projection: { firstName: 1, lastName: 1, role: 1 } }).toArray();
  const names = new Map(people.map(person => [String(person._id), person]));
  const messages = page.map(raw => {
    const value = conversation.present(raw, String(req.user.id));
    if (!["text", "file", "audio", "system"].includes(value.type) || [value.text, value.transcript, value.fileName].some(value => typeof value !== "string" || isEncrypted(value))) fail(409, "SOURCE_INVALID");
    delete value.clientMessageId;
    return { ...value, senderId: names.get(String(raw.senderId)) || String(raw.senderId || ""), createdAt: stamp(raw._sortAt) };
  });
  if (fingerprint(rows) !== fingerprint(await readPage()) || start.fingerprint !== (await access(req)).fingerprint) fail(409, "CHANGED");
  return { caseId: String(start.matter._id), ownerId: String(req.user.id), messages: messages.reverse(), nextCursor: rows.length > 50 ? cursorFor(page.at(-1)) : null, targetMissing, writable: false, retained: true, retentionEndsAt: start.retentionEndsAt };
}
module.exports = { access, read };
