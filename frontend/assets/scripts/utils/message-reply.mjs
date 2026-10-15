const ID = /^[a-f\d]{24}$/i;

export function messageReplyTarget(message) {
  const id = String(message?.id || message?._id || "");
  if (!ID.test(id) || message?.deleted || message?.pending) return null;
  return { id, sender: typeof message?.sender === "string" ? message.sender : "LPC member" };
}

export function sameMessageRequest(request, text, replyTo) {
  return Boolean(request && request.text === text && (request.replyTo || null) === (replyTo || null));
}

export function messageReplyQuery(query, messageId) {
  if (!ID.test(messageId || "")) throw new TypeError("Invalid reply message.");
  const next = new URLSearchParams(query);
  next.set("messageId", messageId);
  return next;
}
