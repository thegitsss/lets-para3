const KEY = "lpc_support_pending_request";
const MAX_RECORD_BYTES = 120_000;
const validId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const validRequest = value => typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function valid(record) {
  if (!plain(record) || record.version !== 1 || !validId(record.ownerId) || !["attorney", "paralegal", "admin"].includes(record.role)
    || !validId(record.conversationId) || !validRequest(record.requestId) || !["send", "restart", "escalate"].includes(record.action)
    || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 || !plain(record.body)) return false;
  const body = record.body;
  if (Object.keys(body).some(key => !["text", "sourcePage", "pageContext", "promptAction", "messageId"].includes(key))
    || typeof body.sourcePage !== "string" || !plain(body.pageContext)
    || body.promptAction != null && !plain(body.promptAction)) return false;
  if (record.action === "escalate") return validId(body.messageId) && body.text === undefined && body.promptAction === undefined;
  if (body.messageId !== undefined) return false;
  return record.action === "send"
    ? typeof body.text === "string" && Boolean(body.text.trim()) && body.text.length <= 4000
    : body.text === undefined && body.promptAction === undefined;
}

function storageError() {
  return Object.assign(new Error("Your browser couldn't save this request. Allow tab storage and try again."), { name: "SupportRequestStorageError" });
}

// A single unresolved operation belongs to one account in one tab. The exact
// captured input is retained for deliberate same-ID retry, never automatic POST.
export function createSupportRequestStore({ storage = () => window.sessionStorage } = {}) {
  function readRaw() {
    try { return storage().getItem(KEY); } catch { throw storageError(); }
  }
  function removeRaw() {
    try { storage().removeItem(KEY); } catch { throw storageError(); }
  }
  return Object.freeze({
    read({ ownerId, role }) {
      const raw = readRaw();
      if (raw === null) return null;
      let record;
      try { record = raw.length <= MAX_RECORD_BYTES ? JSON.parse(raw) : null; } catch { record = null; }
      if (!valid(record) || record.ownerId !== ownerId || record.role !== role) { removeRaw(); return null; }
      return record;
    },
    save(record) {
      if (!valid(record)) throw storageError();
      let raw;
      try { raw = JSON.stringify(record); } catch { throw storageError(); }
      if (raw.length > MAX_RECORD_BYTES) throw storageError();
      try {
        const target = storage(); target.setItem(KEY, raw);
        if (target.getItem(KEY) !== raw) throw storageError();
      } catch { throw storageError(); }
      return JSON.parse(raw);
    },
    clear({ ownerId, role, requestId } = {}) {
      // An older response must not erase a newer operation's recovery record.
      if (requestId) {
        const raw = readRaw(); let record;
        try { record = JSON.parse(raw); } catch { return; }
        if (record?.ownerId !== ownerId || record?.role !== role || record?.requestId !== requestId) return;
      }
      removeRaw();
    },
  });
}
