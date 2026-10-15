const verifyToken = require("./verifyToken");
const { requireApproved, requireRole } = require("./authz");

function passes(middleware, req) {
  return new Promise(resolve => {
    const deny = { status() { return this; }, json() { resolve(false); } };
    try { Promise.resolve(middleware(req, deny, error => resolve(!error))).catch(() => resolve(false)); }
    catch { resolve(false); }
  });
}

// The initiating credential remains immutable for the connection. Reuse the
// normal verifier so key rotation, authVersion and managed/legacy session
// policy cannot drift into a second stream-only authorization implementation.
function createSupportStreamAccess(req) {
  const token = req.auth?.token;
  const ownerId = String(req.user?._id || req.user?.id || "");
  const role = req.user?.role;
  const sessionId = req.authSessionId || "";
  const exp = Number(req.auth?.payload?.exp);
  const tolerance = Number(process.env.JWT_CLOCK_TOLERANCE || 5);
  const expiresAt = Number.isFinite(exp) && exp > 0 ? exp * 1000 + tolerance * 1000 : null;
  return {
    expiresAt,
    async verify() {
      if (!token || !ownerId || (expiresAt !== null && Date.now() >= expiresAt)) return false;
      const current = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
      if (!await passes(verifyToken, current) || !await passes(requireApproved, current) || !await passes(requireRole(role), current)) return false;
      return String(current.user?._id || current.user?.id || "") === ownerId && (current.authSessionId || "") === sessionId;
    },
  };
}

function attachSupportConversationStream({ req, res, conversationId, subscribe, verifyAccess, expiresAt = null, intervalMs = 25_000, accessTimeoutMs = 12_000 }) {
  let closed = false, unsubscribe = () => {}, timer, expiryTimer;
  let resolveClosed;
  const stopped = new Promise(resolve => { resolveClosed = resolve; });
  let queue = Promise.resolve();
  function close() {
    if (closed) return;
    closed = true;
    resolveClosed(false);
    clearInterval(timer); clearTimeout(expiryTimer);
    unsubscribe();
    req.removeListener("close", close); res.removeListener("close", close);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
  function expired() { return expiresAt !== null && Date.now() >= expiresAt; }
  async function allowed() {
    let deadline;
    try {
      return await Promise.race([
        Promise.resolve().then(verifyAccess), stopped,
        new Promise(resolve => { deadline = setTimeout(() => resolve(false), accessTimeoutMs); }),
      ]);
    } finally { clearTimeout(deadline); }
  }
  function enqueue(payload) {
    if (closed) return;
    queue = queue.then(async () => {
      if (closed) return;
      if (expired() || !await allowed()) { close(); return; }
      if (closed || expired() || res.writableEnded || res.destroyed) { close(); return; }
      if (payload) {
        res.write(`event: ${payload.type || "conversation.updated"}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } else res.write(": ping\n\n");
    }).catch(close);
  }
  req.on("close", close); res.on("close", close);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  unsubscribe = subscribe(conversationId, enqueue);
  timer = setInterval(() => enqueue(null), intervalMs);
  if (expiresAt !== null) {
    const scheduleExpiry = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) close();
      else expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
    };
    scheduleExpiry();
  }
  enqueue({ type: "conversation.ready", conversationId: String(conversationId), at: new Date().toISOString() });
  return close;
}

module.exports = { createSupportStreamAccess, attachSupportConversationStream };
