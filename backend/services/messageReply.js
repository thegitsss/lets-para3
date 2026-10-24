const validId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const unavailable = () => Object.assign(new Error("The message being replied to is unavailable."), { status: 409, publicCode: "WORKSPACE_REPLY_UNAVAILABLE" });

function references(body = {}) {
  const replyTo = body.replyTo == null ? null : body.replyTo;
  const threadRoot = body.threadRoot == null ? null : body.threadRoot;
  if (replyTo !== null && !validId(replyTo) || threadRoot !== null && (!replyTo || !validId(threadRoot))) {
    throw Object.assign(new Error("Choose a valid message to reply to."), { status: 400, publicCode: "WORKSPACE_REPLY_INVALID" });
  }
  return { replyTo: replyTo?.toLowerCase() || null, threadRoot: threadRoot?.toLowerCase() || null };
}

// Lookup is supplied by the route so replies use its exact Matter and current
// assignment visibility boundary. Never include the parent's text in a reply.
async function resolveReply(reference, findVisible) {
  if (!reference.replyTo) return {};
  const parent = await findVisible(reference.replyTo);
  if (!parent) throw unavailable();
  const root = String(parent.threadRoot || parent._id).toLowerCase();
  if (!validId(root) || reference.threadRoot && reference.threadRoot !== root) throw unavailable();
  if (root !== String(parent._id).toLowerCase() && !await findVisible(root)) throw unavailable();
  return { replyTo: parent._id, threadRoot: root };
}

function sameReply(saved, reference) {
  return String(saved.replyTo || "").toLowerCase() === (reference.replyTo || "")
    && (!reference.threadRoot || String(saved.threadRoot || "").toLowerCase() === reference.threadRoot);
}

module.exports = { references, resolveReply, sameReply };
