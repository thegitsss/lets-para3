const { createLogger: createRuntimeLogger } = require("./logger");
const runtimeLogger = createRuntimeLogger("utils:dataEncryption");
const crypto = require("crypto");

const ENCRYPTION_PREFIX = "enc:v1:";
const REQUIRED_IN_PROD = process.env.NODE_ENV === "production" || process.env.REQUIRE_DATA_ENCRYPTION === "true";

let cachedKey = undefined;
let warnedMissingKey = false;

function loadKey() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    cachedKey = null;
    return cachedKey;
  }
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, "hex");
  } else {
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 32) buf = decoded;
    } catch {
      buf = null;
    }
  }
  cachedKey = buf && buf.length === 32 ? buf : null;
  return cachedKey;
}

function getKeyOrNull() {
  const key = loadKey();
  if (key) return key;
  if (REQUIRED_IN_PROD) {
    throw new Error("DATA_ENCRYPTION_KEY is required in production");
  }
  if (!warnedMissingKey) {
    warnedMissingKey = true;
    runtimeLogger.warn("[dataEncryption] DATA_ENCRYPTION_KEY missing; storing data without encryption.");
  }
  return null;
}

function isEncryptionEnabled() {
  return !!loadKey();
}

function isEncrypted(value) {
  if (!value || typeof value !== "string") return false;
  return value.startsWith(ENCRYPTION_PREFIX);
}

function encryptString(value, { plaintext = false } = {}) {
  if (value == null) return value;
  const str = String(value);
  if (!str) return str;
  // Only authenticated stored ciphertext is reusable. Incoming message text is always plaintext.
  if (!plaintext && isEncrypted(str)) {
    try {
      if (decryptString(str) !== str) return str;
    } catch {
      // Marker-looking plaintext must still be encrypted on writes. Reads remain fail-closed.
    }
  }
  const key = getKeyOrNull();
  if (!key) return str;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ciphertext]).toString("base64");
  return `${ENCRYPTION_PREFIX}${payload}`;
}

function decryptString(value) {
  if (value == null) return value;
  const str = String(value);
  if (!isEncrypted(str)) return value;
  const key = getKeyOrNull();
  if (!key) throw Object.assign(new Error("Protected content is unavailable without its encryption key."), { code: "DATA_ENCRYPTION_UNAVAILABLE" });
  const encoded = str.slice(ENCRYPTION_PREFIX.length);
  const malformed = () => Object.assign(new Error("Protected content has an invalid encryption envelope."), { code: "DATA_ENCRYPTION_MALFORMED" });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw malformed();
  const payload = Buffer.from(encoded, "base64");
  if (payload.length < 12 + 16 || payload.toString("base64") !== encoded) throw malformed();
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return plaintext;
}

function hashForLookup(value) {
  if (value == null) return "";
  const key = loadKey();
  if (!key) return "";
  let raw = String(value);
  if (isEncrypted(raw)) {
    try {
      raw = decryptString(raw);
    } catch {
      return "";
    }
  }
  raw = String(raw || "").trim();
  if (!raw) return "";
  return crypto.createHmac("sha256", key).update(raw).digest("hex");
}

function stableLookupFingerprint(value) {
  if (value == null) return "";
  let raw = String(value);
  if (isEncrypted(raw)) {
    try {
      raw = decryptString(raw);
    } catch {
      return "";
    }
  }
  raw = String(raw || "").trim();
  if (!raw) return "";
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function transformMessageContent(content, transform) {
  if (typeof content === "string") return transform(content);
  if (!content || typeof content !== "object") return content;
  const output = { ...content };
  for (const field of ["text", "transcript", "fileName", "fileKey", "originalName", "storageKey", "name", "key"]) {
    if (typeof output[field] === "string" && output[field]) output[field] = transform(output[field]);
  }
  if (Array.isArray(output.files)) output.files = output.files.map((file) => transformMessageContent(file, transform));
  return output;
}

function encryptMessageFields(doc, { plaintext = null } = {}) {
  if (!doc) return doc;
  const isDocument = typeof doc.isModified === "function";
  const transform = (value) => encryptString(value, { plaintext: plaintext ?? isDocument });
  for (const field of ["text", "transcript", "fileName", "fileKey", "content"]) {
    // Existing ciphertext is untouched when a reaction, pin or read receipt is saved.
    if (isDocument && !doc.isNew && !doc.isModified(field)) continue;
    if (field === "content") doc.content = transformMessageContent(doc.content, transform);
    else if (doc[field]) doc[field] = transform(doc[field]);
  }
  return doc;
}

function decryptMessagePayload(message) {
  if (!message) return message;
  const output = typeof message.toObject === "function" ? message.toObject({ virtuals: true }) : { ...message };
  delete output.clientMessageId;
  delete output.notificationIntent;
  if (output.text) output.text = decryptString(output.text);
  if (output.transcript) output.transcript = decryptString(output.transcript);
  if (output.fileName) output.fileName = decryptString(output.fileName);
  if (output.fileKey) output.fileKey = decryptString(output.fileKey);
  output.content = transformMessageContent(output.content, decryptString);
  return output;
}

function encryptCaseFileFields(doc) {
  if (!doc) return doc;
  const storageKeyFingerprint = stableLookupFingerprint(doc.storageKey);
  if (storageKeyFingerprint) doc.storageKeyFingerprint = storageKeyFingerprint;
  const storageKeyHash = hashForLookup(doc.storageKey);
  if (storageKeyHash) doc.storageKeyHash = storageKeyHash;
  const originalNameHash = hashForLookup(doc.originalName);
  if (originalNameHash) doc.originalNameHash = originalNameHash;
  if (doc.originalName) doc.originalName = encryptString(doc.originalName);
  if (doc.storageKey) doc.storageKey = encryptString(doc.storageKey);
  if (doc.previewKey) doc.previewKey = encryptString(doc.previewKey);
  if (doc.revisionNotes) doc.revisionNotes = encryptString(doc.revisionNotes);
  if (Array.isArray(doc.history)) {
    doc.history.forEach((entry) => {
      if (!entry) return;
      if (entry.storageKey) entry.storageKey = encryptString(entry.storageKey);
    });
  }
  return doc;
}

function decryptCaseFilePayload(file) {
  if (!file) return file;
  const output = typeof file.toObject === "function" ? file.toObject() : { ...file };
  if (output.originalName) output.originalName = decryptString(output.originalName);
  if (output.storageKey) output.storageKey = decryptString(output.storageKey);
  if (output.previewKey) output.previewKey = decryptString(output.previewKey);
  if (output.revisionNotes) output.revisionNotes = decryptString(output.revisionNotes);
  if (Array.isArray(output.history)) {
    output.history = output.history.map((entry) => {
      if (!entry) return entry;
      const next = { ...entry };
      if (next.storageKey) next.storageKey = decryptString(next.storageKey);
      return next;
    });
  }
  return output;
}

function buildCaseFileKeyQuery({ caseId, storageKey }) {
  const query = { caseId };
  if (!storageKey) return query;
  const fingerprint = stableLookupFingerprint(storageKey);
  if (!isEncryptionEnabled()) {
    query.$or = [
      ...(fingerprint ? [{ storageKeyFingerprint: fingerprint }] : []),
      { storageKey },
    ];
    return query;
  }
  const hash = hashForLookup(storageKey);
  if (hash || fingerprint) {
    query.$or = [
      ...(fingerprint ? [{ storageKeyFingerprint: fingerprint }] : []),
      ...(hash ? [{ storageKeyHash: hash }] : []),
      { storageKey },
    ];
    return query;
  }
  query.storageKey = storageKey;
  return query;
}

function buildCaseFileNameQuery({ caseId, originalName }) {
  const query = { caseId };
  if (!originalName) return query;
  if (!isEncryptionEnabled()) {
    query.originalName = originalName;
    return query;
  }
  const hash = hashForLookup(originalName);
  if (hash) {
    query.$or = [{ originalNameHash: hash }, { originalName }];
    return query;
  }
  query.originalName = originalName;
  return query;
}

module.exports = {
  isEncryptionEnabled,
  isEncrypted,
  encryptString,
  decryptString,
  hashForLookup,
  stableLookupFingerprint,
  encryptMessageFields,
  decryptMessagePayload,
  encryptCaseFileFields,
  decryptCaseFilePayload,
  buildCaseFileKeyQuery,
  buildCaseFileNameQuery,
};
