const { Types } = require("mongoose"), Message = require("../models/Message");
const files = require("./attorneyMatterFiles");
const { decryptMessagePayload, decryptString, isEncrypted } = require("../utils/dataEncryption");
const valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const audioTypes = new Set(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm"]);
const fail = (status, suffix) => { throw Object.assign(new Error("The message attachment could not be verified."), { status, publicCode: `WORKSPACE_ATTACHMENT_${suffix}` }); };
function references(plain) {
  const content = plain.content && typeof plain.content === "object" ? plain.content : {};
  const inputs = [];
  const key = plain.fileKey || content.fileKey, filename = plain.fileName || content.fileName;
  if (key || filename || ["file", "audio"].includes(plain.type) && !(Array.isArray(content.files) && content.files.length)) inputs.push({ id: "primary", key, filename, mimeType: plain.mimeType || content.mimeType, size:plain.fileSize ?? content.size });
  if (Array.isArray(content.files)) content.files.forEach((file, index) => inputs.push({ id: `file-${index}`, key: file?.fileKey || file?.key || file?.storageKey, filename: file?.fileName || file?.filename || file?.name || file?.originalName, mimeType: file?.mimeType || file?.mimetype, size:file?.size ?? file?.fileSize }));
  return inputs.map(value => {
    const key = typeof value.key === "string" ? decryptString(value.key) : "", name = typeof value.filename === "string" ? decryptString(value.filename) : "";
    const hasAttachment = !isEncrypted(key) && key.startsWith(`cases/${plain.caseId}/documents/`) && !/[\\\u0000-\u0020\u007f]/.test(key) && !key.split("/").some(part => !part || part === "." || part === "..");
    return { id: value.id, key, size:Number.isSafeInteger(value.size) && value.size>=0 ? value.size : null, filename: isEncrypted(name) ? "Attachment name unavailable" : name || "Message attachment", hasAttachment, mimeType: typeof value.mimeType === "string" ? value.mimeType : "", audioMimeType: hasAttachment && plain.type === "audio" && audioTypes.has(value.mimeType) ? value.mimeType : null };
  });
}
function details(plain) {
  const attachments = references(plain).map(({ id, filename, hasAttachment, audioMimeType, size }) => ({ id, filename, hasAttachment, audioMimeType, size })), primary = attachments.find(value => value.id === "primary");
  return { hasAttachment: primary?.hasAttachment === true, audioMimeType: primary?.audioMimeType || null, attachments };
}
async function readDownload(req) {
  const conversation = require("./attorneyConversation");
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "revision", "play", "attachmentId", "retained"].includes(key)) || !valid(req.params.messageId) || !/^[a-f0-9]{64}$/.test(query.revision || "") || query.play !== undefined && query.play !== "true" || query.retained !== undefined && query.retained !== "true" || query.attachmentId !== undefined && !/^(primary|file-(0|[1-9]\d{0,5}))$/.test(query.attachmentId)) fail(400, "INVALID");
  const access = query.retained === "true" ? require("./attorneyRetainedConversation").access : conversation.access;
  const start = await access(req);
  // The common document boundary also rejects contradictory owner/assignment aliases.
  await files.matter(req);
  const raw = await Message.collection.findOne({ _id: new Types.ObjectId(req.params.messageId), caseId: { $in: [start.matter._id, String(start.matter._id)] }, deleted: { $ne: true } });
  if (!raw) fail(404, "MISSING");
  if (conversation.revision(raw) !== query.revision) fail(409, "CHANGED");
  const plain = decryptMessagePayload(raw), attachment = references(plain).find(value => value.id === (query.attachmentId || "primary"));
  if (!attachment?.hasAttachment) fail(404, "MISSING");
  if (query.play && !attachment.audioMimeType) fail(400, "AUDIO_UNAVAILABLE");
  if ((await access(req)).fingerprint !== start.fingerprint) fail(409, "CHANGED");
  // Message references can point to contents retained before a replacement.
  // Scan that exact object without changing today's CaseFile security result.
  return { doc: start.matter, record: null, file: { storageKey: attachment.key, originalName: attachment.filename, mimeType: attachment.mimeType, ...(query.play ? { inlineAudioMimeType: attachment.audioMimeType } : {}) } };
}
module.exports = { details, readDownload };
