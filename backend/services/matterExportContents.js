const { Types } = require("mongoose");
const CaseFile = require("../models/CaseFile");
const Message = require("../models/Message");
const User = require("../models/User");
const { decryptMessagePayload, decryptCaseFilePayload, decryptString, isEncrypted } = require("../utils/dataEncryption");
const { fingerprint } = require("./matterDraftRevision");

const limits = Object.freeze({ messages: 10000, files: 2000, documents: 4000, bytes: 250 * 1024 * 1024, durationMs: 120000 });
const ref = value => value?.toHexString ? value.toHexString() : String(value?._id || value?.id || value || "");
const validId = value => /^[a-f0-9]{24}$/i.test(ref(value));
const refs = value => [new Types.ObjectId(ref(value)), ref(value)];
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { publicCode: code, status }); };
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
function plain(value) {
  if (value == null) return "";
  if (typeof value !== "string" || isEncrypted(value)) fail("EXPORT_SOURCE_INVALID", "Some archive records need review before they can be included.");
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
function safeName(value, fallback = "document") {
  let name = String(value || "").toWellFormed().normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120).replace(/[. ]+$/g, "");
  if (!name) name = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `document-${name}`;
  return name;
}
function keyFor(value, caseId) {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/.test(value)) fail("EXPORT_SOURCE_INVALID", "A document reference needs review before the archive can be prepared.");
  const key = plain(value).replace(/^\/+/, "");
  if (!key.startsWith(`cases/${caseId}/`) || /[\\\u0000-\u001f\u007f]/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) fail("EXPORT_SOURCE_INVALID", "A document reference needs review before the archive can be prepared.");
  return key;
}
const reserved = (key, caseId) => new RegExp(`^cases/${caseId}/(?:receipt-(?:attorney|payout|paralegal)(?:-[^/]*)?\\.pdf|archive(?:-[^/]*)?\\.zip)$`, "i").test(key);

async function read(caseData) {
  const caseId = ref(caseData?._id);
  if (!validId(caseId)) fail("EXPORT_INVALID", "Invalid Matter.", 400);
  const [rawMessages, rawFiles] = await Promise.all([
    Message.collection.find({ caseId: { $in: refs(caseId) }, deleted: { $ne: true } }, { projection: { senderId: 1, senderRole: 1, type: 1, text: 1, content: 1, transcript: 1, fileKey: 1, fileName: 1, fileSize: 1, createdAt: 1, updatedAt: 1, replyTo: 1 } }).sort({ _id: 1 }).limit(limits.messages + 1).toArray(),
    CaseFile.collection.find({ caseId: { $in: refs(caseId) } }, { projection: { userId: 1, originalName: 1, storageKey: 1, mimeType: 1, size: 1, version: 1, createdAt: 1, history: 1 } }).sort({ _id: 1 }).limit(limits.files + 1).toArray(),
  ]);
  if (rawMessages.length > limits.messages || rawFiles.length > limits.files) fail("EXPORT_TOO_LARGE", "This Matter exceeds the archive preparation limit. Contact support for help obtaining its records.", 413);
  const messages = rawMessages.map(decryptMessagePayload), files = rawFiles.map(decryptCaseFilePayload);
  const personIds = [...new Set([caseData.attorney, caseData.attorneyId, caseData.paralegal, caseData.paralegalId, ...messages.map(message => message.senderId)].map(ref).filter(validId))];
  const people = await User.collection.find({ _id: { $in: personIds.map(id => new Types.ObjectId(id)) } }, { projection: { firstName: 1, lastName: 1, role: 1 } }).sort({ _id: 1 }).toArray();
  const names = new Map(people.map(person => [ref(person._id), [plain(person.firstName), plain(person.lastName)].filter(Boolean).join(" ")]));
  const documents = [], keys = new Set(), paths = new Set(), documentByKey = new Map();
  function add(value, name, category, recordedAt, knownSize) {
    if (!value && !name) return;
    const key = keyFor(value, caseId);
    if (reserved(key, caseId) || key === caseData.archiveZipKey || keys.has(key)) return;
    keys.add(key);
    const folder = category === "prior_version" ? "Documents/Prior_versions" : category === "confidentiality" ? "Documents/Confidentiality" : "Documents";
    const base = safeName(plain(name)), ext = base.lastIndexOf(".") > 0 ? base.slice(base.lastIndexOf(".")) : "", stem = ext ? base.slice(0, -ext.length) : base;
    let filename = base, counter = 1;
    while (paths.has(`${folder}/${filename}`.toLowerCase())) filename = `${stem}-${counter++}${ext}`;
    const path = `${folder}/${filename}`; paths.add(path.toLowerCase());
    documents.push({ key, path, name: plain(name) || "Document", category, recordedAt: date(recordedAt), recordedSize: Number.isSafeInteger(knownSize) && knownSize >= 0 ? knownSize : null });
    documentByKey.set(key, documents.at(-1));
    if (documents.length > limits.documents) fail("EXPORT_TOO_LARGE", "This Matter has more documents than can be prepared in one archive. Contact support for help obtaining its records.", 413);
  }
  for (const document of [caseData.preEngagement?.confidentialityDocument, caseData.preEngagement?.paralegalConfidentialityDocument]) if (document) add(document.key, document.name, "confidentiality", document.uploadedAt, document.size);
  for (const file of files) add(file.storageKey, file.originalName, "document", file.createdAt, file.size);
  for (const file of files) for (const previous of file.history || []) add(previous?.storageKey, file.originalName, "prior_version", previous?.replacedAt, null);
  for (const file of caseData.files || []) add(file?.key, file?.original || file?.filename || file?.name, "legacy_document", file?.uploadedAt || file?.createdAt, file?.size);
  // Only include version history attached to files still in the Matter.
  const priorVersions = (history, name, legacy = false) => {
    if (history === undefined || history === null) return;
    if (!Array.isArray(history)) fail("EXPORT_SOURCE_INVALID", "Retained document history needs review before the archive can be prepared.");
    for (const previous of history) add(decryptString(legacy ? previous?.key || previous?.storageKey : previous?.storageKey), decryptString(name), "prior_version", previous?.replacedAt, null);
  };
  for (const file of caseData.files || []) priorVersions(file?.history, file?.original || file?.filename || file?.name, true);
  const rows = messages.map(message => {
    const content = message.content;
    const type = message.type || (message.fileKey ? "file" : "text");
    if (!["text", "file", "audio", "system"].includes(type)) fail("EXPORT_SOURCE_INVALID", "A retained message needs review before the archive can be prepared.");
    const text = plain(message.text || (typeof content === "string" ? content : content?.text) || "");
    const transcript = plain(message.transcript || content?.transcript || "");
    const attachments = [];
    const attach = (key, name, size) => { if (key || name) { add(key, name, "message_attachment", message.createdAt, size); const normalized = keyFor(key, caseId), document = documentByKey.get(normalized); if (document) attachments.push(document.path); } };
    attach(message.fileKey || content?.fileKey, message.fileName || content?.fileName || (type === "file" && message.fileKey ? text : ""), message.fileSize);
    if (Array.isArray(content?.files)) for (const file of content.files) attach(file?.fileKey || file?.key || file?.storageKey, file?.fileName || file?.filename || file?.name || file?.originalName, file?.size);
    return { id: ref(message._id), senderName: names.get(ref(message.senderId)) || "Name unavailable", senderRole: plain(message.senderRole || ""), type, text, transcript, createdAt: date(message.createdAt), replyTo: message.replyTo ? ref(message.replyTo) : null, attachments: [...new Set(attachments)] };
  }).sort((a, b) => (a.createdAt || "9999").localeCompare(b.createdAt || "9999") || a.id.localeCompare(b.id));
  const summary = { title: plain(caseData.title) || "Untitled Matter", attorneyName: names.get(ref(caseData.attorney || caseData.attorneyId)) || plain(caseData.attorneyNameSnapshot) || "Name unavailable", paralegalName: names.get(ref(caseData.paralegal || caseData.paralegalId)) || plain(caseData.paralegalNameSnapshot) || "No paralegal recorded", status: plain(caseData.status), practiceArea: plain(caseData.practiceArea), details: plain(caseData.details), briefSummary: plain(caseData.briefSummary), deadline: date(caseData.deadlineDate || caseData.deadline), completedAt: date(caseData.completedAt), amount: Number.isSafeInteger(caseData.lockedTotalAmount ?? caseData.totalAmount) && (caseData.lockedTotalAmount ?? caseData.totalAmount) >= 0 ? (caseData.lockedTotalAmount ?? caseData.totalAmount) : null, currency: caseData.currency || "USD", tasks: (caseData.tasks || []).map(task => ({ title: plain(typeof task === "string" ? task : task?.title), completed: typeof task?.completed === "boolean" ? task.completed : null })) };
  const counts = { messages: rows.length, documents: documents.length, priorVersions: documents.filter(item => item.category === "prior_version").length, confidentialityDocuments: documents.filter(item => item.category === "confidentiality").length };
  return { summary, messages: rows, documents, counts, revision: fingerprint([summary, rows, documents]) };
}
module.exports = { read, limits, safeName, keyFor };
