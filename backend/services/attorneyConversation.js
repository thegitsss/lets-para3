const { Types } = require("mongoose");
const Case = require("../models/Case"), Message = require("../models/Message");
const account = require("./attorneyAccountBoundary");
const { evaluateMessagingPermission } = require("./attorneyWorkflowPolicy");
const { isBlockedBetween } = require("../utils/blocks");
const { decryptMessagePayload } = require("../utils/dataEncryption");
const { fingerprint } = require("./matterDraftRevision");
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const fields = ["caseId", "senderId", "type", "text", "content", "transcript", "fileKey", "fileName", "fileSize", "mimeType", "replyTo", "threadRoot", "pinned", "deleted", "reactions", "updatedAt"];
const revision = raw => fingerprint(fields.map(key => raw[key]));
const fail = (status, suffix) => { throw Object.assign(new Error("The conversation changed or is unavailable."), { status, publicCode: `WORKSPACE_${suffix}` }); };
const expected = req => req.method === "GET" ? req.query.expectedOwnerId : req.body?.expectedOwnerId;
const enabled = req => expected(req) !== undefined;
async function access(req) {
  let user;
  try { user = await account.read(req, expected(req)); } catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; }
  if (!validId(req.params.caseId)) fail(400, "INVALID");
  const matter = await Case.collection.findOne({ _id: new Types.ObjectId(req.params.caseId) });
  if (!matter) fail(404, "NOT_FOUND");
  if (![matter.attorney, matter.attorneyId].some(id => String(id || "") === String(user._id))) fail(403, "RESTRICTED");
  const other = matter.paralegal || matter.paralegalId;
  const blocked = other ? await isBlockedBetween(user._id, other) : false;
  const policy = evaluateMessagingPermission({ caseDoc: matter, viewerId: String(user._id), viewerRole: "attorney", partiesBlocked: blocked });
  if (!policy.ready || matter.archived || matter.readOnly) fail(403, "CONVERSATION_CLOSED");
  return { matter, fingerprint: fingerprint([user, matter]) };
}
function cursor(raw) { return Buffer.from(JSON.stringify([new Date(raw.createdAt).toISOString(), String(raw._id)])).toString("base64url"); }
function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail(400, "INVALID");
  try { const pair = JSON.parse(Buffer.from(value, "base64url").toString()); if (!Array.isArray(pair) || pair.length !== 2 || !validId(pair[1]) || new Date(pair[0]).toISOString() !== pair[0]) fail(400, "INVALID"); return { createdAt: new Date(pair[0]), _id: new Types.ObjectId(pair[1]) }; } catch { fail(400, "INVALID"); }
}
function before(raw, inclusive = false) { return { $or: [{ createdAt: { $lt: raw.createdAt } }, { createdAt: raw.createdAt, _id: { [inclusive ? "$lte" : "$lt"]: raw._id } }] }; }
function present(raw, ownerId) {
  const plain = decryptMessagePayload(raw), sender = plain.senderId;
  return {
    _id: String(plain._id), caseId: String(plain.caseId), type: plain.type || "text",
    senderId: sender && typeof sender === "object" && sender._id ? { _id: String(sender._id), firstName: sender.firstName || "", lastName: sender.lastName || "", role: sender.role } : String(sender || ""),
    senderRole: plain.senderRole, text: typeof plain.text === "string" ? plain.text : typeof plain.content === "string" ? plain.content : plain.content?.text || "",
    transcript: plain.transcript || plain.content?.transcript || "", fileName: plain.fileName || "", mimeType: plain.mimeType || "",
    ...require("./attorneyMessageAttachments").details(plain),
    createdAt: plain.createdAt, updatedAt: plain.updatedAt, replyTo: plain.replyTo || null, threadRoot: plain.threadRoot || null,
    pinned: plain.pinned === true, deleted: plain.deleted === true, reactions: plain.reactions || {}, readBy: plain.readBy || [], readReceipts: plain.readReceipts || [],
    revision: revision({ ...raw, senderId: raw.senderId?._id || raw.senderId }),
    ...(String(sender?._id || sender) === ownerId && raw.clientMessageId ? { clientMessageId: raw.clientMessageId } : {}),
  };
}
async function read(req) {
  if (Object.keys(req.query).some(key => !["expectedOwnerId", "cursor", "messageId", "clientMessageId"].includes(key)) || req.query.cursor && req.query.messageId) fail(400, "INVALID");
  const start = await access(req), filter = { caseId: start.matter._id, deleted: { $ne: true } };
  let targetMissing = false;
  if (req.query.clientMessageId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/.test(req.query.clientMessageId)) fail(400, "INVALID");
    filter.senderId = new Types.ObjectId(req.user.id); filter.clientMessageId = req.query.clientMessageId;
  } else if (req.query.cursor) Object.assign(filter, before(decode(req.query.cursor)));
  else if (req.query.messageId) {
    if (!validId(req.query.messageId)) fail(400, "INVALID");
    const target = await Message.findOne({ ...filter, _id: req.query.messageId }).select("createdAt").lean();
    if (target) Object.assign(filter, before(target, true)); else targetMissing = true;
  }
  const rows = await Message.find(filter).select("+clientMessageId").sort({ createdAt: -1, _id: -1 }).limit(51).populate("senderId", "firstName lastName role").lean();
  const more = rows.length > 50, items = rows.slice(0, 50), nextCursor = more ? cursor(items.at(-1)) : null;
  if (start.fingerprint !== (await access(req)).fingerprint) fail(409, "CHANGED");
  return { caseId: req.params.caseId, messages: items.reverse().map(raw => present(raw, req.user.id)), nextCursor, targetMissing, writable: true };
}
async function prepareMutation(req, message) {
  if (!enabled(req)) return;
  await access(req);
  if (!message) return;
  const raw = await Message.collection.findOne({ _id: message._id, caseId: new Types.ObjectId(req.params.caseId), deleted: { $ne: true } });
  if (!raw) fail(404, "MESSAGE_MISSING");
  if (req.body.reviewedRevision !== revision(raw)) fail(409, "MESSAGE_CHANGED");
  // Bind save to the message actually reviewed. Read acknowledgements do not
  // alter its editable content, and unrelated fields remain untouched.
  message.$where = Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : raw[key]]));
}
const sendError = (res, error) => res.status(error.status || (error.name === "DocumentNotFoundError" ? 409 : 503)).json({ code: error.publicCode || (error.name === "DocumentNotFoundError" ? "WORKSPACE_MESSAGE_CHANGED" : "WORKSPACE_CONVERSATION_UNAVAILABLE"), error: "The conversation changed or is unavailable. Refresh messages to check the current record." });
module.exports = { enabled, access, read, prepareMutation, sendError, revision, present };
