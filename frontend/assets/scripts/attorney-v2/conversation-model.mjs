import { readMessages, objectId } from "./workspace-model.mjs";
const requestId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/.test(value);
export function readConversation(value, caseId) {
  if (value?.retained !== undefined && typeof value.retained !== "boolean" || value?.retained === true && value.writable !== false) throw new Error("invalid_retained_conversation");
  if (value?.caseId !== caseId || typeof value.writable !== "boolean" || typeof value.targetMissing !== "boolean" || value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.nextCursor)) || !Array.isArray(value.messages) || value.messages.length > 50 || value.messages.some(message => message.deleted === true)) throw new Error("invalid_conversation");
  const messages = readMessages(value, caseId).map((message, index) => {
    const raw = value.messages[index];
    if (!/^[a-f0-9]{64}$/.test(raw.revision || "") || !(value.retained === true && message.createdAt === null) && !Number.isFinite(Date.parse(message.createdAt)) || !raw.reactions || typeof raw.reactions !== "object" || Array.isArray(raw.reactions) || !Array.isArray(raw.readBy)) throw new Error("invalid_message_details");
    const reactions = Object.entries(raw.reactions).map(([emoji, users]) => {
      if (emoji.length > 30 || !Array.isArray(users) || users.some(user => !objectId(user))) throw new Error("invalid_reaction");
      return { emoji, users: [...new Set(users)] };
    });
    if (raw.clientMessageId !== undefined && !requestId(raw.clientMessageId)) throw new Error("invalid_message_request");
    if (raw.hasAttachment !== undefined && typeof raw.hasAttachment !== "boolean" || raw.audioMimeType != null && (!raw.hasAttachment || message.type !== "audio" || !["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm"].includes(raw.audioMimeType))) throw new Error("invalid_message_attachment");
    const attachments = raw.attachments === undefined ? (["file", "audio"].includes(message.type) ? [{ id: "primary", filename: message.filename, hasAttachment: raw.hasAttachment === true, audioMimeType: raw.audioMimeType || null }] : []) : raw.attachments;
    if (!Array.isArray(attachments) || new Set(attachments.map(item => item?.id)).size !== attachments.length || attachments.some(item => !/^(primary|file-(0|[1-9]\d{0,5}))$/.test(item?.id || "") || typeof item.filename !== "string" || typeof item.hasAttachment !== "boolean" || item.audioMimeType !== null && (!item.hasAttachment || message.type !== "audio" || !["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm"].includes(item.audioMimeType)))) throw new Error("invalid_message_attachments");
    return { ...message, revision: raw.revision, hasAttachment: raw.hasAttachment === true, audioMimeType: raw.audioMimeType || null, attachments: attachments.map(({ id, filename, hasAttachment, audioMimeType, size }) => ({ id, filename, hasAttachment, audioMimeType, size:Number.isSafeInteger(size) && size>=0 ? size : null })), reactions, readBy: raw.readBy.filter(objectId), clientMessageId: raw.clientMessageId || "", editedAt: raw.updatedAt || null };
  });
  return { ...value, messages };
}
export function confirmedMessage(value, caseId, ownerId) {
  const message = value?.message;
  if (!objectId(message?._id || message?.id) || String(message.caseId) !== caseId || String(message.senderId?._id || message.senderId) !== ownerId || message.type !== "text") throw new Error("unconfirmed_message");
  return message._id || message.id;
}
export function mergeMessages(older, newer) {
  const entries = new Map([...older, ...newer].map(message => [message.id, message]));
  const instant = value => value === null ? -Infinity : Date.parse(value);
  return [...entries.values()].sort((a, b) => instant(a.createdAt) - instant(b.createdAt) || a.id.localeCompare(b.id));
}
