const { EventEmitter } = require("events");

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function normalizeConversationId(conversationId = "") {
  return String(conversationId || "").trim();
}

function getConversationChannel(conversationId = "") {
  const normalized = normalizeConversationId(conversationId);
  return normalized ? `support:conversation:${normalized}` : "";
}

function publishConversationEvent(conversationId, payload = {}) {
  const channel = getConversationChannel(conversationId);
  if (!channel) return;
  emitter.emit(channel, {
    type: payload.type || "conversation.updated",
    conversationId: normalizeConversationId(conversationId),
    at: new Date().toISOString(),
    ...payload,
  });
}

function subscribeToConversationEvents(conversationId, handler) {
  const channel = getConversationChannel(conversationId);
  if (!channel || typeof handler !== "function") return () => {};
  emitter.on(channel, handler);
  return () => {
    emitter.off(channel, handler);
  };
}

module.exports = {
  publishConversationEvent,
  subscribeToConversationEvents,
};
