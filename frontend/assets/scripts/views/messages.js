// frontend/assets/scripts/views/messages.js
// Cookie-based auth; summaries; voice notes with presign→S3 PUT→message record; signed playback.

import { API_BASE, j as jBase } from "../helpers.js";

const $ = (s) => document.querySelector(s);
const threadListEl = $("#thread-list");
const msgListEl = $("#message-list");
const inputEl = $("#message-input");
const aiPanel = $("#ai-helper");
const aiOut = $("#ai-output");
const sumMenu = $("#summarize-menu");
const sumStart = $("#sum-start");
const sumEnd = $("#sum-end");
const sendBtn = document.getElementById("send-btn");
const defaultSendText = sendBtn?.textContent || "Send";
const attachmentBtn = document.getElementById("attachment-btn");
const attachmentInput = document.getElementById("attachment-input");
const defaultAttachmentText = attachmentBtn?.textContent || "Attach";
const toastHelper = window.toastUtils;
const viewerElements = {
  name: document.querySelector("[data-viewer-name]"),
  avatar: document.querySelector("[data-viewer-avatar]"),
  state: document.querySelector("[data-viewer-state]"),
  bio: document.querySelector("[data-viewer-bio]"),
};

const MAX_MESSAGE_CHARS = 2000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
]);
const MIME_FALLBACKS = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};
let viewerProfile = null;

let currentThread = null;
let CSRF = null;
const CURRENT_USER_ID = (() => {
  try {
    const user = typeof window.getStoredUser === "function" ? window.getStoredUser() : null;
    return user?.id || user?._id || "";
  } catch {
    return "";
  }
})();

const MESSAGE_JUMP_KEY = "lpc_message_jump";
let pendingJump = consumeMessageJump();

async function getCSRF() {
  if (CSRF) return CSRF;
  try {
    const r = await fetch("/api/csrf", { credentials: "include" });
    const j = await r.json().catch(() => ({}));
    CSRF = j.csrfToken || "";
  } catch { CSRF = ""; }
  return CSRF;
}

// --- fetch helper (always send cookies; JSON if body is object) --------------
async function j(url, opts = {}) {
  const o = { credentials: "include", headers: {}, ...opts };
  if (o.body && typeof o.body === "object" && !(o.body instanceof FormData)) {
    o.headers["Content-Type"] = "application/json";
    o.body = JSON.stringify(o.body);
  }
  // Add CSRF if we have it (harmless when not required)
  if (!o.headers["X-CSRF-Token"]) {
    const tok = await getCSRF();
    if (tok) o.headers["X-CSRF-Token"] = tok;
  }
  try {
    return await (jBase ? jBase(url, o) : (await fetch(url, o)).json());
  } catch (e) {
    const r = await fetch(url, o);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    return ct.includes("application/json") ? r.json() : r.text();
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

async function ensureAuthed() {
  try {
    const me = await j(`${API_BASE}/users/me`);
    if (!me?.id && !me?._id) throw new Error("no user");
  } catch {
    location.href = "login.html";
  }
}

// --- Threads / Messages ------------------------------------------------------
async function loadThreads(q = "") {
  if (!threadListEl) return [];
  threadListEl.textContent = "Loading…";
  try {
    const data = await j(`${API_BASE}/messages/threads${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    const list = data.threads || [];
    threadListEl.innerHTML =
      list
        .map(
          (t) => `
        <button class="lp-thread" data-id="${t.id}" style="display:block;width:100%;text-align:left;border:1px solid #eee;border-radius:10px;padding:.55rem .6rem;background:#fff;margin-bottom:6px;">
          <div style="font-weight:600">${escapeHtml(t.title || "Thread")}</div>
          <div style="color:#666;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.lastMessageSnippet || "")}</div>
        </button>`
        )
        .join("") || "<div>No threads</div>";
    return list;
  } catch {
    threadListEl.innerHTML = "<div>Couldn’t load threads</div>";
    return [];
  }
}

async function openThread(id) {
  currentThread = id;
  if (!msgListEl) return;
  msgListEl.textContent = "Loading…";
  try {
    const data = await j(`${API_BASE}/messages/${id}`);
    renderMessages(id, data.messages || []);
    // mark read (best-effort)
    j(`${API_BASE}/messages/${id}/read`, { method: "POST", body: {} }).catch(() => {});
  } catch {
    msgListEl.innerHTML = "<div>Couldn’t load messages</div>";
  }
}

function messageRow(caseId, m, isMine, senderName = "Unknown User") {
  const when = new Date(m.createdAt || m._createdAt || Date.now()).toLocaleString();
  let bodyHTML = "";
  if (m.type === "audio") {
    const key = m.fileKey || m.key || "";
    const title = escapeHtml(m.fileName || "voice-note.webm");
    const transcript = m.transcript ? `<div style="margin-top:.35rem;border-top:1px dashed #e5e5e5;padding-top:.35rem;">${escapeHtml(m.transcript)}</div>` : "";
    bodyHTML = `
      <div>
        <button class="play-audio btn" data-case="${caseId}" data-key="${escapeHtml(key)}" style="padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer">Play audio</button>
        <span class="muted" style="margin-left:6px;">${title}</span>
        <div class="audio-holder"></div>
        ${transcript}
      </div>`;
  } else if (m.type === "file") {
    const safeName = escapeHtml(m.fileName || "Attachment");
    const fileKey = escapeHtml(m.fileKey || "");
    const sizeText = formatBytes(m.fileSize);
    const meta = sizeText ? `<span class="muted" style="margin-left:8px;">${escapeHtml(sizeText)}</span>` : "";
    const downloadBtn = fileKey
      ? `<button class="btn secondary" data-attachment-download data-case="${caseId}" data-key="${fileKey}" style="margin-right:8px;">Download</button>`
      : "";
    bodyHTML = `
      <div class="attachment-row" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
        ${downloadBtn}
        <span class="attachment-name" style="font-weight:600;">${safeName}</span>
        ${meta}
      </div>`;
  } else {
    const normalized = (m.content || m.text || "").replace(/\r\n/g, "\n");
    const text = escapeHtml(normalized).replace(/\n/g, "<br>");
    bodyHTML = text || "<em class='muted'>[empty]</em>";
  }

  return `
    <div class="msg" style="display:flex;gap:.5rem;margin:.4rem 0;${isMine ? "flex-direction:row-reverse;" : ""}">
      <input type="checkbox" class="pick" data-id="${m.id || m._id}" style="margin-top:.5rem;">
      <div style="background:${isMine ? "#f0f5ff" : "#fff"};border:1px solid #eee;border-radius:14px;padding:.55rem .7rem;max-width:75%;">
        <div style="font-weight:600;margin-bottom:.2rem;">${escapeHtml(senderName)}</div>
        ${bodyHTML}
        <div style="color:#888;font-size:.78rem;margin-top:.25rem;">${when}</div>
      </div>
    </div>`;
}

function renderMessages(caseId, list) {
  const uid = CURRENT_USER_ID;
  msgListEl.innerHTML = (list || [])
    .map((m) => {
      const sender = m.senderId;
      const senderId = typeof sender === "object" ? sender?._id || sender?.id : sender;
      const isMine = uid && senderId ? String(senderId) === String(uid) : false;
      const senderName =
        (typeof sender === "object"
          ? `${sender?.firstName || ""} ${sender?.lastName || ""}`.trim()
          : "") || "Unknown User";
      return messageRow(caseId, m, isMine, senderName);
    })
    .join("");
  // delegate play buttons
  msgListEl.querySelectorAll(".play-audio").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const holder = btn.parentElement?.querySelector(".audio-holder");
      if (!holder) return;
      btn.disabled = true;
      try {
        const u = new URL("/api/uploads/signed-get", location.origin);
        u.searchParams.set("caseId", btn.dataset.case || "");
        u.searchParams.set("key", btn.dataset.key || "");
        const jres = await j(u.toString(), { method: "GET" });
        const url = jres.url;
        holder.innerHTML = `<audio controls src="${escapeHtml(url)}" style="margin-top:.25rem;max-width:100%"></audio>`;
      } catch {
        holder.innerHTML = `<div style="color:#b91c1c">Could not fetch playback URL.</div>`;
      } finally {
        btn.disabled = false;
      }
    });
  });
  msgListEl.querySelectorAll("[data-attachment-download]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-key");
      const caseId = btn.getAttribute("data-case");
      if (!key) return;
      btn.disabled = true;
      try {
        const u = new URL("/api/uploads/signed-get", location.origin);
        u.searchParams.set("caseId", caseId || "");
        u.searchParams.set("key", key);
        const jres = await j(u.toString(), { method: "GET" });
        const url = jres.url;
        window.open(url, "_blank", "noopener");
      } catch {
        notify("Unable to download attachment. Please try again.", "err");
      } finally {
        btn.disabled = false;
      }
    });
  });

  scrollMessagesToBottom();
}

function scrollMessagesToBottom() {
  if (!msgListEl) return;
  msgListEl.scrollTop = msgListEl.scrollHeight;
}

function sanitizeMessageInput(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function sanitizeFilename(name) {
  const safe = String(name || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim();
  return safe.slice(0, 120) || "attachment";
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function notify(message, type = "info") {
  if (toastHelper?.show) {
    toastHelper.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}

async function loadViewerProfile() {
  try {
    const me = await j(`${API_BASE}/users/me`);
    if (!me) return null;
    const safeName = sanitizeMessageInput(`${me.firstName || ""} ${me.lastName || ""}`) || "Paralegal";
    const safeState = sanitizeMessageInput(me.state || me.location || me.region || "");
    const safeBio = sanitizeMessageInput(me.bio || "");
    const avatar = me.profileImage || me.avatarURL || buildInitialsAvatar(safeName);
    viewerProfile = { name: safeName, state: safeState, bio: safeBio, avatar };
    applyViewerProfile(viewerProfile);
    return viewerProfile;
  } catch (err) {
    console.warn("Unable to load viewer profile", err);
    return null;
  }
}

function applyViewerProfile(profile = {}) {
  if (viewerElements.name) viewerElements.name.textContent = profile.name || "Paralegal";
  if (viewerElements.state) viewerElements.state.textContent = profile.state || "—";
  if (viewerElements.bio) viewerElements.bio.textContent = profile.bio || "—";
  if (viewerElements.avatar && profile.avatar) {
    viewerElements.avatar.src = profile.avatar;
    viewerElements.avatar.alt = `${profile.name || "Paralegal"} avatar`;
  }
}

async function ensureMessagesSession(expectedRole) {
  if (typeof window.refreshSession !== "function") return { ok: true };
  const session = await window.refreshSession(expectedRole);
  if (!session) {
    try {
      window.location.href = "login.html";
    } catch {}
    return null;
  }
  return session;
}

function createUploadPlaceholder(name) {
  if (!msgListEl) {
    return {
      update() {},
      remove() {},
    };
  }
  const row = document.createElement("div");
  row.className = "msg uploading";
  row.style.display = "flex";
  row.style.gap = ".5rem";
  row.style.margin = ".4rem 0";
  row.innerHTML = `
    <div style="background:#fffbea;border:1px solid #fcd34d;border-radius:14px;padding:.55rem .7rem;max-width:75%;">
      <div style="font-weight:600;margin-bottom:.2rem;">Uploading attachment</div>
      <div><strong>${escapeHtml(name)}</strong> · <span data-upload-progress>0%</span></div>
    </div>
  `;
  msgListEl.appendChild(row);
  scrollMessagesToBottom();
  const progressEl = row.querySelector("[data-upload-progress]");
  return {
    update(pct) {
      if (!progressEl) return;
      const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
      progressEl.textContent = `${safePct.toFixed(0)}%`;
    },
    remove() {
      row.remove();
    },
  };
}

function setAttachmentBusy(busy) {
  if (!attachmentBtn) return;
  if (busy) {
    attachmentBtn.disabled = true;
    attachmentBtn.textContent = "Uploading…";
  } else {
    attachmentBtn.disabled = false;
    attachmentBtn.textContent = defaultAttachmentText;
  }
}

function getFileExtension(name) {
  const parts = String(name || "").split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function resolveMimeType(file) {
  const ext = getFileExtension(file?.name || "");
  return file?.type || MIME_FALLBACKS[ext] || "";
}

function buildContentDisposition(name) {
  const safe = String(name || "").replace(/"/g, "");
  return `attachment; filename="${safe}"`;
}

function buildInitialsAvatar(name) {
  const initials =
    (name || "")
      .split(" ")
      .map((part) => part.charAt(0).toUpperCase())
      .join("")
      .slice(0, 2) || "P";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='16' fill='#e5e7eb'/><text x='50%' y='55%' text-anchor='middle' font-family='Sarabun, Arial' font-size='26' fill='#111827' font-weight='600'>${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

async function sendMessage() {
  if (!inputEl || !msgListEl) return;
  const sanitized = sanitizeMessageInput(inputEl.value || "");
  if (!sanitized) {
    notify("Enter a message before sending.", "err");
    return;
  }
  const activeSession = await ensureMessagesSession();
  if (!activeSession) return;
  if (!currentThread) {
    notify("Select a conversation before sending.", "err");
    return;
  }
  if (sanitized.length > MAX_MESSAGE_CHARS) {
    notify("Message exceeds 2,000 characters.", "err");
    return;
  }

  const buttonLabel = sendBtn?.textContent || defaultSendText;
  let restoreSendButton = true;
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
  }

  const now = Date.now();
  const optimistic = {
    id: `tmp-${now}`,
    senderId: CURRENT_USER_ID ? { _id: CURRENT_USER_ID, firstName: "You" } : "me",
    type: "text",
    content: sanitized,
    createdAt: now,
  };
  msgListEl.insertAdjacentHTML("beforeend", messageRow(currentThread, optimistic, true, "You"));
  scrollMessagesToBottom();
  inputEl.value = "";

  try {
    const data = await j(`${API_BASE}/messages/${currentThread}`, {
      method: "POST",
      body: { type: "text", content: sanitized },
    });
    const saved = data.message ? [savedNormalize(data.message)] : [];
    const refetch = await j(`${API_BASE}/messages/${currentThread}`);
    renderMessages(currentThread, refetch.messages || saved);
    scheduleSendReset();
    restoreSendButton = false;
  } catch (err) {
    notify("Unable to send that message. Please try again.", "err");
    inputEl.value = sanitized;
    inputEl.focus();
    await openThread(currentThread);
  } finally {
    if (restoreSendButton && sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = buttonLabel;
    }
  }
}

function scheduleSendReset() {
  if (!inputEl || !sendBtn) return;
  const handler = () => {
    sendBtn.disabled = false;
    sendBtn.textContent = defaultSendText;
    inputEl.removeEventListener("input", handler);
  };
  inputEl.addEventListener("input", handler, { once: true });
}

function bindAttachmentControls() {
  if (!attachmentInput) return;
  if (attachmentBtn) {
    attachmentBtn.addEventListener("click", () => attachmentInput.click());
  }
  attachmentInput.addEventListener("change", handleAttachmentSelection);
}

async function handleAttachmentSelection(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  if (!currentThread) {
    notify("Select a conversation before uploading attachments.", "err");
    return;
  }
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    await uploadAttachment(file);
  }
}

async function uploadAttachment(file) {
  if (!file || !currentThread) return;
  const activeSession = await ensureMessagesSession();
  if (!activeSession) return;
  const mimeType = resolveMimeType(file);
  if (!mimeType || !ALLOWED_ATTACHMENT_TYPES.has(mimeType)) {
    notify("That file type is not allowed. Upload PDF, Word, Excel, or common image files.", "err");
    return;
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    notify("File is empty or unreadable.", "err");
    return;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    notify("File exceeds the 25 MB limit.", "err");
    return;
  }

  const safeName = sanitizeFilename(file.name);
  setAttachmentBusy(true);
  const placeholder = createUploadPlaceholder(safeName);
  try {
    const { url, key } = await presignUpload({
      contentType: mimeType,
      ext: getFileExtension(file.name),
      folder: "messages",
      caseId: currentThread,
      size: file.size,
      contentDisposition: buildContentDisposition(safeName),
    });
    await uploadToS3(url, file, mimeType, (pct) => placeholder.update(pct));
    await j(`${API_BASE}/messages/${currentThread}/file`, {
      method: "POST",
      body: {
        fileKey: key,
        fileName: safeName,
        fileSize: file.size,
        mimeType,
      },
    });
    await openThread(currentThread);
    scrollMessagesToBottom();
  } catch (err) {
    console.error(err);
    notify("Unable to upload attachment. Please try again.", "err");
  } finally {
    placeholder.remove();
    setAttachmentBusy(false);
  }
}

function savedNormalize(m) {
  return { ...m, id: m.id || m._id };
}

function pickedIds() {
  return [...document.querySelectorAll("#message-list .pick:checked")].map((x) => x.dataset.id);
}

async function summarize(mode) {
  if (!currentThread) return;
  const payload = {};
  if (mode === "daterange") {
    if (!sumStart.value || !sumEnd.value) return;
    payload.start = sumStart.value;
    payload.end = sumEnd.value;
  }
  showAIPanel();
  aiOut.textContent = "Summarizing…";
  try {
    const res = await j(`${API_BASE}/messages/${currentThread}/summary`, { method: "POST", body: payload });
    aiOut.textContent = res.summary || "No summary.";
  } catch {
    aiOut.textContent = "Summary unavailable.";
  }
}

// ---- Voice Notes: recorder + presign + upload + message ---------------------
async function presignUpload({ contentType, ext, folder, size, caseId, contentDisposition }) {
  const body = { contentType, ext, folder, size };
  if (caseId) body.caseId = caseId;
  if (contentDisposition) body.contentDisposition = contentDisposition;
  return j("/api/uploads/presign", {
    method: "POST",
    body,
  });
}

async function uploadToS3(url, blob, contentType, onProgress) {
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress((event.loaded / event.total) * 100);
        }
      };
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("S3 upload failed")));
    xhr.onerror = () => reject(new Error("S3 upload error"));
    xhr.send(blob);
  });
}

async function createVoiceMessage(caseId, { fileKey, fileName, mimeType, transcript }) {
  return j(`${API_BASE}/messages/${caseId}/voice`, {
    method: "POST",
    body: { fileKey, fileName, mimeType, transcript },
  });
}

// injected UI inside the AI panel
function ensureRecorderUI() {
  if (!aiPanel) return;
  if (document.getElementById("rec-ui")) return;

  const cssId = "rec-styles";
  if (!document.getElementById(cssId)) {
    const s = document.createElement("style");
    s.id = cssId;
    s.textContent = `
      .rec-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:.5rem 0}
      .rec-badge{display:inline-flex;align-items:center;gap:6px;border:1px solid #e5e7eb;border-radius:999px;padding:4px 10px;background:#fff}
      .rec-dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:blink 1.1s infinite}
      @keyframes blink{0%,60%{opacity:1}61%,100%{opacity:.2}}
      .rec-meter{width:180px;height:12px;border-radius:8px;background:#f3f4f6;overflow:hidden;border:1px solid #e5e7eb}
      .rec-fill{height:100%;width:0%}
      .rec-timer{font-family:ui-monospace, SFMono-Regular, Menlo, monospace}
      .rec-txt{white-space:pre-wrap;border:1px dashed #e5e7eb;border-radius:10px;padding:8px;background:#fff;max-height:140px;overflow:auto}
      .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
      .btn.primary{background:#111827;color:#fff;border-color:#111827}
    `;
    document.head.appendChild(s);
  }

  aiPanel.style.display = "block";
  aiPanel.innerHTML = `
    <div id="rec-ui">
      <div style="font-weight:700;margin-bottom:.25rem;">AI Helper / Voice Notes</div>

      <div class="rec-row">
        <span class="rec-badge"><span class="rec-dot"></span><span id="rec-status">Idle</span></span>
        <span class="rec-timer" id="rec-timer">00:00</span>
        <div class="rec-meter"><div class="rec-fill" id="rec-fill"></div></div>
        <button class="btn primary" id="voice-note-btn">Record Voice Note</button>
        <button class="btn" id="ai-helper-close">Close</button>
      </div>

      <div style="font-weight:600;margin-top:.25rem;">Transcript (live)</div>
      <div id="rec-txt" class="rec-txt">(speech-to-text will appear here if supported)</div>

      <div style="font-weight:600;margin-top:.5rem;">Output</div>
      <div id="ai-output" style="border:1px solid #e5e7eb;border-radius:10px;padding:8px;background:#fff;"></div>
    </div>
  `;
}

function showAIPanel() {
  ensureRecorderUI();
}

let mediaRec = null;
let chunks = [];
let meterRAF = 0;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let startTs = 0;
let timerId = 0;

// speech recognition
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recActive = false;
let recTextFinal = "";
let recTextInterim = "";

function updateTimer() {
  const ms = Date.now() - startTs;
  const sec = Math.floor(ms / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  const tEl = $("#rec-timer");
  if (tEl) tEl.textContent = `${m}:${s}`;
}

function drawMeter() {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);
  const pct = Math.min(100, Math.max(0, Math.round(rms * 180)));
  const fill = $("#rec-fill");
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.style.background = pct > 60 ? "#ef4444" : pct > 30 ? "#f59e0b" : "#10b981";
  }
  meterRAF = requestAnimationFrame(drawMeter);
}

function setStatus(s) {
  const el = $("#rec-status");
  if (el) el.textContent = s;
}

function setTranscriptBox() {
  const box = $("#rec-txt");
  if (!box) return;
  const text =
    (recTextFinal ? recTextFinal + "\n" : "") +
    (recTextInterim ? "… " + recTextInterim : "");
  box.textContent = text || "(speech-to-text will appear here if supported)";
}

async function startRecording() {
  if (mediaRec) return;
  showAIPanel();

  const btn = $("#voice-note-btn");
  const out = $("#ai-output");
  const txtBox = $("#rec-txt");
  chunks = [];
  recTextFinal = "";
  recTextInterim = "";
  setTranscriptBox();
  out.textContent = "Recording… click Stop to upload.";
  setStatus("Recording");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Audio meter setup
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    sourceNode.connect(analyser);
    meterRAF = requestAnimationFrame(drawMeter);

    // Timer
    startTs = Date.now();
    updateTimer();
    timerId = setInterval(updateTimer, 500);

    // Recorder
    mediaRec = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRec.onstop = async () => {
      try {
        if (!currentThread || !chunks.length) return;
        setStatus("Uploading…");
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Uploading…";
        }
        const activeSession = await ensureMessagesSession();
        if (!activeSession) {
          cleanupRecording(true);
          return;
        }
        const blob = new Blob(chunks, { type: "audio/webm" });
        const fileName = `voice-${Date.now()}.webm`;
        const progressEl = document.createElement("div");
        progressEl.className = "voice-progress";
        progressEl.textContent = "Uploading 0%";
        aiPanel?.appendChild(progressEl);

        // 1) presign
        const { url, key } = await presignUpload({
          contentType: "audio/webm",
          ext: "webm",
          folder: "voice-notes",
          size: blob.size,
          caseId: currentThread,
          contentDisposition: buildContentDisposition(fileName),
        });

        // 2) PUT to S3
        await uploadToS3(url, blob, "audio/webm", (pct) => {
          if (progressEl) progressEl.textContent = `Uploading ${pct.toFixed(0)}%`;
        });

        // 3) create message with fileKey + transcript
        const transcript = (recTextFinal + (recTextInterim ? " " + recTextInterim : "")).trim();
        await createVoiceMessage(currentThread, {
          fileKey: key,
          fileName,
          mimeType: "audio/webm",
          transcript,
        });

        // 4) refresh thread
        const refetch = await j(`${API_BASE}/messages/${currentThread}`);
        renderMessages(currentThread, refetch.messages || []);
        out.textContent = "Voice note added.";
      } catch (e) {
        out.textContent = "Failed to add voice note.";
      } finally {
        const prog = document.querySelector(".voice-progress");
        prog?.remove();
        cleanupRecording();
      }
    };
    mediaRec.start(300);

    // Speech recognition (best-effort)
    if (SpeechRec) {
      rec = new SpeechRec();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = true;

      rec.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) {
            recTextFinal += (recTextFinal ? " " : "") + res[0].transcript.trim();
            recTextInterim = "";
          } else {
            recTextInterim = res[0].transcript.trim();
          }
        }
        setTranscriptBox();
      };
      rec.onend = () => {
        if (recActive) try { rec.start(); } catch {}
      };
      try {
        rec.start();
        recActive = true;
        txtBox && (txtBox.style.opacity = "1");
      } catch {
        // ignore
      }
    } else if (txtBox) {
      txtBox.textContent = "(Speech recognition not supported in this browser.)";
      txtBox.style.opacity = "0.8";
    }

    if (btn) btn.textContent = "Stop";
  } catch {
    const out = $("#ai-output");
    out.textContent = "Mic permission denied or unsupported.";
    cleanupRecording(true);
  }
}

function stopRecording() {
  if (!mediaRec) return;
  try {
    if (rec && recActive) {
      recActive = false;
      try { rec.stop(); } catch {}
    }
    if (mediaRec.state !== "inactive") mediaRec.stop();
  } catch {
    cleanupRecording(true);
  }
}

function cleanupRecording(abort = false) {
  setStatus("Idle");
  cancelAnimationFrame(meterRAF);
  meterRAF = 0;
  clearInterval(timerId);
  timerId = 0;
  const btn = $("#voice-note-btn");
  if (btn) {
    btn.textContent = "Record Voice Note";
    btn.disabled = false;
  }

  try { mediaRec?.stream?.getTracks()?.forEach((t) => t.stop()); } catch {}
  mediaRec = null;
  sourceNode && sourceNode.disconnect?.();
  analyser = null;
  try { audioCtx?.close?.(); } catch {}
  audioCtx = null;

  if (abort) {
    chunks = [];
    const out = $("#ai-output");
    out.textContent = "Recording canceled.";
  }
}

// ---- Wiring -----------------------------------------------------------------
function wireEvents() {
  document.addEventListener("click", (e) => {
    if (e.target.classList?.contains("lp-thread")) openThread(e.target.dataset.id);
    if (e.target.id === "send-btn") sendMessage();

    if (e.target.id === "ai-helper-btn") {
      showAIPanel();
    }
    if (e.target.id === "ai-helper-close") {
      if (mediaRec) stopRecording();
      aiPanel.style.display = "none";
    }

    if (e.target.id === "summarize-btn") {
      sumMenu.style.display = sumMenu.style.display === "none" ? "block" : "none";
    }
    if (e.target.closest?.("#summarize-menu")) {
      const mode = e.target.dataset.mode;
      if (!mode) return;
      sumMenu.style.display = "none";
      if (mode === "daterange") {
        sumStart.style.display = "";
        sumEnd.style.display = "";
      } else {
        sumStart.style.display = "none";
        sumEnd.style.display = "none";
      }
      summarize(mode);
    }

    if (e.target.id === "voice-note-btn") {
      if (!mediaRec) startRecording();
      else stopRecording();
    }
  });

  const searchEl = $("#msg-search");
  if (searchEl) {
    let t;
    searchEl.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => loadThreads(searchEl.value.trim()), 250);
    });
  }

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

async function init() {
  if (!threadListEl || !msgListEl) return;
  await ensureAuthed();
  await loadViewerProfile();
  const threads = await loadThreads();
  const targetId = (pendingJump && pendingJump.caseId) || threads[0]?.id;
  pendingJump = null;
  if (targetId) {
    openThread(targetId);
  }
  bindAttachmentControls();
  wireEvents();
}
document.addEventListener("DOMContentLoaded", init);

function consumeMessageJump() {
  try {
    const raw = sessionStorage.getItem(MESSAGE_JUMP_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MESSAGE_JUMP_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
