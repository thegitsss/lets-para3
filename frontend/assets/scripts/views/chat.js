// frontend/assets/scripts/views/chat.js
// Case chat wired to /api/chat/:caseId

import { j } from "../helpers.js";
import { requireAuth } from "../auth.js";

let stylesInjected = false;
const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);

export async function render(el, { escapeHTML, params: routeParams } = {}) {
  requireAuth();
  const params = getRouteParams(routeParams);
  const caseId = params.get("caseId");
  if (el) {
    el.innerHTML = `<section class="dash"><div class="empty">Redirecting to messages…</div></section>`;
  }
  redirectToMessages(caseId);
}

function normalizeCaseStatus(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing", "funded_in_progress"].includes(lower)) return "in progress";
  return lower;
}

function normalizeUserId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.id || value._id || value.userId || "");
}

function getCurrentUserId() {
  const cached = window.getStoredUser?.();
  const cachedId = normalizeUserId(cached);
  if (cachedId) return cachedId;
  try {
    const stored = localStorage.getItem("lpc_user");
    return normalizeUserId(stored ? JSON.parse(stored) : null);
  } catch (_) {}
  return "";
}

function getMessageSenderId(message) {
  return normalizeUserId(
    message?.senderId ||
      message?.sender ||
      message?.user ||
      message?.userId ||
      message?.senderUserId
  );
}

function canUseMessaging(caseData) {
  const status = normalizeCaseStatus(caseData?.status);
  const hasParalegal = !!(caseData?.paralegal || caseData?.paralegalId);
  const escrowFunded =
    !!caseData?.escrowIntentId && String(caseData?.escrowStatus || "").toLowerCase() === "funded";
  return hasParalegal && escrowFunded && FUNDED_WORKSPACE_STATUSES.has(status);
}

function getDefaultBackUrl() {
  try {
    const stored = localStorage.getItem("lpc_user");
    const user = stored ? JSON.parse(stored) : null;
    const role = String(user?.role || "").toLowerCase();
    if (role === "paralegal") return "dashboard-paralegal.html#cases";
    if (role === "admin") return "admin-dashboard.html";
  } catch {
    /* ignore */
  }
  return "dashboard-attorney.html#cases";
}

function redirectFromChat() {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  const referrer = document.referrer;
  if (referrer) {
    try {
      const referrerUrl = new URL(referrer);
      if (referrerUrl.origin === window.location.origin) {
        window.location.href = referrer;
        return;
      }
    } catch {
      /* ignore */
    }
  }
  window.location.href = getDefaultBackUrl();
}

function redirectToMessages(caseId) {
  if (caseId) {
    window.location.replace(`case-detail.html?caseId=${encodeURIComponent(caseId)}#case-messages`);
    return;
  }
  redirectFromChat();
}

function renderMessages(list, messages = [], escapeHTML) {
  if (!list) return;
  if (!messages.length) {
    list.innerHTML = `<div class="empty">No messages yet. Start the conversation below.</div>`;
    return;
  }
  const currentUserId = getCurrentUserId();
  list.innerHTML = messages
    .map((msg) => {
      const sender = msg?.senderId || null;
      const senderId = getMessageSenderId(msg);
      const isSelf = senderId && currentUserId && String(senderId) === String(currentUserId);
      const displayName = sender
        ? `${sender.firstName || ""} ${sender.lastName || ""}`.trim() || "Unknown User"
        : "Unknown User";
      const when = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : "";
      const bubbleClass = `chat-bubble${isSelf ? " is-outgoing" : ""}`;
      return `
        <article class="${bubbleClass}">
          <div class="chat-header">
            <span class="chat-sender">${escapeHTML(displayName)}</span>
            <span class="chat-time">${escapeHTML(when)}</span>
          </div>
          <div class="chat-text">${escapeHTML(msg.text || "")}</div>
        </article>
      `;
    })
    .join("");
  list.scrollTop = list.scrollHeight;
}

function template() {
  return `
    <section class="dash">
      <div class="section-title">Case Chat</div>
      <div class="chat-window" data-chat-messages></div>
      <form class="chat-form" data-chat-form>
        <input type="text" placeholder="Type a message…" data-chat-input autocomplete="off" />
        <button class="btn primary" type="submit">Send</button>
      </form>
      <div class="chat-status" data-chat-status></div>
    </section>
  `;
}

function ensureStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .dash{display:grid;gap:12px}
    .chat-window{min-height:320px;border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#fff;overflow-y:auto;display:grid;gap:10px}
    .chat-bubble{border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#f9fafb}
    .chat-bubble.is-outgoing{justify-self:end}
    .chat-header{display:flex;justify-content:space-between;font-size:.85rem;color:#6b7280;margin-bottom:4px}
    .chat-sender{font-weight:600;color:#111827}
    .chat-form{display:flex;gap:8px}
    .chat-form input{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:10px;font:inherit}
    .btn{padding:10px 16px;border-radius:999px;border:1px solid #d1d5db;cursor:pointer;font-weight:600}
    .btn.primary{background:#111827;color:#fff;border-color:#111827}
    .empty{color:#6b7280;text-align:center;padding:10px}
    .chat-status{font-size:.9rem;color:#6b7280;min-height:20px}
    .error{padding:16px;border:1px solid #fecaca;background:#fef2f2;border-radius:12px;color:#b91c1c}
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}

function getRouteParams(explicit) {
  if (explicit instanceof URLSearchParams) return explicit;
  const hash = window.location.hash || "";
  if (hash.includes("?")) {
    return new URLSearchParams(hash.split("?")[1]);
  }
  if (window.location.search) {
    return new URLSearchParams(window.location.search.slice(1));
  }
  return new URLSearchParams();
}
