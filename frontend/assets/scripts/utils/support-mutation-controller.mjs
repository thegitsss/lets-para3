import { createSupportRequestStore } from "./support-request-state.mjs";

const validId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const text = {
  running: "Waiting for Assistant…",
  checking: "Checking the request…",
  pending: "Your request is still processing.",
  blocked: "Checking the other active request…",
  uncertain: "We couldn't confirm the result. Check before trying again.",
  retryable: "This request can be retried.",
  unknown: "We couldn't find the result. Check the conversation or retry this request.",
  failed: "This request can't continue. Return to the current conversation.",
};

function matchesRequest(value, record, state) {
  return plain(value) && value.id === record.requestId && value.action === record.action && value.state === state;
}

function validResult(result, record) {
  if (!plain(result) || !validId(result.conversation?.id)) return false;
  const message = value => plain(value) && validId(value.id) && typeof value.text === "string";
  if (record.action === "restart") return result.conversation.id !== record.conversationId
    && Array.isArray(result.messages) && result.messages.every(message);
  if (record.action === "escalate") return result.conversation.id === record.conversationId
    && message(result.assistantMessage) && result.assistantMessage.id === record.body.messageId
    && validId(result.ticket?.id) && result.assistantMessage.metadata?.escalation?.requested === true
    && (!result.systemMessage || message(result.systemMessage));
  return result.conversation.id === record.conversationId && message(result.userMessage) && message(result.assistantMessage)
    && result.userMessage.id !== result.assistantMessage.id && result.userMessage.text === record.body.text
    && (!result.systemMessage || message(result.systemMessage));
}

export function createSupportMutationController({
  request,
  store = createSupportRequestStore(),
  makeId = () => crypto.randomUUID(),
  now = () => Date.now(),
  onChange = () => {},
  onResult = () => {},
} = {}) {
  let pending = null, phase = "idle", message = "", active = null, generation = 0;
  const snapshot = () => ({ pending: clone(pending), phase, message, busy: Boolean(active), canRetry: ["retryable", "unknown"].includes(phase) });
  function publish(next, copy = text[next] || "") { phase = next; message = copy; onChange(snapshot()); }
  function complete(result, record, ticket) {
    if (ticket !== generation) return;
    if (!validResult(result, record)) { publish("uncertain"); return; }
    onResult(clone(result), clone(record));
    // A failed erasure does not make an acknowledged result unknown. A later
    // restoration can safely check the same completed ID again.
    try { store.clear(record); } catch { /* Keep the acknowledged result. */ }
    pending = null; publish("idle");
  }
  async function run(check = false) {
    if (!pending || active) return;
    const record = clone(pending), ticket = generation, controller = new AbortController();
    active = controller; publish(check ? "checking" : "running");
    try {
      const conversationId = encodeURIComponent(record.conversationId);
      const endpoint = check ? `/api/support/conversation/${conversationId}/requests/${record.requestId}` : {
        send: `/api/support/conversation/${conversationId}/messages`,
        restart: `/api/support/conversation/${conversationId}/restart`,
        escalate: `/api/support/conversation/${conversationId}/escalate`,
      }[record.action];
      const response = await request(endpoint, {
        method: check ? "GET" : "POST", signal: controller.signal,
        ...(check ? {} : { body: { ...clone(record.body), requestId: record.requestId } }),
      });
      const payload = await response.json();
      if (ticket !== generation || controller.signal.aborted) return;
      if (check) {
        if (response.status === 404) { publish("unknown"); return; }
        if (!response.ok || !plain(payload) || !["pending", "succeeded", "retryable", "failed"].includes(payload.request?.state)
          || !matchesRequest(payload.request, record, payload.request.state)) { publish("uncertain"); return; }
        if (payload.request.state === "succeeded") complete(payload.result, record, ticket);
        else publish(payload.request.state);
        return;
      }
      if (response.ok && matchesRequest(payload.request, record, "succeeded")) { complete(payload, record, ticket); return; }
      if (response.status === 409 && payload.code === "SUPPORT_CONVERSATION_BUSY") { publish("blocked"); return; }
      if (response.status === 409 && payload.code === "SUPPORT_REQUEST_PENDING") { publish("pending"); return; }
      if (["SUPPORT_REQUEST_REUSED", "SUPPORT_CONVERSATION_CHANGED", "SUPPORT_REQUEST_FAILED"].includes(payload.code)) { publish("failed"); return; }
      publish("uncertain");
    } catch (error) {
      if (ticket !== generation) return;
      publish(!check && error?.dispatched === false && error?.kind !== "authentication" ? "retryable" : "uncertain");
    } finally {
      if (ticket === generation && active === controller) { active = null; onChange(snapshot()); }
    }
  }
  return Object.freeze({
    snapshot,
    restore(identity) {
      if (active || pending) return snapshot();
      const record = store.read(identity);
      if (record) { pending = record; publish("uncertain"); }
      return snapshot();
    },
    adopt(record, { ownerId, role }, { replaceInactive = false } = {}) {
      if (active || (pending && !(replaceInactive && ["retryable", "unknown", "failed"].includes(phase)))
        || record?.ownerId !== ownerId || record?.role !== role) return snapshot();
      pending = store.save(record); publish("uncertain"); return snapshot();
    },
    async begin({ ownerId, role, conversationId, action, body }) {
      if (active || pending) return;
      const record = store.save({ version: 1, ownerId, role, conversationId, action, body: clone(body), requestId: makeId(), createdAt: now() });
      pending = record;
      await run(false);
    },
    check: () => run(true),
    retry: () => ["retryable", "unknown"].includes(phase) ? run(false) : Promise.resolve(),
    stopWaiting() {
      if (!active) return;
      generation++; active.abort(); active = null;
      publish("uncertain", "Stopped waiting. Check the result when you're ready.");
    },
    dismissFailed() {
      if (active || phase !== "failed") return false;
      store.clear(pending); pending = null; publish("idle"); return true;
    },
    clear({ erase = true } = {}) {
      generation++; active?.abort(); active = null; pending = null;
      if (erase) { try { store.clear(); } catch { /* Future reads still verify owner and role before exposing a record. */ } }
      publish("idle");
    },
  });
}
