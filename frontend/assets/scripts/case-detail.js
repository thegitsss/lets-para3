import { secureFetch, fetchCSRF, showMsg, loadUserHeaderInfo, applyRoleVisibility } from "./auth.js";

const caseList = document.getElementById("caseList");
const caseListStatus = document.getElementById("caseListStatus");
const caseTitle = document.getElementById("caseTitle");
const caseStatusLine = document.getElementById("caseStatusLine");
const caseParticipants = document.getElementById("caseParticipants");
const messageList = document.getElementById("caseMessageList");
const messageScroll = document.querySelector(".message-scroll");
const messageForm = document.getElementById("caseMessageForm");
const messageInput = document.getElementById("caseMessageInput");
const messageStatus = document.getElementById("caseMessageStatus");
const messageAttachment = document.getElementById("message-attachment");
const attachmentStaging = document.getElementById("caseAttachmentStaging");
const messagePanel = document.querySelector(".message-panel");
const dropzoneOverlay = document.getElementById("caseDropzoneOverlay");
const messagePanelTitle = document.getElementById("messagePanelTitle");
const messagePanelSubtitle = document.getElementById("messagePanelSubtitle");
const messagePanelBanner = document.getElementById("messagePanelBanner");
const messagePanelDivider = document.getElementById("messagePanelDivider");
const caseEscrowAmount = document.getElementById("caseEscrowAmount");
const caseEscrowStatus = document.getElementById("caseEscrowStatus");
const caseHireDate = document.getElementById("caseHireDate");
const caseMatterType = document.getElementById("caseMatterType");
const caseDeadlineList = document.getElementById("caseDeadlineList");
const caseSummary = document.getElementById("caseSummary");
const caseTaskList = document.getElementById("caseTaskList");
const caseSharedDocuments = document.getElementById("caseSharedDocuments");
const caseSharedDocumentsEmpty = document.getElementById("caseSharedDocumentsEmpty");
const caseDisputeButton = document.getElementById("caseDisputeButton");
const caseDisputeStatus = document.getElementById("caseDisputeStatus");
const caseCompleteSection = document.getElementById("caseCompleteSection");
const caseCompleteButton = document.getElementById("caseCompleteButton");
const caseCompleteStatus = document.getElementById("caseCompleteStatus");
const caseWithdrawSection = document.getElementById("caseWithdrawSection");
const caseWithdrawNote = document.getElementById("caseWithdrawNote");
const caseWithdrawButton = document.getElementById("caseWithdrawButton");
const caseWithdrawStatus = document.getElementById("caseWithdrawStatus");
const casePausedSection = document.getElementById("casePausedSection");
const casePausedBanner = document.getElementById("casePausedBanner");
const casePartialPayoutButton = document.getElementById("casePartialPayoutButton");
const caseRelistButton = document.getElementById("caseRelistButton");
const casePausedStatus = document.getElementById("casePausedStatus");
const caseThread = document.getElementById("case-messages");
const caseSelect = document.getElementById("case-select");
const caseTabs = document.querySelectorAll(".case-rail-tabs button");
const backButton = document.querySelector("[data-back-button]");
const profileToggle = document.querySelector("[data-profile-toggle]");
const profileMenu = document.querySelector("[data-profile-menu]");
const accountSettingsBtn = document.querySelector("[data-account-settings]");
const logoutTrigger = document.querySelector("[data-logout]");
const caseNavToggles = document.querySelectorAll("[data-case-nav-toggle]");
const caseNavDropdowns = document.querySelectorAll("[data-case-nav-dropdown]");
const caseNavLists = document.querySelectorAll("[data-case-nav-list]");
const caseNavStatuses = document.querySelectorAll("[data-case-nav-status]");

const ATTACHMENT_DB = "lpc_case_attachments";
const ATTACHMENT_STORE = "attachments";
const MESSAGE_POLL_INTERVAL = 3000;
const CASE_STATES = {
  DRAFT: "draft",
  OPEN: "open",
  APPLIED: "applied",
  FUNDED_IN_PROGRESS: "funded_in_progress",
};
const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);
let attachmentDbPromise = null;
let dragDepth = 0;

const state = {
  cases: [],
  caseOptions: [],
  activeCaseId: "",
  unreadByCase: new Map(),
  filter: "active",
  search: "",
  pendingAttachments: [],
  optimisticDocuments: [],
  caseDocumentsById: new Map(),
  messageCacheByCase: new Map(),
  messageSnapshots: new Map(),
  documentSnapshots: new Map(),
  taskSnapshots: new Map(),
  pendingRealtime: { messages: false, documents: false, tasks: false },
  caseEventSource: null,
  caseStreamActive: false,
  messagePollTimer: null,
  messagePolling: false,
  sending: false,
  completing: false,
  disputing: false,
  workspaceEnabled: false,
  activeCase: null,
  forceScrollToBottom: false,
  completionOverlayActive: false,
  completionOverlayCaseId: "",
  completionOverlayTimer: null,
  completionOverlayCountdown: null,
  completionOverlayNode: null,
  withdrawing: false,
  rejecting: false,
  partialPayoutSubmitting: false,
  relisting: false,
};

let taskUpdateInFlight = false;
let releaseFundsAnimationTimer = null;
let taskLockWatcherBound = false;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
});
const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
});

const PAYMENT_METHOD_UPDATE_MESSAGE = "Payment method needs to be updated before funds can be released.";
const POPUP_ANIMATION_MS = 180;

function mountPopupOverlay(overlay) {
  if (!overlay) return;
  requestAnimationFrame(() => {
    if (overlay.isConnected) overlay.classList.add("is-visible");
  });
}

function dismissPopupOverlay(overlay) {
  if (!overlay || !overlay.isConnected) return;
  overlay.classList.remove("is-visible");
  window.setTimeout(() => {
    if (overlay.isConnected) overlay.remove();
  }, POPUP_ANIMATION_MS);
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return timeFormatter.format(date);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date);
}

function formatDateTime(value) {
  if (!value) return "-";
  const dateText = formatDate(value);
  const timeText = formatTime(value);
  if (dateText && timeText) return `${dateText} at ${timeText}`;
  return dateText || timeText || "-";
}

function getMessageInputMaxHeight() {
  if (!messageInput) return 0;
  const computed = window.getComputedStyle(messageInput);
  const max = parseFloat(computed.maxHeight || "");
  return Number.isFinite(max) && max > 0 ? max : 88;
}

function autoResizeMessageInput() {
  if (!messageInput) return;
  messageInput.style.height = "auto";
  const maxHeight = getMessageInputMaxHeight();
  const nextHeight = Math.min(messageInput.scrollHeight, maxHeight);
  messageInput.style.height = `${nextHeight}px`;
  messageInput.style.overflowY = messageInput.scrollHeight > maxHeight ? "auto" : "hidden";
}

function formatFileType({ fileName, mimeType } = {}) {
  const ext = getFileExtension(fileName);
  if (ext) return `${ext.toUpperCase()} file`;
  const mime = String(mimeType || "").trim();
  return mime || "Document";
}

function formatCurrency(amount, currency = "USD") {
  if (!Number.isFinite(amount)) return "-";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function emptyNode(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function shouldAutoScroll() {
  if (!messageScroll) return true;
  const threshold = 120;
  const remaining = messageScroll.scrollHeight - messageScroll.scrollTop - messageScroll.clientHeight;
  return remaining < threshold;
}

function scrollMessagesToBottom({ behavior = "auto" } = {}) {
  if (!messageScroll) return;
  messageScroll.scrollTo({
    top: messageScroll.scrollHeight,
    behavior,
  });
}

function openAttachmentDB() {
  if (attachmentDbPromise) return attachmentDbPromise;
  if (!("indexedDB" in window)) {
    attachmentDbPromise = Promise.resolve(null);
    return attachmentDbPromise;
  }
  attachmentDbPromise = new Promise((resolve) => {
    const request = indexedDB.open(ATTACHMENT_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATTACHMENT_STORE)) {
        const store = db.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
        store.createIndex("caseId", "caseId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return attachmentDbPromise;
}

async function saveAttachmentRecord(record) {
  const db = await openAttachmentDB();
  if (!db) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
    tx.objectStore(ATTACHMENT_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function removeAttachmentRecord(id) {
  const db = await openAttachmentDB();
  if (!db) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
    tx.objectStore(ATTACHMENT_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function listAttachmentRecords(caseId) {
  const db = await openAttachmentDB();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACHMENT_STORE, "readonly");
    const store = tx.objectStore(ATTACHMENT_STORE);
    const index = store.index("caseId");
    const request = index.getAll(caseId);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getCaseId(item) {
  if (!item) return "";
  return String(item?.id || item?._id || item?.caseId || "");
}

async function parseJSON(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchJSON(url, options = {}) {
  const res = await secureFetch(url, options);
  const data = await parseJSON(res);
  if (!res.ok) {
    const message =
      data?.error ||
      data?.msg ||
      data?.message ||
      `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function shouldFallback(err) {
  return err && (err.status === 404 || err.status === 405);
}

async function fetchWithFallback(urls, options = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await fetchJSON(url, options);
    } catch (err) {
      lastError = err;
      if (!shouldFallback(err)) {
        throw err;
      }
    }
  }
  if (lastError) throw lastError;
  throw new Error("Request failed");
}

function normalizeCaseList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.cases)) return payload.cases;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeMessages(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeDocuments(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.files)) return payload.files;
  if (Array.isArray(payload?.caseFiles)) return payload.caseFiles;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function getDocumentCaseId(documentData) {
  if (!documentData) return "";
  return String(documentData?.caseId || documentData?.case_id || documentData?.case || "");
}

function getDocumentKey(documentData) {
  if (!documentData) return "";
  const id = documentData?.id || documentData?._id;
  if (id) return `id:${id}`;
  const storageKey = documentData?.storageKey || documentData?.key || documentData?.previewKey;
  if (storageKey) return `key:${storageKey}`;
  const name = documentData?.originalName || documentData?.filename || documentData?.name || "";
  const created = documentData?.createdAt || documentData?.uploadedAt || documentData?.created || "";
  if (name || created) return `meta:${name}:${created}`;
  return "";
}

function mergeDocuments(primary = [], secondary = []) {
  const output = [];
  const seen = new Set();
  const pushUnique = (doc) => {
    if (!doc) return;
    const key = getDocumentKey(doc);
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    output.push(doc);
  };
  (primary || []).forEach(pushUnique);
  (secondary || []).forEach(pushUnique);
  return output;
}

function addOptimisticDocument(documentData, caseId) {
  if (!documentData) return;
  const normalized = {
    ...documentData,
    caseId: documentData.caseId || caseId,
  };
  const key = getDocumentKey(normalized);
  if (!key) return;
  if (!Array.isArray(state.optimisticDocuments)) {
    state.optimisticDocuments = [];
  }
  if (state.optimisticDocuments.some((doc) => getDocumentKey(doc) === key)) return;
  state.optimisticDocuments.unshift(normalized);
}

function getOptimisticDocumentsForCase(caseId) {
  if (!Array.isArray(state.optimisticDocuments) || !state.optimisticDocuments.length) return [];
  const targetId = String(caseId || "");
  return state.optimisticDocuments.filter((doc) => getDocumentCaseId(doc) === targetId);
}

function pruneOptimisticDocuments(optimistic = [], serverDocuments = [], caseId) {
  if (!optimistic.length) return optimistic;
  const targetId = String(caseId || "");
  const serverKeys = new Set(
    (serverDocuments || [])
      .map((doc) => getDocumentKey(doc))
      .filter(Boolean)
  );
  return optimistic.filter((doc) => {
    const docCaseId = getDocumentCaseId(doc);
    if (targetId && docCaseId && docCaseId !== targetId) return true;
    const key = getDocumentKey(doc);
    if (!key) return true;
    return !serverKeys.has(key);
  });
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

function isEscrowFunded(caseData) {
  const escrowStatus = String(caseData?.escrowStatus || "").toLowerCase();
  return !!caseData?.escrowIntentId && escrowStatus === "funded";
}

function hasAssignedParalegal(caseData) {
  return !!(caseData?.paralegal || caseData?.paralegalId);
}

function resolveRemainingAmount(caseData) {
  if (!caseData) return 0;
  if (Number.isFinite(caseData?.remainingAmount)) return Math.max(0, Math.round(caseData.remainingAmount));
  const base = Number(caseData?.lockedTotalAmount ?? caseData?.totalAmount ?? 0);
  if (!Number.isFinite(base) || base <= 0) return null;
  const paid = Number(caseData?.partialPayoutAmount ?? 0);
  if (!Number.isFinite(paid) || paid <= 0) return Math.round(base);
  return Math.max(0, Math.round(base - paid));
}

function getWithdrawnParalegalId(caseData) {
  if (!caseData) return "";
  const raw = caseData.withdrawnParalegalId;
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return String(raw._id || raw.id || "");
}

function isWithdrawalCase(caseData) {
  if (!caseData) return false;
  const reason = String(caseData?.pausedReason || "").toLowerCase();
  if (reason === "paralegal_withdrew" || reason === "dispute") return true;
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (statusKey === "paused" || statusKey === "disputed") {
    return !!getWithdrawnParalegalId(caseData);
  }
  return false;
}

function isDisputeWindowActive(caseData) {
  if (!caseData?.disputeDeadlineAt) return false;
  const deadline = new Date(caseData.disputeDeadlineAt).getTime();
  if (Number.isNaN(deadline)) return false;
  return Date.now() < deadline;
}

function isWithdrawnViewer(caseData) {
  const viewerId = getCurrentUserId();
  const withdrawnId = getWithdrawnParalegalId(caseData);
  if (!viewerId || !withdrawnId) return false;
  if (String(viewerId) !== String(withdrawnId)) return false;
  const assignedId = normalizeUserId(caseData?.paralegal || caseData?.paralegalId);
  if (assignedId && String(assignedId) === String(viewerId)) return false;
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (["paused", "disputed"].includes(statusKey)) return true;
  if (caseData?.pausedReason === "paralegal_withdrew" || caseData?.pausedReason === "dispute") return true;
  return false;
}

function countCompletedTasks(caseData) {
  const tasks = getCaseTasks(caseData);
  return tasks.reduce((count, task) => count + (isTaskCompleted(task) ? 1 : 0), 0);
}

function canRequestWithdrawal(caseData) {
  if (getCurrentUserRole() !== "paralegal") return false;
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (["paused", "disputed", "completed", "closed"].includes(statusKey)) return false;
  const viewerId = getCurrentUserId();
  const assignedId = normalizeUserId(caseData?.paralegal || caseData?.paralegalId);
  if (!viewerId || !assignedId || String(viewerId) !== String(assignedId)) return false;
  if (areAllTasksComplete(caseData)) return false;
  return true;
}

function canOpenDisputeFromCase(caseData) {
  return false;
}

function formatCaseStatus(value, caseData = {}) {
  const key = normalizeCaseStatus(value);
  const isDisputed = key === "disputed" || caseData?.terminationStatus === "disputed";
  if (isDisputed) return "Disputed";
  if (key === "in progress") return "In Progress";
  if (key === "completed") return "Completed";
  if (key === "closed") return "Closed";
  if (!key || key === "open") return "Posted";
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ensureCompleteModalStyles() {
  if (document.getElementById("case-complete-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "case-complete-modal-styles";
  style.textContent = `
    .case-complete-overlay{
      position:fixed;
      inset:0;
      background:rgba(15,23,42,.45);
      display:flex;
      align-items:center;
      justify-content:center;
      z-index:2300;
      padding:18px;
      opacity:0;
      transition:opacity .18s ease;
    }
    .case-complete-modal{
      width:min(520px,92vw);
      background:var(--app-surface);
      color:var(--app-text);
      border:1px solid var(--app-border-soft);
      border-radius:18px;
      padding:20px 22px;
      box-shadow:0 24px 50px rgba(0,0,0,.2);
      display:grid;
      gap:12px;
      opacity:0;
      transform:translateY(4px);
      transition:opacity .18s ease, transform .18s ease;
    }
    .case-complete-overlay.is-visible{
      opacity:1;
    }
    .case-complete-overlay.is-visible .case-complete-modal{
      opacity:1;
      transform:translateY(0) scale(1);
    }
    .case-complete-title{
      margin:0;
      font-family:var(--font-serif);
      font-weight:300;
      font-size:1.3rem;
      letter-spacing:.02em;
      text-align:center;
    }
    .case-complete-modal p{
      margin:0;
      color:var(--app-muted);
      font-size:.92rem;
      line-height:1.55;
    }
    .case-complete-actions{
      display:flex;
      justify-content:center;
      gap:10px;
      margin-top:8px;
      flex-wrap:wrap;
    }
    .case-complete-actions .case-action-btn{
      border-radius:999px;
      padding:0.55rem 1.4rem;
      font-size:.9rem;
      font-weight:250;
      border:1px solid var(--app-border);
      background:var(--app-surface);
      color:var(--app-text);
      transition:background .2s ease,color .2s ease,border-color .2s ease,transform .15s ease;
    }
    .case-complete-actions .case-action-btn:hover{
      transform:translateY(-1px);
    }
    .case-complete-actions .case-action-btn.secondary:hover{
      border-color:var(--app-accent);
      color:var(--app-accent);
      background:var(--app-surface);
    }
    .case-complete-actions [data-complete-confirm]{
      background:var(--app-accent);
      border-color:var(--app-accent);
      color:var(--app-surface);
    }
    .case-complete-actions [data-complete-confirm]:hover{
      background:#9a8459;
      border-color:#9a8459;
      color:#fff;
    }
    body.theme-dark .case-complete-actions .case-action-btn.secondary{
      background:transparent;
      color:#f8fbff;
      border-color:rgba(255,255,255,.25);
    }
    body.theme-dark .case-complete-actions .case-action-btn.secondary:hover{
      border-color:var(--app-accent);
      color:var(--app-accent);
    }
  `;
  document.head.appendChild(style);
}

function ensureParalegalCompletionOverlayStyles() {
  if (document.getElementById("paralegal-completion-overlay-styles")) return;
  const style = document.createElement("style");
  style.id = "paralegal-completion-overlay-styles";
  style.textContent = `
    .case-completion-overlay{
      position:fixed;
      inset:0;
      display:flex;
      align-items:center;
      justify-content:center;
      z-index:2400;
      padding:24px;
      opacity:0;
      transition:opacity .2s ease;
    }
    .case-completion-overlay::before{
      content:"";
      position:absolute;
      inset:0;
      background:rgba(10, 15, 25, 0.6);
    }
    .case-completion-modal{
      width:min(420px,92vw);
      background:#ffffff;
      border-radius:18px;
      overflow:hidden;
      box-shadow:0 24px 60px rgba(15,23,42,.35);
      text-align:center;
      position:relative;
      z-index:1;
      opacity:0;
      transform:translateY(6px);
      transition:opacity .2s ease, transform .2s ease;
    }
    .case-completion-overlay.is-visible{
      opacity:1;
    }
    .case-completion-overlay.is-visible .case-completion-modal{
      opacity:1;
      transform:translateY(0) scale(1);
    }
    .case-completion-hero{
      height:150px;
      background-image:url("hero-mountain.jpg");
      background-size:cover;
      background-position:center;
    }
    .case-completion-content{
      padding:22px 26px 26px;
    }
    .case-completion-title{
      margin:0 0 8px;
      font-family:var(--font-serif);
      font-size:1.6rem;
      color:#102c50;
      font-weight:500;
    }
    .case-completion-body{
      margin:0 0 18px;
      color:var(--app-muted);
      font-size:.98rem;
      line-height:1.5;
    }
    .case-completion-actions{
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      justify-content:center;
    }
    .case-completion-btn{
      border:1px solid transparent;
      background:var(--app-accent);
      color:#ffffff;
      padding:10px 20px;
      border-radius:999px;
      font-weight:300;
      cursor:pointer;
      transition:transform .2s ease, box-shadow .2s ease, background .2s ease;
      box-shadow:0 12px 24px rgba(182, 164, 122, 0.35);
    }
    .case-completion-btn:hover{
      transform:translateY(-1px);
    }
    .case-completion-timer{
      margin:12px 0 0;
      color:var(--app-muted);
      font-size:.85rem;
    }
  `;
  document.head.appendChild(style);
}

function ensureDocumentPreviewStyles() {
  if (document.getElementById("document-preview-styles")) return;
  const style = document.createElement("style");
  style.id = "document-preview-styles";
  style.textContent = `
    .document-preview-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:2300;padding:18px;opacity:0;transition:opacity .18s ease}
    .document-preview-modal{background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:16px;width:min(420px,92vw);box-shadow:0 24px 50px rgba(0,0,0,.2);display:flex;flex-direction:column;gap:16px;padding:18px;opacity:0;transform:translateY(4px);transition:opacity .18s ease, transform .18s ease}
    .document-preview-overlay.is-visible{opacity:1}
    .document-preview-overlay.is-visible .document-preview-modal{opacity:1;transform:translateY(0) scale(1)}
    .document-preview-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .document-preview-title{font-weight:300;font-size:1.05rem;word-break:break-word}
    .document-preview-close{border:1px solid var(--app-border-soft);background:var(--app-surface);color:var(--app-muted);border-radius:10px;padding:6px 10px;cursor:pointer}
    .document-preview-meta{display:grid;gap:10px;margin:0}
    .document-preview-meta div{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
    .document-preview-meta dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--app-muted)}
    .document-preview-meta dd{margin:0;font-size:.95rem;font-weight:250;text-align:right}
    .document-preview-actions{display:flex;justify-content:flex-end;gap:10px}
    .document-open-btn{background:var(--app-accent);color:var(--app-surface);border:none;border-radius:10px;padding:8px 14px;cursor:pointer;font-weight:250;text-decoration:none}
    .document-open-btn[aria-disabled="true"]{opacity:.6;cursor:not-allowed;pointer-events:none}
  `;
  document.head.appendChild(style);
}

function openDocumentPreview({
  fileName,
  viewUrl,
  mimeType,
  caseId,
  storageKey,
  uploadedAt,
  uploaderName,
} = {}) {
  ensureDocumentPreviewStyles();
  const overlay = document.createElement("div");
  overlay.className = "document-preview-overlay";
  const modal = document.createElement("div");
  modal.className = "document-preview-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const header = document.createElement("header");
  header.className = "document-preview-header";
  const title = document.createElement("div");
  title.className = "document-preview-title";
  title.id = "documentPreviewTitle";
  title.textContent = fileName || "Document";
  modal.setAttribute("aria-labelledby", title.id);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "document-preview-close";
  closeBtn.textContent = "Close";
  header.append(title, closeBtn);

  const meta = document.createElement("dl");
  meta.className = "document-preview-meta";
  meta.append(
    buildDefinition("Type", formatFileType({ fileName, mimeType })),
    buildDefinition("Uploaded by", uploaderName || "Unknown"),
    buildDefinition("Uploaded", formatDateTime(uploadedAt))
  );

  const actions = document.createElement("div");
  actions.className = "document-preview-actions";
  const openBtn = document.createElement("a");
  openBtn.className = "document-open-btn";
  openBtn.textContent = "Open document";
  openBtn.target = "_blank";
  openBtn.rel = "noopener";
  if (viewUrl) {
    openBtn.href = viewUrl;
  } else {
    openBtn.href = "#";
    openBtn.setAttribute("aria-disabled", "true");
  }
  actions.appendChild(openBtn);

  modal.append(header, meta, actions);
  overlay.appendChild(modal);

  const close = () => {
    document.removeEventListener("keydown", handleKeydown);
    dismissPopupOverlay(overlay);
  };
  const handleKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", handleKeydown);

  document.body.appendChild(overlay);
  mountPopupOverlay(overlay);

  if (!viewUrl && caseId && storageKey) {
    getSignedViewUrl({ caseId, storageKey }).then((signedUrl) => {
      if (!signedUrl) return;
      openBtn.href = signedUrl;
      openBtn.removeAttribute("aria-disabled");
    });
  }
}

function openCompleteConfirmModal() {
  return new Promise((resolve) => {
    ensureCompleteModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-complete-overlay";
    overlay.innerHTML = `
      <div class="case-complete-modal" role="dialog" aria-modal="true" aria-labelledby="caseCompleteTitle">
        <div class="case-complete-title" id="caseCompleteTitle">Complete &amp; Release Funds</div>
        <p>Confirming will release case funds to the paralegal, lock messaging and file uploads, and archive the case. You can view the case and its contents in your Archive.</p>
        <div class="case-complete-actions">
          <button class="case-action-btn secondary" type="button" data-complete-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-complete-confirm>Complete &amp; Release Funds</button>
        </div>
      </div>
    `;
    const close = (confirmed) => {
      dismissPopupOverlay(overlay);
      resolve(confirmed);
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    overlay.querySelector("[data-complete-cancel]")?.addEventListener("click", () => close(false));
    overlay.querySelector("[data-complete-confirm]")?.addEventListener("click", () => close(true));
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close(false);
      },
      { once: true }
    );
    document.body.appendChild(overlay);
    mountPopupOverlay(overlay);
  });
}

function ensureDisputeModalStyles() {
  if (document.getElementById("case-dispute-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "case-dispute-modal-styles";
  style.textContent = `
    .case-dispute-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;transition:opacity .18s ease}
    .case-dispute-modal{background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:16px;padding:24px;max-width:520px;width:92%;box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:12px;opacity:0;transform:translateY(4px);transition:opacity .18s ease, transform .18s ease}
    .case-dispute-overlay.is-visible{opacity:1}
    .case-dispute-overlay.is-visible .case-dispute-modal{opacity:1;transform:translateY(0) scale(1)}
    .case-dispute-title{font-weight:600;font-size:1.2rem}
    .case-dispute-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
    .case-dispute-modal textarea{width:100%;min-height:88px;border-radius:12px;border:1px solid var(--app-border-soft);padding:10px 12px;font-family:var(--font-sans);resize:vertical}
  `;
  document.head.appendChild(style);
}

function openDisputeConfirmModal() {
  return new Promise((resolve) => {
    ensureDisputeModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-dispute-overlay";
    overlay.innerHTML = `
      <div class="case-dispute-modal" role="dialog" aria-modal="true" aria-labelledby="caseDisputeTitle">
        <div class="case-dispute-title" id="caseDisputeTitle">Flag a Dispute</div>
        <p>Confirming will pause this workspace for both parties until an admin resolves the dispute.</p>
        <label>
          <span class="visually-hidden">Dispute details</span>
          <textarea data-dispute-message placeholder="Add a short reason (optional)"></textarea>
        </label>
        <div class="case-dispute-actions">
          <button class="case-action-btn secondary" type="button" data-dispute-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-dispute-confirm>Flag dispute</button>
        </div>
      </div>
    `;
    const close = (confirmed) => {
      dismissPopupOverlay(overlay);
      if (!confirmed) {
        resolve({ confirmed: false, message: "" });
        return;
      }
      const message = overlay.querySelector("[data-dispute-message]")?.value || "";
      resolve({ confirmed: true, message });
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    overlay.querySelector("[data-dispute-cancel]")?.addEventListener("click", () => close(false));
    overlay.querySelector("[data-dispute-confirm]")?.addEventListener("click", () => close(true));
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close(false);
      },
      { once: true }
    );
    document.body.appendChild(overlay);
    mountPopupOverlay(overlay);
  });
}

function ensureWithdrawalModalStyles() {
  if (document.getElementById("case-withdraw-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "case-withdraw-modal-styles";
  style.textContent = `
    .case-withdraw-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;transition:opacity .18s ease}
    .case-withdraw-modal{background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:16px;padding:24px;max-width:520px;width:92%;box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:12px;opacity:0;transform:translateY(4px);transition:opacity .18s ease, transform .18s ease}
    .case-withdraw-overlay.is-visible{opacity:1}
    .case-withdraw-overlay.is-visible .case-withdraw-modal{opacity:1;transform:translateY(0) scale(1)}
    .case-withdraw-title{font-weight:600;font-size:1.2rem}
    .case-withdraw-title{text-align:center}
    .case-withdraw-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
  `;
  document.head.appendChild(style);
}

function openWithdrawalConfirmModal({ completedCount = 0, totalTasks = 0 } = {}) {
  return new Promise((resolve) => {
    ensureWithdrawalModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-withdraw-overlay";
    const bodyCopy =
      completedCount === 0
        ? "Withdrawing will pause the case. A $0 payout will be issued since no tasks were completed."
        : "Withdrawing will close this case for you. You will no longer be able to submit work on this matter.";
    overlay.innerHTML = `
      <div class="case-withdraw-modal" role="dialog" aria-modal="true" aria-labelledby="caseWithdrawTitle">
        <div class="case-withdraw-title" id="caseWithdrawTitle">Withdraw from Case</div>
        <p>${bodyCopy}</p>
        <div class="case-withdraw-actions">
          <button class="case-action-btn secondary" type="button" data-withdraw-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-withdraw-confirm>Withdraw from Case</button>
        </div>
      </div>
    `;
    const close = (confirmed) => {
      dismissPopupOverlay(overlay);
      resolve(confirmed);
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    overlay.querySelector("[data-withdraw-cancel]")?.addEventListener("click", () => close(false));
    overlay.querySelector("[data-withdraw-confirm]")?.addEventListener("click", () => close(true));
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close(false);
      },
      { once: true }
    );
    document.body.appendChild(overlay);
    mountPopupOverlay(overlay);
  });
}

function ensurePartialPayoutModalStyles() {
  if (document.getElementById("case-payout-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "case-payout-modal-styles";
  style.textContent = `
    .case-payout-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;transition:opacity .18s ease}
    .case-payout-modal{background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:16px;padding:24px;max-width:520px;width:92%;box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:12px;opacity:0;transform:translateY(4px);transition:opacity .18s ease, transform .18s ease}
    .case-payout-overlay.is-visible{opacity:1}
    .case-payout-overlay.is-visible .case-payout-modal{opacity:1;transform:translateY(0) scale(1)}
    .case-payout-title{font-weight:600;font-size:1.2rem}
    .case-payout-input{display:grid;gap:6px}
    .case-payout-input input{width:100%;border-radius:10px;border:1px solid var(--app-border-soft);padding:10px 12px;font-family:var(--font-sans)}
    .case-payout-hint{font-size:.82rem;color:var(--app-muted)}
    .case-payout-error{font-size:.82rem;color:#b91c1c;min-height:1.1em}
    .case-payout-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
  `;
  document.head.appendChild(style);
}

function parseCurrencyInput(value) {
  if (value == null) return NaN;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned) return NaN;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return NaN;
  return Math.round(amount * 100);
}

function openPartialPayoutModal({ maxCents = 0, currency = "USD" } = {}) {
  return new Promise((resolve) => {
    ensurePartialPayoutModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-payout-overlay";
    const maxLabel = formatCurrency(maxCents / 100, currency);
    overlay.innerHTML = `
      <div class="case-payout-modal" role="dialog" aria-modal="true" aria-labelledby="casePayoutTitle">
        <div class="case-payout-title" id="casePayoutTitle">Enter Partial Payout</div>
        <p>Enter the payout amount for the withdrawn paralegal. This will finalize their withdrawal.</p>
        <label class="case-payout-input">
          <span class="case-payout-hint">Max available: ${maxLabel}</span>
          <input type="text" inputmode="decimal" placeholder="0.00" data-payout-input />
        </label>
        <div class="case-payout-error" data-payout-error></div>
        <div class="case-payout-actions">
          <button class="case-action-btn secondary" type="button" data-payout-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-payout-confirm>Confirm Payout</button>
        </div>
      </div>
    `;
    const input = overlay.querySelector("[data-payout-input]");
    const error = overlay.querySelector("[data-payout-error]");
    const confirmBtn = overlay.querySelector("[data-payout-confirm]");

    const updateState = () => {
      const amountCents = parseCurrencyInput(input?.value || "");
      let message = "";
      if (!Number.isFinite(amountCents)) {
        message = "Enter a valid amount.";
      } else if (amountCents < 0) {
        message = "Amount cannot be negative.";
      } else if (amountCents > maxCents) {
        message = "Amount exceeds the remaining case balance.";
      }
      if (error) error.textContent = message;
      if (confirmBtn) confirmBtn.disabled = !!message;
    };

    const close = (amountCents) => {
      dismissPopupOverlay(overlay);
      resolve(amountCents);
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
    overlay.querySelector("[data-payout-cancel]")?.addEventListener("click", () => close(null));
    overlay.querySelector("[data-payout-confirm]")?.addEventListener("click", () => {
      const amountCents = parseCurrencyInput(input?.value || "");
      if (!Number.isFinite(amountCents)) {
        updateState();
        return;
      }
      if (amountCents < 0 || amountCents > maxCents) {
        updateState();
        return;
      }
      close(amountCents);
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close(null);
      },
      { once: true }
    );
    if (input) {
      input.addEventListener("input", updateState);
      input.addEventListener("blur", updateState);
      input.focus();
    }
    updateState();
    document.body.appendChild(overlay);
    mountPopupOverlay(overlay);
  });
}

function ensureRejectPayoutModalStyles() {
  if (document.getElementById("case-reject-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "case-reject-modal-styles";
  style.textContent = `
    .case-reject-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;transition:opacity .18s ease}
    .case-reject-modal{background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:16px;padding:24px;max-width:520px;width:92%;box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:12px;opacity:0;transform:translateY(4px);transition:opacity .18s ease, transform .18s ease}
    .case-reject-overlay.is-visible{opacity:1}
    .case-reject-overlay.is-visible .case-reject-modal{opacity:1;transform:translateY(0)}
    .case-reject-title{font-weight:600;font-size:1.2rem;text-align:center}
    .case-reject-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
  `;
  document.head.appendChild(style);
}

function openRejectPayoutConfirmModal() {
  return new Promise((resolve) => {
    ensureRejectPayoutModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-reject-overlay";
    overlay.innerHTML = `
      <div class="case-reject-modal" role="dialog" aria-modal="true" aria-labelledby="caseRejectTitle">
        <div class="case-reject-title" id="caseRejectTitle">Close Without Release</div>
        <p>Closing without release will pause the case for 24 hours before it becomes eligible to be relisted.</p>
        <div class="case-reject-actions">
          <button class="case-action-btn secondary" type="button" data-reject-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-reject-confirm>Close Without Release</button>
        </div>
      </div>
    `;
    const close = (confirmed) => {
      dismissPopupOverlay(overlay);
      resolve(confirmed);
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    overlay.querySelector("[data-reject-cancel]")?.addEventListener("click", () => close(false));
    overlay.querySelector("[data-reject-confirm]")?.addEventListener("click", () => close(true));
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close(false);
      },
      { once: true }
    );
    document.body.appendChild(overlay);
    mountPopupOverlay(overlay);
  });
}

function ensureFlagMenuStyles() {
  if (document.getElementById("case-flag-menu-styles")) return;
  const style = document.createElement("style");
  style.id = "case-flag-menu-styles";
  style.textContent = `
    .case-flag-overlay{
      position:fixed;
      inset:0;
      background:radial-gradient(circle at top, rgba(15,23,42,.35), rgba(15,23,42,.65));
      display:flex;
      align-items:center;
      justify-content:center;
      z-index:1500;
      padding:18px;
      opacity:0;
      transition:opacity .2s ease;
    }
    .case-flag-modal{
      background:var(--app-surface, #ffffff);
      color:var(--app-text, #111827);
      border:1px solid var(--app-border, rgba(15,23,42,.12));
      border-radius:18px;
      padding:22px 22px 18px;
      max-width:420px;
      width:100%;
      box-shadow:0 24px 60px rgba(0,0,0,.28);
      display:grid;
      gap:12px;
      position:relative;
      opacity:0;
      transform:translateY(6px);
      transition:opacity .2s ease, transform .2s ease;
    }
    .case-flag-modal::before{
      content:"";
      position:absolute;
      inset:0;
      border-radius:inherit;
      background:linear-gradient(135deg, rgba(197,168,117,.08), transparent 55%);
      pointer-events:none;
    }
    .case-flag-title{
      font-weight:600;
      font-size:1.15rem;
      letter-spacing:.01em;
      text-align:center;
    }
    .case-flag-actions{
      display:grid;
      gap:10px;
    }
    .case-flag-actions .case-action-btn{
      text-align:left;
      padding:12px 14px;
      border-radius:12px;
      font-weight:600;
      display:flex;
      align-items:center;
      justify-content:space-between;
      background:var(--app-surface-contrast, rgba(15,23,42,.04));
      border:1px solid var(--app-border-soft, rgba(15,23,42,.08));
      color:inherit;
      transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    }
    .case-flag-actions .case-action-btn.secondary{
      background:transparent;
    }
    .case-flag-actions .case-action-btn:hover{
      transform:translateY(-1px);
      box-shadow:0 10px 24px rgba(15,23,42,.12);
    }
    .case-flag-actions .case-action-btn:disabled{
      opacity:.55;
      cursor:not-allowed;
      transform:none;
      box-shadow:none;
    }
    .case-flag-actions .case-action-btn::after{
      content:"→";
      font-size:.95rem;
      opacity:.7;
    }
    .case-flag-actions .case-action-btn.secondary::after{
      content:"";
    }
    .case-flag-muted{
      font-size:.86rem;
      color:var(--app-muted, rgba(15,23,42,.6));
      line-height:1.45;
    }
    .case-flag-info{
      font-size:.9rem;
      color:var(--app-muted, rgba(15,23,42,.65));
      line-height:1.5;
    }
    .case-flag-overlay.is-visible{
      opacity:1;
    }
    .case-flag-overlay.is-visible .case-flag-modal{
      opacity:1;
      transform:translateY(0) scale(1);
    }
    @media (prefers-reduced-motion: reduce){
      .case-flag-actions .case-action-btn{
        transition:none;
      }
    }
  `;
  document.head.appendChild(style);
}

function openParalegalFlagMenu(caseData) {
  return new Promise((resolve) => {
    ensureFlagMenuStyles();
    const canWithdraw = canRequestWithdrawal(caseData);
    const canDispute = canOpenDisputeFromCase(caseData);
    const overlay = document.createElement("div");
    overlay.className = "case-flag-overlay";
    const options = [];
    if (canWithdraw) {
      options.push(
        `<button type="button" class="case-action-btn" data-flag-action="withdraw">Withdraw from Case</button>`
      );
    }
    if (canDispute) {
      options.push(
        `<button type="button" class="case-action-btn secondary" data-flag-action="dispute">Open Dispute</button>`
      );
    }
    const emptyCopy = !options.length
      ? `<p class="case-flag-muted">No actions are available right now.</p>`
      : "";
    overlay.innerHTML = `
      <div class="case-flag-modal" role="dialog" aria-modal="true" aria-labelledby="caseFlagTitle">
        <div class="case-flag-title" id="caseFlagTitle">Case Actions</div>
        ${emptyCopy}
        <div class="case-flag-actions">
          ${options.join("")}
          <button type="button" class="case-action-btn secondary" data-flag-action="cancel">Cancel</button>
        </div>
      </div>
    `;
    const close = (action) => {
      dismissPopupOverlay(overlay);
      resolve(action);
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close("cancel");
    });
    overlay.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-flag-action]");
      if (!btn) return;
      const action = btn.dataset.flagAction || "cancel";
      close(action);
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close("cancel");
      },
      { once: true }
    );
    document.body.appendChild(overlay);
    mountPopupOverlay(overlay);
  });
}

function getAttorneyWithdrawalActionState(caseData) {
  const statusKey = normalizeCaseStatus(caseData?.status);
  const eligible = isWithdrawalCase(caseData) && (statusKey === "paused" || statusKey === "disputed");
  if (!eligible) {
    return {
      eligible: false,
      bannerText: "",
      statusText: "",
      showPartial: false,
      showReject: false,
      showRelist: false,
      disablePartial: false,
      disableReject: false,
      disableRelist: false,
    };
  }
  const completedCount = countCompletedTasks(caseData);
  const totalTasks = getCaseTasks(caseData).length;
  const holdActive = isDisputeWindowActive(caseData);
  const payoutFinalized = !!caseData?.payoutFinalizedAt;
  const partialCents = Number(caseData?.partialPayoutAmount || 0);
  const currency = String(caseData?.currency || "USD").toUpperCase();
  let remainingCents = resolveRemainingAmount(caseData);
  if (!Number.isFinite(remainingCents)) {
    remainingCents = Number(caseData?.lockedTotalAmount ?? caseData?.totalAmount ?? 0);
  }
  const remainingLabel = formatCurrency(remainingCents / 100, currency);

  let bannerText = "";
  let statusText = "";
  let showPartial = false;
  let showReject = false;
  let disablePartial = false;
  let disableReject = false;
  let disableRelist = false;

  if (statusKey === "disputed" || caseData?.pausedReason === "dispute") {
    bannerText = "Workspace paused - Paralegal requested admin assistance. We'll resolve this within 24 hours.";
    disablePartial = true;
    disableReject = true;
    disableRelist = true;
  } else if (payoutFinalized) {
    const payoutLabel = formatCurrency(partialCents / 100, currency);
    bannerText = `Withdrawal finalized. Payout: ${payoutLabel}. Remaining balance: ${remainingLabel}.`;
    statusText = caseData?.relistRequestedAt
      ? "Case relisted and ready for hiring."
      : "Relist the case to invite new applicants.";
  } else if (holdActive) {
    bannerText =
      "Closing without release will pause the case for 24 hours before it becomes eligible to be relisted.";
    disablePartial = true;
    disableReject = true;
  } else if (completedCount === 0) {
    bannerText = "Paralegal withdrew before any tasks were completed. A $0 payout was issued.";
    statusText = caseData?.relistRequestedAt
      ? "Case relisted and ready for hiring."
      : "Relist the case to invite new applicants.";
  } else if (completedCount > 0 && completedCount < totalTasks) {
    bannerText =
      "Paralegal withdrew. Please choose a partial payout or close without release. Case will relist automatically with adjusted balance, if applicable.";
    showPartial = true;
    showReject = true;
  } else {
    bannerText = "Paralegal withdrew.";
  }

  return {
    eligible: true,
    bannerText,
    statusText,
    showPartial,
    showReject,
    showRelist: payoutFinalized && !caseData?.relistRequestedAt,
    disablePartial,
    disableReject,
    disableRelist,
  };
}

function openAttorneyFlagMenu(caseData, actionState) {
  return new Promise((resolve) => {
    ensureFlagMenuStyles();
    const state = actionState?.eligible ? actionState : getAttorneyWithdrawalActionState(caseData);
    const overlay = document.createElement("div");
    overlay.className = "case-flag-overlay";
    const options = [];
    if (state.showPartial) {
      options.push(
        `<button type="button" class="case-action-btn" data-flag-action="partial" ${
          state.disablePartial ? "disabled" : ""
        }>Enter Partial Payout</button>`
      );
    }
    if (state.showReject) {
      options.push(
        `<button type="button" class="case-action-btn secondary" data-flag-action="reject" ${
          state.disableReject ? "disabled" : ""
        }>Close Without Release</button>`
      );
    }
    if (state.showRelist) {
      options.push(
        `<button type="button" class="case-action-btn secondary" data-flag-action="relist" ${
          state.disableRelist ? "disabled" : ""
        }>Relist Case</button>`
      );
    }
    const infoParts = [state.bannerText, state.statusText].filter(Boolean);
    const infoCopy = infoParts.length ? `<p class="case-flag-info">${infoParts.join(" ")}</p>` : "";
    const emptyCopy = !options.length
      ? `<p class="case-flag-muted">No actions are available right now.</p>`
      : "";
    overlay.innerHTML = `
      <div class="case-flag-modal" role="dialog" aria-modal="true" aria-labelledby="caseFlagTitle">
        <div class="case-flag-title" id="caseFlagTitle">Paralegal Withdrawal</div>
        ${infoCopy}
        ${emptyCopy}
        <div class="case-flag-actions">
          ${options.join("")}
          <button type="button" class="case-action-btn secondary" data-flag-action="cancel">Cancel</button>
        </div>
      </div>
    `;
    const close = (action) => {
      dismissPopupOverlay(overlay);
      resolve(action);
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close("cancel");
    });
    overlay.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-flag-action]");
      if (!btn || btn.disabled) return;
      const action = btn.dataset.flagAction || "cancel";
      close(action);
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close("cancel");
      },
      { once: true }
    );
    document.body.appendChild(overlay);
    mountPopupOverlay(overlay);
  });
}

function maybePromptAttorneyWithdrawalDecision(caseData) {
  if (getCurrentUserRole() !== "attorney") return;
  if (!caseData) return;
  if (!isWithdrawalCase(caseData)) return;
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (statusKey === "disputed" || caseData?.pausedReason === "dispute") return;
  if (caseData?.payoutFinalizedAt) return;
  if (isDisputeWindowActive(caseData)) return;

  const tasks = getCaseTasks(caseData);
  if (!tasks.length) return;
  const completedCount = countCompletedTasks(caseData);
  if (completedCount <= 0 || completedCount >= tasks.length) return;

  const caseId = caseData?.id || caseData?.caseId || caseData?._id || state.activeCaseId;
  if (!caseId) return;
  const promptStamp =
    caseData?.pausedAt || caseData?.updatedAt || caseData?.createdAt || "";
  const promptKey = `lpc-withdrawal-prompt:${caseId}:${promptStamp}`;
  if (sessionStorage.getItem(promptKey)) return;
  sessionStorage.setItem(promptKey, "1");

  const actionState = getAttorneyWithdrawalActionState(caseData);
  if (!actionState?.eligible) return;

  setTimeout(async () => {
    if (state.activeCaseId && String(state.activeCaseId) !== String(caseId)) return;
    const action = await openAttorneyFlagMenu(caseData, actionState);
    if (action === "partial") {
      await handlePartialPayout();
      return;
    }
    if (action === "reject") {
      await handleRejectPayout();
      return;
    }
    if (action === "relist") {
      await handleRelistCase();
    }
  }, 0);
}

function viewerApplied(caseData) {
  const viewerId = getCurrentUserId();
  if (!viewerId || !Array.isArray(caseData?.applicants)) return false;
  return caseData.applicants.some((entry) => {
    const id =
      entry?.paralegalId?._id ||
      entry?.paralegalId ||
      entry?.paralegal?._id ||
      entry?.paralegal ||
      "";
    return id && String(id) === String(viewerId);
  });
}

function resolveCaseState(caseData) {
  const status = normalizeCaseStatus(caseData?.status);
  if (!status) return "";
  const hasParalegal = !!(caseData?.paralegal || caseData?.paralegalId);
  const escrowFunded = isEscrowFunded(caseData);
  if (hasParalegal && escrowFunded && FUNDED_WORKSPACE_STATUSES.has(status)) {
    return CASE_STATES.FUNDED_IN_PROGRESS;
  }
  if (status === CASE_STATES.DRAFT) return CASE_STATES.DRAFT;
  if (status === CASE_STATES.APPLIED) return CASE_STATES.APPLIED;
  if (status === CASE_STATES.OPEN) {
    return viewerApplied(caseData) ? CASE_STATES.APPLIED : CASE_STATES.OPEN;
  }
  return status;
}

function isWorkspaceEligibleCase(caseData) {
  if (!caseData) return false;
  if (caseData.archived === true) return false;
  if (caseData.paymentReleased === true) return false;
  const status = normalizeCaseStatus(caseData?.status);
  if (!status || !FUNDED_WORKSPACE_STATUSES.has(status)) return false;
  if (!isEscrowFunded(caseData)) return false;
  if (!hasAssignedParalegal(caseData)) return false;
  return true;
}

function shouldAllowCaseDetail(caseData) {
  if (!caseData) return false;
  const status = normalizeCaseStatus(caseData?.status);
  return status === "paused" || status === "disputed";
}

const CASE_SELECT_EXCLUDE_STATUSES = new Set([
  "draft",
  "completed",
  "closed",
  "disputed",
  "archived",
]);

function isSelectableCase(caseData) {
  if (!caseData) return false;
  if (caseData.archived === true) return false;
  const status = normalizeCaseStatus(caseData?.status);
  if (CASE_SELECT_EXCLUDE_STATUSES.has(status)) return false;
  return true;
}

function workspaceLockCopy(caseState, caseData) {
  if (caseState === CASE_STATES.DRAFT) {
    return "Draft cases stay in the planning view.";
  }
  if (caseState === CASE_STATES.APPLIED) {
    return "Workspace unlocks once your application is accepted and the case is funded.";
  }
  if (caseState === CASE_STATES.OPEN) {
    return "Workspace unlocks once the case is funded and in progress.";
  }
  const normalized = normalizeCaseStatus(caseData?.status);
  if (["completed", "closed"].includes(normalized)) {
    if (caseData?.paymentReleased) {
      return "Payment released. Workspace is closed for this case.";
    }
    return "Workspace is closed for this case.";
  }
  if (normalized === "disputed") {
    return "Case is locked. Workspace is paused until an admin resolves it.";
  }
  if (normalized === "paused") {
    if (caseData?.pausedReason === "paralegal_withdrew") {
      return "Case is paused after a withdrawal. Workspace will reopen once the next paralegal is hired.";
    }
    return "Case is paused. Workspace is currently locked.";
  }
  return "Workspace unlocks once the case is funded and in progress.";
}

function isWithdrawalPause(caseData) {
  return normalizeCaseStatus(caseData?.status) === "paused" && caseData?.pausedReason === "paralegal_withdrew";
}

function shouldRedirectFromWorkspace(caseState) {
  return (
    caseState === CASE_STATES.DRAFT ||
    caseState === CASE_STATES.OPEN ||
    caseState === CASE_STATES.APPLIED
  );
}

function redirectFromWorkspace() {
  handleBackNavigation();
}

function isCompletedCase(caseData) {
  const status = normalizeCaseStatus(caseData?.status);
  if (["completed", "closed"].includes(status)) return true;
  return !!(caseData?.readOnly && caseData?.paymentReleased);
}

function getCompletionRedirect(caseData) {
  if (!isCompletedCase(caseData)) return "";
  const role = getCurrentUserRole();
  if (role === "paralegal") return "dashboard-paralegal.html#cases-completed";
  if (role === "admin") return "admin-dashboard.html";
  const caseId = caseData?.id || caseData?.caseId || caseData?._id || "";
  const highlightParam = caseId ? `?highlightCase=${encodeURIComponent(caseId)}` : "";
  return `dashboard-attorney.html${highlightParam}#cases:archived`;
}

function clearCompletionOverlay() {
  if (state.completionOverlayTimer) {
    clearTimeout(state.completionOverlayTimer);
    state.completionOverlayTimer = null;
  }
  if (state.completionOverlayCountdown) {
    clearInterval(state.completionOverlayCountdown);
    state.completionOverlayCountdown = null;
  }
  if (state.completionOverlayNode) {
    state.completionOverlayNode.remove();
    state.completionOverlayNode = null;
  }
  state.completionOverlayActive = false;
  state.completionOverlayCaseId = "";
}

function getParalegalDashboardRedirect(caseData) {
  return getWorkspaceRedirect(caseData) || "dashboard-paralegal.html";
}

function showParalegalCompletionOverlay(caseData) {
  if (getCurrentUserRole() !== "paralegal") return false;
  if (!isCompletedCase(caseData)) return false;
  const caseId = caseData?.id || caseData?.caseId || caseData?._id || "";
  if (state.completionOverlayActive && state.completionOverlayCaseId === caseId) return true;

  clearCompletionOverlay();
  ensureParalegalCompletionOverlayStyles();

  const overlay = document.createElement("div");
  overlay.className = "case-completion-overlay";
  overlay.innerHTML = `
    <div class="case-completion-modal" role="dialog" aria-modal="true" aria-labelledby="caseCompletionTitle">
      <div class="case-completion-hero" role="presentation"></div>
      <div class="case-completion-content">
        <h2 class="case-completion-title" id="caseCompletionTitle">Case Complete</h2>
        <p class="case-completion-body">You can view your payment confirmation in Completed Cases in your Cases &amp; Applications tab.</p>
        <div class="case-completion-actions">
          <button type="button" class="case-completion-btn" data-return-dashboard>Return to dashboard</button>
        </div>
      </div>
    </div>
  `;

  const redirectToDashboard = () => {
    clearCompletionOverlay();
    window.location.href = getParalegalDashboardRedirect(caseData);
  };

  const returnBtn = overlay.querySelector("[data-return-dashboard]");
  const timerEl = overlay.querySelector("[data-completion-timer]");
  let remainingSeconds = 10;
  if (timerEl) {
    timerEl.textContent = `Returning to your dashboard in ${remainingSeconds} seconds.`;
    state.completionOverlayCountdown = setInterval(() => {
      remainingSeconds -= 1;
      if (remainingSeconds <= 0) {
        clearInterval(state.completionOverlayCountdown);
        state.completionOverlayCountdown = null;
        return;
      }
      timerEl.textContent = `Returning to your dashboard in ${remainingSeconds} seconds.`;
    }, 1000);
  }

  state.completionOverlayTimer = setTimeout(() => {
    redirectToDashboard();
  }, 10000);

  returnBtn?.addEventListener("click", redirectToDashboard);

  document.body.appendChild(overlay);
  mountPopupOverlay(overlay);
  state.completionOverlayActive = true;
  state.completionOverlayCaseId = caseId;
  state.completionOverlayNode = overlay;

  stopCaseStream();
  stopMessagePolling();
  setWorkspaceEnabled(false, "Case complete. Returning to dashboard.");
  removeWorkspaceActions();

  returnBtn?.focus();
  return true;
}

function getWorkspaceRedirect(caseData) {
  const role = getCurrentUserRole();
  if (role === "paralegal") return "dashboard-paralegal.html#cases";
  if (role === "admin") return "admin-dashboard.html";
  const caseId = caseData?.id || caseData?.caseId || caseData?._id || "";
  return caseId
    ? `dashboard-attorney.html?previewCaseId=${encodeURIComponent(caseId)}#cases`
    : "dashboard-attorney.html#cases";
}

function removeWorkspaceActions() {
  if (caseCompleteSection) caseCompleteSection.hidden = true;
  if (caseCompleteButton) caseCompleteButton.hidden = true;
  if (messageForm) messageForm.hidden = true;
  if (messageInput) messageInput.disabled = true;
  if (messageAttachment) messageAttachment.disabled = true;
  if (attachmentStaging) emptyNode(attachmentStaging);
}

function getWorkspaceState(caseData, caseStateOverride) {
  const caseState = caseStateOverride || resolveCaseState(caseData);
  if (caseState !== CASE_STATES.FUNDED_IN_PROGRESS || !isEscrowFunded(caseData)) {
    return {
      ready: false,
      reason: workspaceLockCopy(caseState, caseData),
      state: caseState,
    };
  }
  return { ready: true, reason: "", state: caseState };
}

function setWorkspaceEnabled(enabled, message) {
  state.workspaceEnabled = !!enabled;
  const sendBtn = messageForm?.querySelector('button[type="submit"]');
  if (messageInput) messageInput.disabled = !enabled;
  if (messageAttachment) messageAttachment.disabled = !enabled;
  if (sendBtn) sendBtn.disabled = !enabled;
  if (messageForm) {
    messageForm.setAttribute("aria-disabled", enabled ? "false" : "true");
  }
  if (messagePanel) {
    messagePanel.classList.toggle("is-locked", !enabled);
  }
  if (!enabled && messagePanelBanner) {
    if (message === null) {
      messagePanelBanner.textContent = "";
      messagePanelBanner.hidden = true;
    } else {
      messagePanelBanner.hidden = false;
      messagePanelBanner.textContent = message || "Workspace is locked.";
    }
  }
}

function renderWorkspaceLocked(message) {
  if (!messageList) return;
  emptyNode(messageList);
  const li = document.createElement("li");
  const empty = document.createElement("div");
  empty.className = "thread-card";
  empty.textContent = message || "Workspace is locked.";
  li.appendChild(empty);
  messageList.appendChild(li);
  if (messagePanelDivider) {
    messagePanelDivider.textContent = "Pending";
  }
  renderSharedDocuments([], state.activeCaseId, {
    emptyMessage: "Documents are unavailable while the workspace is locked.",
  });
}

async function loadCases() {
  showMsg(caseListStatus, "Loading cases...");
  setCaseNavStatus("Loading cases...");
  const data = await fetchWithFallback(["/api/cases/my?limit=200", "/api/cases/my", "/api/cases"]);
  const allCases = normalizeCaseList(data);
  state.caseOptions = allCases.filter((item) => isSelectableCase(item));
  state.cases = state.caseOptions;
  if (!state.caseOptions.length) {
    showMsg(caseListStatus, "");
    setCaseNavStatus("No active cases.");
  } else {
    showMsg(caseListStatus, "");
    setCaseNavStatus("");
  }
  renderCaseList();
  populateCaseSelect();
  renderCaseNavList();
}

async function loadUnreadCounts() {
  try {
    const data = await fetchJSON("/api/messages/summary");
    const entries = Array.isArray(data?.items) ? data.items : [];
    state.unreadByCase = new Map(entries.map((item) => [String(item.caseId), Number(item.unread) || 0]));
  } catch {
    state.unreadByCase = new Map();
  }
  renderCaseList();
}

function renderCaseList() {
  if (!caseList) return;
  emptyNode(caseList);
  const search = state.search.trim().toLowerCase();
  const source = state.caseOptions.length ? state.caseOptions : state.cases;
  const filtered = source.filter((item) => {
    const title = String(item?.title || "");
    const matchesSearch = !search || title.toLowerCase().includes(search);
    const unread = state.unreadByCase.get(String(getCaseId(item))) || 0;
    const matchesFilter = state.filter === "unread" ? unread > 0 : true;
    return matchesSearch && matchesFilter;
  });

  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.textContent = search ? "No matching cases." : "";
    caseList.appendChild(empty);
    return;
  }

  filtered.forEach((item) => {
    const caseId = String(getCaseId(item));
    const title = item?.title || "Case";
    const status = formatCaseStatus(item?.status, item);
    const preview = item?.briefSummary || item?.details || "";

    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "case-card";
    button.dataset.caseId = caseId;
    if (caseId && caseId === state.activeCaseId) {
      button.setAttribute("aria-current", "true");
    }

    const titleNode = document.createElement("span");
    titleNode.className = "case-title";
    titleNode.textContent = title;

    const metaNode = document.createElement("span");
    metaNode.className = "case-meta";
    metaNode.textContent = status ? `Status: ${status}` : "Status: -";

    const previewNode = document.createElement("span");
    previewNode.className = "case-preview";
    previewNode.textContent = preview || "Select to view the conversation.";

    button.append(titleNode, metaNode, previewNode);

    const unreadCount = state.unreadByCase.get(caseId) || 0;
    if (unreadCount > 0) {
      const unread = document.createElement("span");
      unread.className = "case-unread";
      unread.textContent = String(unreadCount);
      unread.setAttribute(
        "aria-label",
        `${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`
      );
      button.appendChild(unread);
    }

    li.appendChild(button);
    caseList.appendChild(li);
  });
}

function setActiveCase(caseId) {
  state.activeCaseId = caseId;
  if (caseThread) caseThread.dataset.caseId = caseId || "";
  if (messageList) messageList.dataset.caseId = caseId || "";
  state.pendingAttachments = [];
  renderPendingAttachment();
  renderCaseList();
  updateCaseSelectSelection();
}

function renderParticipants(data) {
  if (!caseParticipants) return;
  emptyNode(caseParticipants);
  const attorney = data?.attorney || null;
  const paralegal = data?.paralegal || null;
  const participants = [];

  if (attorney) {
    participants.push({ label: "Attorney", value: formatPerson(attorney), id: normalizeUserId(attorney) });
  }
  if (paralegal) {
    participants.push({ label: "Paralegal", value: formatPerson(paralegal), id: normalizeUserId(paralegal) });
  }

  if (!participants.length) {
    const li = document.createElement("li");
    li.textContent = "Participants will appear once assigned.";
    caseParticipants.appendChild(li);
    return;
  }

  participants.forEach((entry) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${entry.label}: ${entry.value}`;
    li.appendChild(label);
    caseParticipants.appendChild(li);
  });
}

function formatPerson(person) {
  if (!person) return "Team member";
  if (typeof person === "string") return person;
  const fullName = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
  return fullName || person.name || person.email || person.role || "Team member";
}

function getInitials(name = "") {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`.toUpperCase();
}

function getAvatarUrl(message = {}, sender = {}) {
  return (
    sender.profileImage ||
    sender.avatarURL ||
    sender.photoURL ||
    message.senderAvatar ||
    message.senderProfileImage ||
    message.senderPhotoURL ||
    ""
  );
}

function normalizeUserId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.id || value._id || value.userId || "");
}

function getCurrentUserId() {
  try {
    const storedUser = localStorage.getItem("lpc_user");
    const user = storedUser ? JSON.parse(storedUser) : null;
    const id = normalizeUserId(user);
    if (id) return id;
  } catch (_) {}
  const cachedUser = window.getStoredUser?.();
  return normalizeUserId(cachedUser);
}

function getCurrentUserEmail() {
  try {
    const storedUser = localStorage.getItem("lpc_user");
    const user = storedUser ? JSON.parse(storedUser) : null;
    const email = String(user?.email || "").toLowerCase();
    if (email) return email;
  } catch (_) {}
  const cachedUser = window.getStoredUser?.();
  return String(cachedUser?.email || "").toLowerCase();
}

function getCurrentUserRole() {
  try {
    const storedUser = localStorage.getItem("lpc_user");
    const user = storedUser ? JSON.parse(storedUser) : null;
    const role = String(user?.role || "").toLowerCase();
    if (role) return role;
  } catch (_) {}
  const cachedUser = window.getStoredUser?.();
  return String(cachedUser?.role || "").toLowerCase();
}

function getMessageSenderId(message) {
  if (!message) return "";
  return normalizeUserId(
    message.senderId ||
      message.sender ||
      message.user ||
      message.userId ||
      message.senderUserId
  );
}

function isOutgoingMessage(message) {
  const senderId = getMessageSenderId(message);
  const currentUserId = getCurrentUserId();
  if (senderId && currentUserId && senderId === currentUserId) return true;
  const senderRole = String(
    message?.senderRole || message?.sender?.role || message?.role || ""
  ).toLowerCase();
  const currentRole = getCurrentUserRole();
  if (senderRole && currentRole && senderRole === currentRole) return true;
  const senderEmail = String(
    message?.sender?.email || message?.senderEmail || message?.email || ""
  ).toLowerCase();
  const currentEmail = getCurrentUserEmail();
  return !!(senderEmail && currentEmail && senderEmail === currentEmail);
}

function getMessageSenderKey(message) {
  const senderId = getMessageSenderId(message);
  if (senderId) return senderId;
  const senderEmail = String(
    message?.sender?.email || message?.senderEmail || message?.email || ""
  ).toLowerCase();
  return senderEmail;
}

function getDocumentSenderKey(documentData) {
  if (!documentData) return "";
  const uploader = resolveUploader(documentData) || {};
  const uploaderId = normalizeUserId(
    documentData.uploadedById ||
      documentData.userId ||
      uploader
  );
  if (uploaderId) return uploaderId;
  const uploaderEmail = String(
    uploader?.email || documentData?.email || documentData?.uploadedByEmail || ""
  ).toLowerCase();
  return uploaderEmail;
}

function isOutgoingDocument(documentData) {
  if (!documentData) return false;
  const uploader = resolveUploader(documentData) || {};
  const uploaderId = normalizeUserId(
    documentData.uploadedById ||
      documentData.userId ||
      uploader
  );
  const currentUserId = getCurrentUserId();
  if (uploaderId && currentUserId && uploaderId === currentUserId) return true;
  const uploaderRole = String(
    uploader?.role || documentData?.uploaderRole || documentData?.role || ""
  ).toLowerCase();
  const currentRole = getCurrentUserRole();
  if (uploaderRole && currentRole && uploaderRole === currentRole) return true;
  const uploaderEmail = String(
    uploader?.email || documentData?.email || documentData?.uploadedByEmail || ""
  ).toLowerCase();
  const currentEmail = getCurrentUserEmail();
  return !!(uploaderEmail && currentEmail && uploaderEmail === currentEmail);
}

function getItemTimestamp(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getFileExtension(name) {
  const base = String(name || "").trim();
  if (!base) return "";
  const parts = base.split(".");
  if (parts.length < 2) return "";
  return parts.pop().toLowerCase();
}

function isPreviewSupported({ fileName, mimeType } = {}) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf") return true;
  if (
    mime === "application/msword" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return true;
  const ext = getFileExtension(fileName);
  return ["pdf", "png", "jpg", "jpeg", "gif", "webp", "doc", "docx"].includes(ext);
}

function showDocumentActionMessage(message) {
  showMsg(messageStatus, message);
}

function buildViewUrl({ caseId, storageKey, previewKey } = {}) {
  const key = previewKey || storageKey;
  if (!caseId || !key) return "";
  return `/api/uploads/view?caseId=${encodeURIComponent(caseId)}&key=${encodeURIComponent(key)}`;
}

async function getSignedViewUrl({ caseId, storageKey } = {}) {
  if (!caseId || !storageKey) return "";
  try {
    const data = await fetchJSON(
      `/api/uploads/signed-get?caseId=${encodeURIComponent(caseId)}&key=${encodeURIComponent(storageKey)}&preview=true`
    );
    return data?.url || "";
  } catch {
    return "";
  }
}

async function getSignedDownloadUrl({ caseId, storageKey } = {}) {
  if (!caseId || !storageKey) return "";
  try {
    const data = await fetchJSON(
      `/api/uploads/signed-get?caseId=${encodeURIComponent(caseId)}&key=${encodeURIComponent(storageKey)}`
    );
    return data?.url || "";
  } catch {
    return "";
  }
}

async function syncThemeFromSession() {
  if (typeof window.checkSession !== "function") return;
  try {
    const session = await window.checkSession(undefined, { redirectOnFail: false });
    const user = session?.user || session;
    const theme = user?.preferences?.theme;
    if (theme && typeof window.applyThemePreference === "function") {
      window.applyThemePreference(theme);
    }
  } catch (_) {
    /* noop */
  }
}

function syncRoleVisibility() {
  if (typeof applyRoleVisibility !== "function") return;
  try {
    const storedUser = localStorage.getItem("lpc_user");
    const user = storedUser ? JSON.parse(storedUser) : null;
    const role = String(user?.role || "").toLowerCase();
    if (role) {
      applyRoleVisibility(role);
      document.body.classList.toggle("role-attorney", role === "attorney");
      return;
    }
  } catch (_) {}
  const cachedUser = window.getStoredUser?.();
  const cachedRole = String(cachedUser?.role || "").toLowerCase();
  if (cachedRole) {
    applyRoleVisibility(cachedRole);
    document.body.classList.toggle("role-attorney", cachedRole === "attorney");
  }
}

function normalizeAttorneyCaseTheme() {
  const body = document.body;
  const root = document.documentElement;
  if (!body || !root) return;
  if (!body.classList.contains("role-attorney")) return;
  const overrides = {
    "--bg": "#ffffff",
    "--panel": "#fcfcfc",
    "--muted": "#8a8a8a",
    "--sidebar-text": "#1a1a1a",
    "--sidebar-bg": "#f5f5f5e6",
    "--app-background": "#ffffff",
  };
  Object.entries(overrides).forEach(([key, value]) => {
    body.style.setProperty(key, value);
    root.style.setProperty(key, value);
  });
}

function resolveUploader(documentData) {
  if (!documentData) return null;
  const candidate =
    documentData.uploadedBy ||
    documentData.uploadedById ||
    documentData.user ||
    documentData.userId ||
    null;
  if (candidate && typeof candidate === "object") return candidate;
  return null;
}

function formatUploaderName(documentData, caseData = state.activeCase) {
  if (!documentData) return "";
  const uploader = resolveUploader(documentData) || {};
  const uploaderId = normalizeUserId(
    documentData.uploadedById || documentData.uploadedBy || documentData.userId || uploader
  );
  const uploaderEmail = String(
    uploader.email || documentData?.uploadedByEmail || documentData?.email || ""
  ).toLowerCase();
  const directName =
    documentData.uploadedByName ||
    documentData.uploaderName ||
    documentData.uploadedByEmail ||
    documentData.email ||
    "";
  const first = uploader.firstName || uploader.first_name || "";
  const last = uploader.lastName || uploader.last_name || "";
  const full =
    uploader.fullName ||
    uploader.name ||
    [first, last].filter(Boolean).join(" ").trim();
  const email = uploader.email || "";
  if (full || email || directName) return full || email || directName;

  if (caseData) {
    const candidates = [
      { role: "attorney", data: caseData.attorney },
      { role: "paralegal", data: caseData.paralegal },
      { role: "paralegal", data: caseData.pendingParalegal },
    ].filter((entry) => entry.data);

    if (uploaderId) {
      const match = candidates.find((entry) => normalizeUserId(entry.data) === uploaderId);
      if (match) return formatPerson(match.data);
    }

    if (uploaderEmail) {
      const match = candidates.find(
        (entry) => String(entry.data?.email || "").toLowerCase() === uploaderEmail
      );
      if (match) return formatPerson(match.data);
    }

    const role = String(documentData?.uploadedByRole || documentData?.uploaderRole || "").toLowerCase();
    if (role) {
      const match = candidates.find((entry) => entry.role === role);
      if (match) return formatPerson(match.data);
      return role.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return "Unknown";
}

function uploadAttachment(entry, caseId, note) {
  const endpoints = [
    `/api/uploads/case/${encodeURIComponent(caseId)}`,
    `/api/uploads/${encodeURIComponent(caseId)}`,
    "/api/uploads",
    `/api/uploads?caseId=${encodeURIComponent(caseId)}`,
  ];
  const token = window.__CSRF__ || "";

  const sendWithEndpoint = (url) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      entry.xhr = xhr;
      xhr.open("POST", url, true);
      xhr.withCredentials = true;
      if (token) xhr.setRequestHeader("X-CSRF-Token", token);
      xhr.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        entry.progress = Math.round((event.loaded / event.total) * 100);
        renderPendingAttachment();
      });
      xhr.addEventListener("abort", () => {
        entry.xhr = null;
        const error = new Error("Upload canceled");
        error.code = "canceled";
        reject(error);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let uploadedFile = null;
          try {
            const parsed = JSON.parse(xhr.responseText || "{}");
            uploadedFile = parsed?.file || parsed?.document || parsed?.item || null;
          } catch {}
          entry.status = "uploaded";
          entry.progress = 100;
          entry.xhr = null;
          entry.error = "";
          renderPendingAttachment();
          removeAttachmentRecord(entry.id).catch(() => {});
          if (uploadedFile) addOptimisticDocument(uploadedFile, caseId);
          resolve(uploadedFile);
          return;
        }
        let errorMessage = `Upload failed (${xhr.status}).`;
        try {
          const parsed = JSON.parse(xhr.responseText || "{}");
          errorMessage = parsed?.msg || parsed?.error || parsed?.message || errorMessage;
        } catch {
          if (xhr.responseText && xhr.responseText.trim()) {
            errorMessage = xhr.responseText.trim().slice(0, 200);
          }
        }
        const error = new Error(errorMessage);
        error.status = xhr.status;
        entry.error = errorMessage;
        entry.xhr = null;
        reject(error);
      });
      xhr.addEventListener("error", () => {
        entry.xhr = null;
        entry.error = "Upload failed. Check your connection.";
        reject(new Error("Upload failed"));
      });

      const formData = new FormData();
      formData.append("file", entry.file);
      formData.append("caseId", caseId);
      if (note) formData.append("note", note);
      xhr.send(formData);
    });

  const attempt = async (index) => {
    if (index >= endpoints.length) {
      entry.status = "failed";
      entry.error = "Upload failed. Please retry.";
      renderPendingAttachment();
      throw new Error("Upload failed");
    }
    try {
      return await sendWithEndpoint(endpoints[index]);
    } catch (err) {
      if (err.code === "canceled") {
        entry.status = "canceled";
        entry.progress = 0;
        entry.error = "Upload canceled.";
        renderPendingAttachment();
        throw err;
      }
      if (err.status === 404 || err.status === 405) {
        return attempt(index + 1);
      }
      entry.status = "failed";
      entry.error = err?.message || "Upload failed. Please retry.";
      renderPendingAttachment();
      throw err;
    }
  };

  return attempt(0);
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function updateUploadStatus(current, total) {
  if (!total) return;
  showMsg(messageStatus, `Uploading ${current} of ${total}`);
}

function renderPendingAttachment() {
  if (!attachmentStaging) return;
  emptyNode(attachmentStaging);
  if (!state.pendingAttachments.length) {
    attachmentStaging.hidden = true;
    return;
  }

  const failedEntries = state.pendingAttachments.filter((entry) => entry.status === "failed");
  if (failedEntries.length) {
    const retryAll = document.createElement("button");
    retryAll.type = "button";
    retryAll.className = "attachment-remove";
    retryAll.textContent = "Retry all failed";
    retryAll.addEventListener("click", () => {
      failedEntries.forEach((entry) => {
        entry.status = "pending";
        entry.progress = 0;
        entry.error = "";
      });
      renderPendingAttachment();
      showMsg(messageStatus, "Retry queued. Click Send to upload.");
    });
    attachmentStaging.appendChild(retryAll);
  }

  const failedFirst = [...state.pendingAttachments].sort((a, b) => {
    const aFailed = a.status === "failed" ? 1 : 0;
    const bFailed = b.status === "failed" ? 1 : 0;
    return bFailed - aFailed;
  });

  failedFirst.forEach((entry) => {
    const wrapper = document.createElement("div");
    wrapper.className = "attachment-item";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "attachment-name";
    name.textContent = entry.file?.name || "Attachment";

    const meta = document.createElement("div");
    meta.className = "attachment-meta";
    const sizeLabel = formatFileSize(entry.file?.size);
    const statusLabel = entry.status === "uploading"
      ? `Uploading ${entry.progress}%`
      : entry.status === "uploaded"
      ? "Uploaded"
      : entry.status === "failed"
      ? "Upload failed"
      : entry.status === "canceled"
      ? "Upload canceled"
      : "Pending attachment";
    meta.textContent = sizeLabel ? `${statusLabel} • ${sizeLabel}` : statusLabel;
    info.append(name, meta);

    if (entry.status === "uploading") {
      const progress = document.createElement("progress");
      progress.className = "attachment-progress";
      progress.max = 100;
      progress.value = entry.progress || 0;
      info.appendChild(progress);
    }

    if (entry.status === "failed" && entry.error) {
      const error = document.createElement("div");
      error.className = "attachment-error";
      error.textContent = entry.error;
      info.appendChild(error);
    }

    const actions = document.createElement("div");
    actions.className = "attachment-actions";

    if (entry.status === "uploading") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "attachment-remove";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        cancelUpload(entry);
      });
      actions.appendChild(cancel);
    }

    if (entry.status === "failed" || entry.status === "canceled") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "attachment-remove";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        entry.status = "pending";
        entry.progress = 0;
        entry.error = "";
        renderPendingAttachment();
        showMsg(messageStatus, "Retry queued. Click Send to upload.");
      });
      actions.appendChild(retry);
    }

    if (entry.status !== "uploading" && entry.status !== "uploaded") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        removePendingAttachment(entry.id);
      });
      actions.appendChild(remove);
    }

    wrapper.append(info, actions);
    attachmentStaging.appendChild(wrapper);
  });

  attachmentStaging.hidden = false;
}

function buildAttachmentEntry(file, id) {
  return {
    id: id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    file,
    status: "pending",
    progress: 0,
    xhr: null,
    error: "",
  };
}

function isSameFile(left, right) {
  return (
    left &&
    right &&
    left.name === right.name &&
    left.size === right.size &&
    left.lastModified === right.lastModified
  );
}

function addPendingAttachments(files) {
  if (!state.workspaceEnabled) {
    showMsg(messageStatus, "Uploads unlock once the case is funded and in progress.");
    return;
  }
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  list.forEach((file) => {
    const exists = state.pendingAttachments.some((entry) => isSameFile(entry.file, file));
    if (!exists) {
      const entry = buildAttachmentEntry(file);
      state.pendingAttachments.push(entry);
      persistAttachment(entry);
    }
  });
  renderPendingAttachment();
}

function removePendingAttachment(id) {
  state.pendingAttachments = state.pendingAttachments.filter((entry) => entry.id !== id);
  removeAttachmentRecord(id).catch(() => {});
  renderPendingAttachment();
}

function cancelUpload(entry) {
  if (!entry || entry.status !== "uploading") return;
  if (entry.xhr) {
    entry.xhr.abort();
  } else {
    entry.status = "canceled";
    entry.progress = 0;
    entry.error = "Upload canceled.";
    renderPendingAttachment();
  }
}

function persistAttachment(entry) {
  const caseId = state.activeCaseId;
  if (!caseId || !entry?.file) return;
  const record = {
    id: entry.id,
    caseId,
    name: entry.file.name,
    type: entry.file.type,
    size: entry.file.size,
    lastModified: entry.file.lastModified,
    blob: entry.file,
  };
  saveAttachmentRecord(record).catch(() => {});
}

async function restorePendingAttachments(caseId) {
  if (!caseId) return;
  if (state.pendingAttachments.length) return;
  const records = await listAttachmentRecords(caseId).catch(() => []);
  if (!records.length) return;
  state.pendingAttachments = records.map((record) => {
    const file = new File([record.blob], record.name, {
      type: record.type || "",
      lastModified: record.lastModified || Date.now(),
    });
    return buildAttachmentEntry(file, record.id);
  });
  renderPendingAttachment();
}

function isFileDrag(event) {
  const types = Array.from(event?.dataTransfer?.types || []);
  return types.includes("Files");
}

function showDropzone() {
  if (messagePanel) messagePanel.classList.add("is-dragover");
  if (dropzoneOverlay) dropzoneOverlay.classList.add("active");
}

function hideDropzone() {
  if (messagePanel) messagePanel.classList.remove("is-dragover");
  if (dropzoneOverlay) dropzoneOverlay.classList.remove("active");
}

function handleDragEnter(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  showDropzone();
}

function handleDragOver(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  showDropzone();
}

function handleDragLeave(event) {
  if (!dropzoneOverlay?.classList.contains("active")) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hideDropzone();
}

function handleDrop(event) {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  hideDropzone();
  addPendingAttachments(event.dataTransfer?.files);
}

function handleAttachmentChange(event) {
  addPendingAttachments(event.target?.files);
  if (messageAttachment) messageAttachment.value = "";
}

function getTaskTitle(task) {
  if (!task) return "";
  if (typeof task === "string") return task;
  return task?.title || task?.name || "";
}

function normalizeTaskCompletion(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function isTaskCompleted(task) {
  return normalizeTaskCompletion(task?.completed ?? task?.done);
}

function getCaseTasks(caseData) {
  if (!caseData) return [];
  if (Array.isArray(caseData.tasks)) return caseData.tasks;
  if (Array.isArray(caseData.checklist)) return caseData.checklist;
  return [];
}

function areAllTasksComplete(caseData) {
  const tasks = getCaseTasks(caseData);
  if (!tasks.length) return false;
  return tasks.every((task) => isTaskCompleted(task));
}

function areRenderedTasksComplete() {
  if (!caseTaskList) return null;
  const checkboxes = Array.from(caseTaskList.querySelectorAll('input[type="checkbox"]'));
  if (!checkboxes.length) return null;
  return checkboxes.every((checkbox) => checkbox.checked);
}

function areCompletionTasksComplete(caseData) {
  const rendered = areRenderedTasksComplete();
  if (typeof rendered === "boolean") return rendered;
  return areAllTasksComplete(caseData);
}

function setCompleteButtonLock(locked) {
  if (!caseCompleteButton) return;
  const isLocked = !!locked;
  caseCompleteButton.classList.toggle("is-locked", isLocked);
  caseCompleteButton.setAttribute("aria-disabled", isLocked ? "true" : "false");
  caseCompleteButton.dataset.locked = isLocked ? "true" : "false";
  caseCompleteButton.disabled = isLocked || state.completing;
}

function bindTaskCompletionWatcher() {
  if (!caseTaskList || taskLockWatcherBound) return;
  taskLockWatcherBound = true;
  caseTaskList.addEventListener("change", (event) => {
    if (!event.target || event.target.type !== "checkbox") return;
    if (!state.activeCase) return;
    updateCompleteAction(state.activeCase, resolveCaseState(state.activeCase));
  });
}

function ensureCompleteButtonBinding() {
  if (!caseCompleteButton || caseCompleteButton.dataset.bound === "true") return;
  caseCompleteButton.dataset.bound = "true";
  caseCompleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    handleCompleteCase();
  });
}

function showCompleteLockMessage() {
  if (!caseCompleteStatus) return;
  caseCompleteStatus.textContent = "Check all task boxes to Complete";
  caseCompleteStatus.classList.add("is-alert");
  caseCompleteStatus.dataset.lockReason = "tasks";
}

function stopReleaseFundsAnimation() {
  if (releaseFundsAnimationTimer) {
    clearInterval(releaseFundsAnimationTimer);
    releaseFundsAnimationTimer = null;
  }
}

function startReleaseFundsAnimation() {
  stopReleaseFundsAnimation();
  const frames = [".", "..", "..."];
  let frame = 0;
  const render = () => {
    const label = `Releasing funds${frames[frame % frames.length]}`;
    if (caseCompleteButton && !caseCompleteButton.hidden) {
      caseCompleteButton.textContent = label;
    }
    if (caseCompleteStatus) {
      caseCompleteStatus.textContent = label;
    }
    frame += 1;
  };
  render();
  releaseFundsAnimationTimer = setInterval(render, 450);
}

function clearCompleteLockMessage() {
  if (!caseCompleteStatus) return;
  if (caseCompleteStatus.dataset.lockReason !== "tasks") return;
  caseCompleteStatus.textContent = "";
  caseCompleteStatus.classList.remove("is-alert");
  delete caseCompleteStatus.dataset.lockReason;
}

function normalizeRole(value) {
  return String(value || "").toLowerCase();
}

function getDocumentUploadRole(documentData) {
  return normalizeRole(
    documentData?.uploadedByRole ||
      documentData?.uploaderRole ||
      documentData?.uploadedBy?.role ||
      documentData?.uploader?.role ||
      documentData?.userRole ||
      ""
  );
}

async function updateCaseFileStatus(caseId, fileId, status) {
  if (!caseId || !fileId || !status) return null;
  await fetchCSRF().catch(() => "");
  return fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(fileId)}/status`, {
    method: "PATCH",
    body: { status },
  });
}

async function queueDocumentForResend({ caseId, docId, fileName, mimeType, storageKey }) {
  if (!caseId || typeof File === "undefined") return false;
  const attempts = [];
  if (docId) {
    const downloadUrl = `/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(docId)}/download`;
    attempts.push(async () => secureFetch(downloadUrl, { method: "GET" }));
  }
  if (storageKey) {
    attempts.push(async () => {
      const signedUrl = await getSignedDownloadUrl({ caseId, storageKey });
      if (!signedUrl) return null;
      return fetch(signedUrl);
    });
  }
  try {
    let res = null;
    for (const attempt of attempts) {
      res = await attempt();
      if (res && res.ok) break;
    }
    if (!res || !res.ok) {
      throw new Error("Unable to fetch document for resend.");
    }
    const blob = await res.blob();
    const file = new File([blob], fileName || "document", {
      type: mimeType || blob.type || "",
    });
    addPendingAttachments([file]);
    return true;
  } catch (err) {
    showMsg(messageStatus, err.message || "Unable to attach document.");
    return false;
  }
}

function applyRevisionMessageTemplate() {
  if (!messageInput) return;
  if (!messageInput.dataset.defaultPlaceholder) {
    messageInput.dataset.defaultPlaceholder = messageInput.placeholder || "";
  }
  messageInput.placeholder = "Describe revisions needed";
  const resetPlaceholder = () => {
    messageInput.placeholder = messageInput.dataset.defaultPlaceholder || "";
  };
  messageInput.addEventListener(
    "input",
    () => {
      resetPlaceholder();
    },
    { once: true }
  );
  messageInput.focus();
  messageInput.scrollIntoView({ behavior: "smooth", block: "center" });
}

function canEditTasks(caseData) {
  if (getCurrentUserRole() !== "attorney") return false;
  if (caseData?.readOnly) return false;
  if (isCompletedCase(caseData)) return false;
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (["disputed"].includes(statusKey)) return false;
  return true;
}

function buildTaskPayload(tasks, overrideIndex, overrideValue) {
  const payload = [];
  tasks.forEach((task, index) => {
    const title = String(getTaskTitle(task) || "").trim();
    if (!title) return;
    const completed = index === overrideIndex ? overrideValue : isTaskCompleted(task);
    payload.push({ title, completed });
  });
  return payload;
}

async function updateTaskCompletion(taskIndex, checked) {
  if (taskUpdateInFlight) return false;
  const caseId = state.activeCaseId;
  if (!caseId || !state.activeCase) return false;
  const tasks = Array.isArray(state.activeCase.tasks) ? state.activeCase.tasks : [];
  if (!tasks.length || !tasks[taskIndex]) return false;
  const previousTasks = tasks.map((task) => (typeof task === "string" ? task : { ...task }));
  const payload = buildTaskPayload(tasks, taskIndex, checked);
  if (!payload.length) return false;
  taskUpdateInFlight = true;
  if (caseTaskList) caseTaskList.setAttribute("aria-busy", "true");
  if (caseTaskList) {
    caseTaskList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.disabled = true;
    });
  }
  try {
    await fetchCSRF().catch(() => "");
    const updated = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}`, {
      method: "PATCH",
      body: { tasks: payload },
    });
    state.activeCase = { ...state.activeCase, ...updated };
  } catch (err) {
    console.error("Unable to update task completion", err);
    state.activeCase = { ...state.activeCase, tasks: previousTasks };
    showMsg(messageStatus, err.message || "Unable to update task.");
  } finally {
    taskUpdateInFlight = false;
    if (caseTaskList) caseTaskList.setAttribute("aria-busy", "false");
    if (state.activeCase) {
      renderCaseOverview(state.activeCase);
      state.taskSnapshots.set(caseId, getTaskSnapshot(state.activeCase));
    }
  }
  return true;
}

function renderCaseOverview(data) {
  const title = data?.title || "Case";
  const status = formatCaseStatus(data?.status, data);
  const summaryText = data?.briefSummary || data?.details || "";

  const remainingCents = resolveRemainingAmount(data);
  const escrowAmountRaw = Number.isFinite(remainingCents)
    ? remainingCents / 100
    : Number.isFinite(data?.lockedTotalAmount)
    ? data.lockedTotalAmount / 100
    : Number.isFinite(data?.totalAmount)
    ? data.totalAmount / 100
    : null;

  const escrowStatus = data?.escrowStatus || (status ? status : "-");
  const hireDateValue = data?.hiredAt || data?.createdAt || "";
  const matterType = data?.practiceArea || data?.category || data?.type || "-";
  const deadlines = Array.isArray(data?.deadlines) ? data.deadlines : data?.deadline ? [data.deadline] : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data?.checklist) ? data.checklist : [];
  const currency = data?.currency ? String(data.currency).toUpperCase() : "USD";
  const subtitleValue =
    data?.clientName ||
    data?.client?.name ||
    data?.client ||
    data?.company ||
    data?.firm ||
    data?.organization ||
    "";

  if (caseTitle) caseTitle.textContent = title;
  if (caseStatusLine) {
    caseStatusLine.textContent = status ? `Status: ${status}` : "Status: -";
  }
  if (caseEscrowAmount) caseEscrowAmount.textContent = formatCurrency(escrowAmountRaw, currency);
  if (caseEscrowStatus) caseEscrowStatus.textContent = escrowStatus || "-";
  if (caseHireDate) caseHireDate.textContent = formatDate(hireDateValue) || "-";
  if (caseMatterType) caseMatterType.textContent = matterType || "-";
  if (caseSummary) caseSummary.textContent = summaryText || "No case summary yet.";
  if (messagePanelTitle) messagePanelTitle.textContent = title || "Case conversation";
  if (messagePanelSubtitle) messagePanelSubtitle.textContent = subtitleValue;
  if (messagePanelBanner) {
    const opened = formatDate(hireDateValue);
    const normalized = normalizeCaseStatus(data?.status);
    if (isWithdrawalPause(data)) {
      messagePanelBanner.textContent = "";
      messagePanelBanner.hidden = true;
    } else {
      messagePanelBanner.hidden = false;
      if (["completed", "closed"].includes(normalized) && data?.paymentReleased) {
        messagePanelBanner.textContent = "Payment released. Workspace is now read-only.";
      } else if (normalized === "disputed") {
        messagePanelBanner.textContent =
          "Workspace paused - Paralegal requested admin assistance. We'll resolve this within 24 hours.";
      } else if (normalized === "paused") {
        messagePanelBanner.textContent = "Case is paused. Workspace is locked.";
      } else {
        messagePanelBanner.textContent = opened ? `Opened on ${opened}` : "Case updates will appear here.";
      }
    }
  }

  if (caseDeadlineList) {
    emptyNode(caseDeadlineList);
    if (!deadlines.length) {
      const li = document.createElement("li");
      li.textContent = "No deadlines set.";
      caseDeadlineList.appendChild(li);
    } else {
      deadlines.forEach((deadline) => {
        const li = document.createElement("li");
        const date = formatDate(deadline?.date || deadline);
        li.textContent = date || String(deadline);
        caseDeadlineList.appendChild(li);
      });
    }
  }

  if (caseTaskList) {
    emptyNode(caseTaskList);
    if (!tasks.length) {
      const li = document.createElement("li");
      li.textContent = "No tasks yet.";
      caseTaskList.appendChild(li);
    } else {
      const allowTaskEdit = canEditTasks(data);
      tasks.forEach((task, taskIndex) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        const title = getTaskTitle(task);
        checkbox.type = "checkbox";
        checkbox.disabled = !allowTaskEdit || taskUpdateInFlight;
        checkbox.checked = isTaskCompleted(task);
        label.appendChild(checkbox);
        label.append(` ${title || "Task"}`);
        li.appendChild(label);
        caseTaskList.appendChild(li);
        if (allowTaskEdit) {
          checkbox.addEventListener("change", async () => {
            if (taskUpdateInFlight) {
              checkbox.checked = !checkbox.checked;
              return;
            }
            const refreshCompleteState = () => {
              updateCompleteAction(state.activeCase || data, resolveCaseState(state.activeCase || data));
            };
            refreshCompleteState();
            const updated = await updateTaskCompletion(taskIndex, checkbox.checked);
            if (!updated) {
              checkbox.checked = !checkbox.checked;
              refreshCompleteState();
            }
          });
        }
      });
    }
  }

  updateWithdrawalSection(data);
  updatePausedActions(data);
  updateDisputeAction(data);
  bindTaskCompletionWatcher();
  updateCompleteAction(data, resolveCaseState(data));
}

function updateCompleteAction(caseData, caseState) {
  if (!caseCompleteSection || !caseCompleteButton || !caseCompleteSection.isConnected) return;
  ensureCompleteButtonBinding();
  const role = getCurrentUserRole();
  const isAttorney = role === "attorney";
  const hasParalegal = !!(caseData?.paralegal || caseData?.paralegalId);
  const statusKey = normalizeCaseStatus(caseData?.status);
  const isFinal = statusKey === "completed" || caseData?.paymentReleased === true;
  const eligible =
    isAttorney &&
    caseState === CASE_STATES.FUNDED_IN_PROGRESS &&
    !caseData?.readOnly &&
    !caseData?.paymentReleased &&
    !isFinal &&
    hasParalegal;
  caseCompleteSection.hidden = !eligible;
  if (caseCompleteStatus && !eligible) {
    caseCompleteStatus.textContent = "";
    caseCompleteStatus.classList.remove("is-alert");
    delete caseCompleteStatus.dataset.lockReason;
  }
  if (!eligible) {
    setCompleteButtonLock(false);
    return;
  }
  const tasksComplete = areCompletionTasksComplete(caseData);
  setCompleteButtonLock(!tasksComplete);
  if (tasksComplete) {
    clearCompleteLockMessage();
  }
}

function updateDisputeAction(caseData) {
  if (!caseDisputeButton) return;
  const statusKey = normalizeCaseStatus(caseData?.status);
  const isDisputed = statusKey === "disputed" || caseData?.terminationStatus === "disputed";
  const isClosed = ["completed", "closed"].includes(statusKey);
  const role = getCurrentUserRole();
  const isWithdrawal = isWithdrawalCase(caseData);
  const isWithdrawn = isWithdrawnViewer(caseData);
  const disputeActive = isDisputeWindowActive(caseData);
  let disabled = isDisputed || isClosed;
  let hidden = false;
  let message = "";
  let attorneyActionState = null;

  if (isWithdrawal) {
    if (role === "paralegal") {
      if (!isWithdrawn) {
        hidden = true;
      } else {
        disabled = true;
        message = "";
      }
    } else if (role === "attorney") {
      hidden = false;
      disabled = isClosed;
      attorneyActionState = getAttorneyWithdrawalActionState(caseData);
      const infoParts = [attorneyActionState.bannerText, attorneyActionState.statusText].filter(Boolean);
      if (infoParts.length) {
        message = infoParts.join(" ");
      } else if (isDisputed) {
        message = "Workspace paused - Paralegal requested admin assistance. We'll resolve this within 24 hours.";
      }
    } else {
      hidden = true;
      if (isDisputed) {
        message = "Workspace paused - Paralegal requested admin assistance. We'll resolve this within 24 hours.";
      }
    }
  } else if (isDisputed) {
    message = "Workspace paused - Paralegal requested admin assistance. We'll resolve this within 24 hours.";
  }

  const flagLabel =
    role === "paralegal" || (role === "attorney" && isWithdrawal) ? "Case actions" : "Flag dispute";
  caseDisputeButton.setAttribute("aria-label", flagLabel);
  const flagLabelNode = caseDisputeButton.querySelector("span");
  if (flagLabelNode) flagLabelNode.textContent = flagLabel;

  caseDisputeButton.disabled = disabled;
  caseDisputeButton.hidden = hidden;
  if (caseDisputeStatus) {
    if (
      role === "attorney" &&
      attorneyActionState?.showPartial &&
      attorneyActionState?.showReject
    ) {
      const partialLabel = `<button type="button" class="case-inline-action" data-withdraw-action="partial"${
        attorneyActionState.disablePartial ? " disabled" : ""
      }>partial payout</button>`;
      const rejectLabel = `<button type="button" class="case-inline-action" data-withdraw-action="reject"${
        attorneyActionState.disableReject ? " disabled" : ""
      }>close without release</button>`;
      const suffix = attorneyActionState.statusText ? ` ${attorneyActionState.statusText}` : "";
      caseDisputeStatus.innerHTML = `Paralegal withdrew. Please choose a ${partialLabel} or ${rejectLabel}. Case will relist automatically with adjusted balance, if applicable.${suffix}`;
      const partialBtn = caseDisputeStatus.querySelector('[data-withdraw-action="partial"]');
      if (partialBtn && !attorneyActionState.disablePartial) {
        partialBtn.onclick = (event) => {
          event.preventDefault();
          handlePartialPayout();
        };
      }
      const rejectBtn = caseDisputeStatus.querySelector('[data-withdraw-action="reject"]');
      if (rejectBtn && !attorneyActionState.disableReject) {
        rejectBtn.onclick = (event) => {
          event.preventDefault();
          handleRejectPayout();
        };
      }
    } else {
      caseDisputeStatus.textContent = message;
    }
  }
}

function updateWithdrawalSection(caseData) {
  if (!caseWithdrawSection) return;
  const role = getCurrentUserRole();
  if (role !== "paralegal") {
    caseWithdrawSection.hidden = true;
    return;
  }
  const statusKey = normalizeCaseStatus(caseData?.status);
  const viewerId = getCurrentUserId();
  const assignedId = normalizeUserId(caseData?.paralegal || caseData?.paralegalId);
  const isAssignedViewer = viewerId && assignedId && String(viewerId) === String(assignedId);
  const isWithdrawn = isWithdrawnViewer(caseData);
  const totalTasks = getCaseTasks(caseData).length;
  const completedCount = countCompletedTasks(caseData);

  let showSection = false;
  let showButton = false;
  let note = "";
  let statusMessage = "";

  if (isWithdrawn) {
    showSection = true;
    if (caseData?.payoutFinalizedAt) {
      const payoutLabel = formatCurrency(
        Number(caseData?.partialPayoutAmount || 0) / 100,
        String(caseData?.currency || "USD").toUpperCase()
      );
      statusMessage = `Withdrawal finalized with a payout of ${payoutLabel}.`;
    } else {
      statusMessage = "Withdrawal recorded.";
    }
  } else if (isAssignedViewer) {
    if (
      statusKey !== "paused" &&
      !["disputed", "completed", "closed"].includes(statusKey) &&
      !areAllTasksComplete(caseData)
    ) {
      showSection = true;
      showButton = statusKey !== "paused";
      note = "Withdrawing will close this case for you. You will no longer be able to submit work on this matter.";
    }
  }

  caseWithdrawSection.hidden = !showSection;
  if (caseWithdrawButton) {
    caseWithdrawButton.hidden = !showButton;
    caseWithdrawButton.disabled = state.withdrawing;
  }
  if (caseWithdrawNote) caseWithdrawNote.textContent = note || "";
  if (caseWithdrawStatus) caseWithdrawStatus.textContent = statusMessage || "";
}

function updatePausedActions(caseData) {
  if (!casePausedSection) return;
  const role = getCurrentUserRole();
  if (role !== "attorney") {
    casePausedSection.hidden = true;
    return;
  }
  const actionState = getAttorneyWithdrawalActionState(caseData);
  if (!actionState.eligible) {
    casePausedSection.hidden = true;
    return;
  }
  casePausedSection.hidden = false;
  if (casePausedBanner) {
    casePausedBanner.textContent = actionState.bannerText;
    casePausedBanner.hidden = !actionState.bannerText;
  }
  if (casePartialPayoutButton) {
    casePartialPayoutButton.hidden = true;
    casePartialPayoutButton.disabled = actionState.disablePartial || state.partialPayoutSubmitting;
  }
  if (caseRelistButton) {
    caseRelistButton.hidden = true;
    caseRelistButton.disabled = actionState.disableRelist || state.relisting;
  }
  if (casePausedStatus) casePausedStatus.textContent = actionState.statusText || "";
}

function resolveCaseActionStatusNode() {
  if (casePausedSection && !casePausedSection.hidden && casePausedStatus) {
    return casePausedStatus;
  }
  if (caseDisputeStatus) return caseDisputeStatus;
  return messageStatus;
}

function setCompletionStatusMessage(message) {
  if (!caseCompleteStatus) return;
  if (message === PAYMENT_METHOD_UPDATE_MESSAGE) {
    caseCompleteStatus.innerHTML = `<a class="case-status-link" href="dashboard-attorney.html#billing">${message}</a>`;
    return;
  }
  caseCompleteStatus.textContent = message || "";
}

function resolveCompletionIneligibleReason(caseData, caseState) {
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (caseData?.paymentReleased || statusKey === "completed") {
    return "This case is already completed and payment has been released.";
  }
  if (caseData?.readOnly || statusKey === "closed") {
    return "This case is closed and read-only.";
  }
  if (statusKey === "disputed" || caseData?.terminationStatus === "disputed") {
    return "This case is locked and cannot be completed.";
  }
  if (!hasAssignedParalegal(caseData)) {
    return "Assign a paralegal before completing this case.";
  }
  if (!isEscrowFunded(caseData)) {
    const fundingStatus = String(caseData?.escrowStatus || "").toLowerCase();
    if (caseData?.escrowIntentId || fundingStatus) {
      return "Funding isn't in place. Update the payment method if needed, then fund the case before releasing funds.";
    }
    return "Funding hasn't been added yet. Fund the case before releasing funds.";
  }
  if (caseState !== CASE_STATES.FUNDED_IN_PROGRESS) {
    const label = formatCaseStatus(caseData?.status, caseData);
    if (label && label !== "In Progress") {
      return `Case must be In Progress to complete. Current status: ${label}.`;
    }
    return "Case must be in progress to complete.";
  }
  return "This case is not eligible for completion right now.";
}

async function handleCompleteCase() {
  if (state.completing) return;
  const caseId = state.activeCaseId;
  if (!caseId) {
    setCompletionStatusMessage("Select a case before completing.");
    return;
  }
  let caseData = state.activeCase || {};
  try {
    const latest = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}`, {
      cache: "no-store",
    });
    if (latest) {
      caseData = latest;
      state.activeCase = latest;
      const caseState = resolveCaseState(latest);
      updateCompleteAction(latest, caseState);
      renderCaseOverview(latest);
    }
  } catch (err) {
    console.warn("Unable to refresh case status", err);
  }
  if (!areCompletionTasksComplete(caseData)) {
    showCompleteLockMessage();
    return;
  }
  clearCompleteLockMessage();
  const statusKey = normalizeCaseStatus(caseData?.status);
  const caseState = resolveCaseState(caseData);
  if (
    caseState !== CASE_STATES.FUNDED_IN_PROGRESS ||
    caseData?.readOnly ||
    caseData?.paymentReleased ||
    statusKey === "completed"
  ) {
    setCompletionStatusMessage(resolveCompletionIneligibleReason(caseData, caseState));
    return;
  }
  const originalText = caseCompleteButton?.textContent || "";
  if (caseCompleteButton) {
    caseCompleteButton.disabled = true;
  }
  const confirmed = await openCompleteConfirmModal();
  if (!confirmed) {
    if (caseCompleteButton) {
      caseCompleteButton.disabled = false;
    }
    return;
  }
  state.completing = true;
  let completionSucceeded = false;
  startReleaseFundsAnimation();
  try {
    await fetchCSRF().catch(() => "");
    await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/complete`, { method: "POST" });
    stopReleaseFundsAnimation();
    const confirmation = "Payment released. Case completed and archived.";
    setCompletionStatusMessage(confirmation);
    showMsg(messageStatus, confirmation);
    completionSucceeded = true;
    if (caseCompleteButton) {
      caseCompleteButton.hidden = true;
    }
    removeWorkspaceActions();
    const completionRedirect = getCompletionRedirect({
      ...(caseData || {}),
      status: "completed",
      paymentReleased: true,
      readOnly: true,
    });
    if (completionRedirect) {
      window.location.href = completionRedirect;
      return;
    }
    await loadCase(caseId);
  } catch (err) {
    stopReleaseFundsAnimation();
    setCompletionStatusMessage(err.message || "Unable to complete this case.");
  } finally {
    stopReleaseFundsAnimation();
    state.completing = false;
    if (caseCompleteButton && !completionSucceeded) {
      caseCompleteButton.disabled = false;
      caseCompleteButton.textContent = originalText || "Complete & Release Funds";
    }
  }
}

async function handleRequestWithdrawal() {
  if (state.withdrawing) return;
  const caseId = state.activeCaseId;
  if (!caseId) return;
  const caseData = state.activeCase || {};
  const tasks = getCaseTasks(caseData);
  const completedCount = countCompletedTasks(caseData);
  const confirmed = await openWithdrawalConfirmModal({
    completedCount,
    totalTasks: tasks.length,
  });
  if (!confirmed) return;
  state.withdrawing = true;
  if (caseWithdrawButton) caseWithdrawButton.disabled = true;
  showMsg(caseWithdrawStatus, "Submitting withdrawal request...");
  try {
    await fetchCSRF().catch(() => "");
    await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/withdraw`, { method: "POST" });
    try {
      const title = caseData?.title || "this case";
      sessionStorage.setItem(
        "lpc-withdrawal-toast",
        JSON.stringify({ message: "You have successfully withdrawn from this case.", type: "success" })
      );
    } catch {}
    showMsg(caseWithdrawStatus, "You have successfully withdrawn from this case.");
    window.location.href = "dashboard-paralegal.html#cases";
    return;
  } catch (err) {
    showMsg(caseWithdrawStatus, err.message || "Unable to withdraw from case.");
  } finally {
    state.withdrawing = false;
    if (caseWithdrawButton) caseWithdrawButton.disabled = false;
  }
}

async function handlePartialPayout() {
  if (state.partialPayoutSubmitting) return;
  const caseId = state.activeCaseId;
  if (!caseId) return;
  const caseData = state.activeCase || {};
  const statusNode = resolveCaseActionStatusNode();
  let remainingCents = resolveRemainingAmount(caseData);
  if (!Number.isFinite(remainingCents)) {
    remainingCents = Number(caseData?.lockedTotalAmount ?? caseData?.totalAmount ?? 0);
  }
  if (!Number.isFinite(remainingCents) || remainingCents < 0) {
    if (statusNode) showMsg(statusNode, "Remaining case amount is unavailable.");
    return;
  }
  const currency = String(caseData?.currency || "USD").toUpperCase();
  const amountCents = await openPartialPayoutModal({ maxCents: remainingCents, currency });
  if (!Number.isFinite(amountCents)) return;
  state.partialPayoutSubmitting = true;
  if (casePartialPayoutButton) casePartialPayoutButton.disabled = true;
  if (statusNode) showMsg(statusNode, "Finalizing partial payout...");
  try {
    await fetchCSRF().catch(() => "");
    await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/partial-payout`, {
      method: "POST",
      body: { amountCents },
    });
    if (statusNode) showMsg(statusNode, "Partial payout finalized. Case relisted.");
    await loadCase(caseId);
  } catch (err) {
    if (statusNode) showMsg(statusNode, err.message || "Unable to finalize partial payout.");
  } finally {
    state.partialPayoutSubmitting = false;
    if (casePartialPayoutButton) casePartialPayoutButton.disabled = false;
  }
}

async function handleRejectPayout() {
  if (state.rejecting) return;
  const caseId = state.activeCaseId;
  if (!caseId) return;
  const confirmed = await openRejectPayoutConfirmModal();
  if (!confirmed) return;
  state.rejecting = true;
  const statusNode = resolveCaseActionStatusNode();
  if (statusNode) showMsg(statusNode, "Closing without release...");
  try {
    await fetchCSRF().catch(() => "");
    await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/reject-payout`, { method: "POST" });
    if (statusNode) {
      showMsg(
        statusNode,
        "Closing without release will pause the case for 24 hours before it becomes eligible to be relisted."
      );
    }
    await loadCase(caseId);
  } catch (err) {
    if (statusNode) showMsg(statusNode, err.message || "Unable to close without release.");
  } finally {
    state.rejecting = false;
  }
}

async function handleRelistCase() {
  if (state.relisting) return;
  const caseId = state.activeCaseId;
  if (!caseId) return;
  const statusNode = resolveCaseActionStatusNode();
  state.relisting = true;
  if (caseRelistButton) caseRelistButton.disabled = true;
  if (statusNode) showMsg(statusNode, "Relisting case...");
  try {
    await fetchCSRF().catch(() => "");
    await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/relist`, { method: "POST" });
    if (statusNode) showMsg(statusNode, "Case relisted.");
    await loadCase(caseId);
  } catch (err) {
    if (statusNode) showMsg(statusNode, err.message || "Unable to relist case.");
  } finally {
    state.relisting = false;
    if (caseRelistButton) caseRelistButton.disabled = false;
  }
}

async function handleFlagAction() {
  const role = getCurrentUserRole();
  const caseData = state.activeCase || {};
  if (role === "paralegal") {
    const action = await openParalegalFlagMenu(caseData);
    if (action === "withdraw") {
      await handleRequestWithdrawal();
      return;
    }
    if (action === "dispute") {
      await handleDisputeCase();
    }
    return;
  }
  if (role === "attorney") {
    const actionState = getAttorneyWithdrawalActionState(caseData);
    if (actionState.eligible) {
      const action = await openAttorneyFlagMenu(caseData, actionState);
    if (action === "partial") {
      await handlePartialPayout();
      return;
    }
    if (action === "reject") {
      await handleRejectPayout();
      return;
    }
    if (action === "relist") {
      await handleRelistCase();
    }
    return;
  }
  }
  await handleDisputeCase();
}

async function handleDisputeCase() {
  if (state.disputing) return;
  const caseId = state.activeCaseId;
  if (!caseId) return;
  const caseData = state.activeCase || {};
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (["disputed", "closed", "completed"].includes(statusKey)) {
    updateDisputeAction(caseData);
    return;
  }
  const { confirmed, message } = await openDisputeConfirmModal();
  if (!confirmed) return;
  state.disputing = true;
  if (caseDisputeButton) caseDisputeButton.disabled = true;
  showMsg(caseDisputeStatus, "Opening dispute...");
  try {
    await fetchCSRF().catch(() => "");
    const note = (message || "").trim() || "Dispute flagged from the case workspace.";
    await fetchJSON(`/api/disputes/${encodeURIComponent(caseId)}`, {
      method: "POST",
      body: { message: note },
    });
    showMsg(
      caseDisputeStatus,
      "Workspace paused - Paralegal requested admin assistance. We'll resolve this within 24 hours."
    );
    showMsg(
      messageStatus,
      "Workspace paused - Paralegal requested admin assistance. We'll resolve this within 24 hours."
    );
    await loadCase(caseId);
  } catch (err) {
    showMsg(caseDisputeStatus, err.message || "Unable to open dispute.");
    if (caseDisputeButton) caseDisputeButton.disabled = false;
  } finally {
    state.disputing = false;
  }
}

function renderThreadItems(messages, documents, caseId) {
  if (!messageList) return;
  const shouldScroll = state.forceScrollToBottom || shouldAutoScroll();
  emptyNode(messageList);
  state.forceScrollToBottom = false;

  const items = [];
  messages.forEach((msg) => {
    items.push({ type: "message", createdAt: msg?.createdAt || msg?.created, data: msg });
  });
  documents.forEach((doc) => {
    items.push({ type: "document", createdAt: doc?.createdAt || doc?.uploadedAt || doc?.created, data: doc });
  });

  items.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });

  if (messagePanelDivider) {
    const firstWithDate = items.find((item) => item.createdAt);
    const dividerDate = firstWithDate?.createdAt ? new Date(firstWithDate.createdAt) : new Date();
    const formatted = formatDate(dividerDate);
    messagePanelDivider.textContent = formatted || "Today";
  }

  if (!items.length) {
    const li = document.createElement("li");
    const empty = document.createElement("div");
    empty.className = "thread-card";
    empty.textContent = "No messages yet. Use the thread below to coordinate work.";
    li.appendChild(empty);
    messageList.appendChild(li);
  } else {
    let previousMeta = null;
    items.forEach((item) => {
      const li = document.createElement("li");
      const senderKey =
        item.type === "message" ? getMessageSenderKey(item.data) : getDocumentSenderKey(item.data);
      const timeValue = getItemTimestamp(item.createdAt);
      if (previousMeta && senderKey && senderKey === previousMeta.senderKey) {
        const closeInTime =
          !timeValue ||
          !previousMeta.timeValue ||
          Math.abs(timeValue - previousMeta.timeValue) <= 5 * 60 * 1000;
        if (closeInTime) li.classList.add("is-grouped");
      }
      if (item.type === "message") {
        li.appendChild(buildMessageCard(item.data));
      } else {
        const card = buildDocumentCard(item.data, caseId);
        card.classList.add("message-card");
        if (isOutgoingDocument(item.data)) {
          card.classList.add("is-outgoing");
        }
        li.appendChild(card);
      }
      messageList.appendChild(li);
      previousMeta = { senderKey, timeValue };
    });
  }
  if (shouldScroll) {
    requestAnimationFrame(() => scrollMessagesToBottom());
  }
}

function renderSharedDocuments(documents, caseId, { emptyMessage } = {}) {
  if (!caseSharedDocuments || !caseSharedDocumentsEmpty) return;
  emptyNode(caseSharedDocuments);
  const list = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const currentRole = getCurrentUserRole();
  caseSharedDocuments.classList.toggle("case-documents-attorney", currentRole === "attorney");
  if (!list.length) {
    caseSharedDocuments.hidden = true;
    caseSharedDocumentsEmpty.textContent = emptyMessage || "No documents shared yet.";
    caseSharedDocumentsEmpty.hidden = false;
    return;
  }

  caseSharedDocuments.hidden = false;
  caseSharedDocumentsEmpty.hidden = true;

  const sorted = [...list].sort((a, b) => {
    const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });

  sorted.forEach((documentData) => {
    const fileName = documentData?.originalName || documentData?.filename || documentData?.name || "Document";
    const docId = documentData?.id || documentData?._id || "";
    const storageKey = documentData?.storageKey || documentData?.key || "";
    const previewKey = documentData?.previewKey || documentData?.previewStorageKey || "";
    const createdAt = documentData?.createdAt || documentData?.uploadedAt || documentData?.created || "";
    const statusValue = normalizeRole(documentData?.status);
    const mimeType = documentData?.mimeType || documentData?.mime || "";
    const downloadUrl =
      caseId && docId ? `/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(docId)}/download` : "";
    const viewUrl = buildViewUrl({ caseId, storageKey, previewKey });
    const previewMimeType = documentData?.previewMimeType || documentData?.previewMime || "";
    const canPreview = isPreviewSupported({
      fileName,
      mimeType: previewMimeType || documentData?.mimeType || documentData?.mime || "",
    });

    const li = document.createElement("li");
    li.className = "case-documents-item";

    const meta = document.createElement("div");
    meta.className = "case-documents-meta";
    const nameNode = document.createElement("span");
    nameNode.textContent = fileName;
    const subNode = document.createElement("span");
    subNode.className = "case-documents-sub";
    subNode.textContent = createdAt ? `Shared ${formatDate(createdAt)}` : "Shared document";
    meta.append(nameNode, subNode);
    meta.setAttribute("role", "button");
    meta.setAttribute("tabindex", "0");
    meta.setAttribute("aria-label", `Open ${fileName}`);

    li.append(meta);
    const openPreview = () => {
      openDocumentPreview({
        fileName,
        viewUrl,
        mimeType,
        caseId,
        storageKey,
        uploadedAt: createdAt,
        uploaderName: formatUploaderName(documentData, state.activeCase),
      });
    };
    meta.addEventListener("click", openPreview);
    meta.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPreview();
      }
    });
    const uploadRole = getDocumentUploadRole(documentData);
    if (currentRole === "attorney" && uploadRole === "paralegal") {
      li.classList.add("has-actions");
      const actions = document.createElement("div");
      actions.className = "case-documents-actions";
      const approveLabel = document.createElement("label");
      approveLabel.className = "case-documents-approve";
      const approveInput = document.createElement("input");
      approveInput.type = "checkbox";
      const isApproved = statusValue === "approved";
      const isRevision = statusValue === "attorney_revision";
      approveInput.checked = isApproved;
      approveInput.disabled = !docId;
      const approveText = document.createElement("span");
      approveText.textContent = isApproved ? "Approved" : "Approve";
      if (isApproved) approveLabel.classList.add("is-approved");
      approveLabel.append(approveInput, approveText);
      actions.append(approveLabel);

      const requestLabel = document.createElement("label");
      requestLabel.className = "case-documents-request";
      const requestInput = document.createElement("input");
      requestInput.type = "checkbox";
      requestInput.checked = isRevision;
      requestInput.disabled = !docId;
      const requestText = document.createElement("span");
      requestText.textContent = isRevision ? "Revisions requested" : "Request revisions";
      if (isRevision) requestLabel.classList.add("is-requested");
      requestLabel.append(requestInput, requestText);
      actions.append(requestLabel);
      li.append(actions);

      const setActionState = (nextStatus) => {
        const approved = normalizeRole(nextStatus) === "approved";
        const revision = normalizeRole(nextStatus) === "attorney_revision";
        approveInput.checked = approved;
        requestInput.checked = revision;
        approveText.textContent = approved ? "Approved" : "Approve";
        requestText.textContent = revision ? "Revisions requested" : "Request revisions";
        approveLabel.classList.toggle("is-approved", approved);
        requestLabel.classList.toggle("is-requested", revision);
        approveInput.disabled = !docId;
        requestInput.disabled = !docId;
      };

      const setBusy = (busyLabel) => {
        approveInput.disabled = true;
        requestInput.disabled = true;
        if (busyLabel === "approve") approveText.textContent = "Updating...";
        if (busyLabel === "request") requestText.textContent = "Updating...";
      };

      approveInput.addEventListener("change", async () => {
        if (!docId) return;
        const previousStatus = documentData.status || "pending_review";
        const nextStatus = approveInput.checked ? "approved" : "pending_review";
        setBusy("approve");
        try {
          await updateCaseFileStatus(caseId, docId, nextStatus);
          documentData.status = nextStatus;
          setActionState(nextStatus);
        } catch (err) {
          setActionState(previousStatus);
          showMsg(messageStatus, err.message || "Unable to update document.");
        }
      });

      requestInput.addEventListener("change", async () => {
        if (!docId) return;
        const previousStatus = documentData.status || "pending_review";
        const nextStatus = requestInput.checked ? "attorney_revision" : "pending_review";
        setBusy("request");
        try {
          await updateCaseFileStatus(caseId, docId, nextStatus);
          documentData.status = nextStatus;
          setActionState(nextStatus);
          if (nextStatus === "attorney_revision") {
            await queueDocumentForResend({ caseId, docId, fileName, mimeType, storageKey });
            applyRevisionMessageTemplate(fileName);
          }
        } catch (err) {
          setActionState(previousStatus);
          showMsg(messageStatus, err.message || "Unable to update document.");
        }
      });
    }
    caseSharedDocuments.appendChild(li);
  });
}

function buildMessageCard(message) {
  const sender = message?.senderId || {};
  const name = formatPerson(sender);
  const role = message?.senderRole || sender?.role || "Participant";
  const created = message?.createdAt || message?.created || "";
  const body = message?.text || message?.content || "";
  const avatarUrl = getAvatarUrl(message, sender);
  const isOutgoing = isOutgoingMessage(message);

  const card = document.createElement("article");
  card.className = "thread-card message-card";
  if (message?._id) card.dataset.messageId = message._id;
  if (isOutgoing) {
    card.classList.add("is-outgoing");
  }

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = `${name} avatar`;
    avatar.appendChild(img);
  } else {
    avatar.textContent = getInitials(name);
  }

  const header = document.createElement("header");
  header.className = "card-header";

  const title = document.createElement("h3");
  title.textContent = name;
  const roleNode = document.createElement("p");
  roleNode.className = "card-role";
  roleNode.textContent = role;
  header.append(title, roleNode);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "card-body";
  const bodyText = document.createElement("p");
  bodyText.textContent = body || "Message content unavailable.";
  bodyWrap.appendChild(bodyText);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.append(header, bodyWrap);

  const time = document.createElement("time");
  time.className = "message-time";
  if (created) time.setAttribute("datetime", created);
  time.textContent = created ? formatTime(created) : "";
  if (!created) time.classList.add("is-empty");

  const content = document.createElement("div");
  content.className = "message-content";
  content.append(bubble, time);

  card.append(avatar, content);
  return card;
}

function buildDocumentCard(documentData, caseId) {
  const fileName = documentData?.originalName || documentData?.filename || documentData?.name || "Document";
  const docId = documentData?.id || documentData?._id || "";
  const storageKey = documentData?.storageKey || documentData?.key || "";
  const mimeType = documentData?.mimeType || documentData?.mime || "";
  const createdAt = documentData?.createdAt || documentData?.uploadedAt || documentData?.created || "";
  const uploaderName = formatUploaderName(documentData, state.activeCase);
  const viewUrl = buildViewUrl({ caseId, storageKey });

  const card = document.createElement("article");
  card.className = "thread-card document-card";
  if (docId) card.dataset.documentId = docId;

  const header = document.createElement("header");
  header.className = "card-header";
  const title = document.createElement("a");
  title.className = "document-link";
  const icon = document.createElement("span");
  icon.className = "document-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  `;
  const label = document.createElement("span");
  label.className = "document-label";
  label.textContent = fileName;
  title.append(icon, label);
  title.href = viewUrl || "#";
  title.addEventListener("click", (event) => {
    event.preventDefault();
    openDocumentPreview({
      fileName,
      viewUrl,
      mimeType,
      caseId,
      storageKey,
      uploadedAt: createdAt,
      uploaderName,
    });
  });
  const titleWrap = document.createElement("h3");
  titleWrap.appendChild(title);
  header.append(titleWrap);

  card.append(header);
  return card;
}

function buildDefinition(term, value) {
  const wrapper = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = value || "-";
  wrapper.append(dt, dd);
  return wrapper;
}

async function loadCase(caseId) {
  if (!caseId) return;
  stopMessagePolling();
  stopCaseStream();
  setActiveCase(caseId);
  state.forceScrollToBottom = true;
  await restorePendingAttachments(caseId);
  showMsg(messageStatus, "Loading case data...");
  try {
    const caseData = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}`);
    if (getCurrentUserRole() === "paralegal" && isWithdrawnViewer(caseData)) {
      window.location.href = "dashboard-paralegal.html#cases";
      return;
    }
    state.activeCase = caseData;
    renderCaseNavList();
    if (showParalegalCompletionOverlay(caseData)) {
      return;
    }
    const completionRedirect = getCompletionRedirect(caseData);
    if (completionRedirect) {
      removeWorkspaceActions();
      window.location.href = completionRedirect;
      return;
    }
    if (!isWorkspaceEligibleCase(caseData) && !shouldAllowCaseDetail(caseData)) {
      window.location.href = getWorkspaceRedirect(caseData);
      return;
    }
    const caseState = resolveCaseState(caseData);
    renderParticipants(caseData);
    renderCaseOverview(caseData);
    updateCompleteAction(caseData, caseState);
    maybePromptAttorneyWithdrawalDecision(caseData);
    const workspace = getWorkspaceState(caseData, caseState);
    const suppressLockStatus = !workspace.ready && isWithdrawalPause(caseData);
    setWorkspaceEnabled(workspace.ready, suppressLockStatus ? null : workspace.reason);
    if (!workspace.ready) {
      renderWorkspaceLocked(workspace.reason);
      showMsg(messageStatus, suppressLockStatus ? "" : workspace.reason);
      return;
    }

    let messages = [];
    let documents = [];
    let serverDocuments = [];
    const cachedDocuments = state.caseDocumentsById.get(caseId) || [];
    const optimisticDocuments = getOptimisticDocumentsForCase(caseId);
    state.taskSnapshots.set(caseId, getTaskSnapshot(caseData));

    try {
      const messagesData = await fetchJSON(`/api/messages/${encodeURIComponent(caseId)}`, {
        cache: "no-store",
      });
      messages = normalizeMessages(messagesData);
    } catch (err) {
      showMsg(messageStatus, err.message || "Unable to load messages.");
    }

    state.messageCacheByCase.set(caseId, messages);
    state.messageSnapshots.set(caseId, getMessageSnapshot(messages));
    renderThreadItems(messages, optimisticDocuments, caseId);

    try {
      const documentsData = await fetchJSON(`/api/uploads/case/${encodeURIComponent(caseId)}`, {
        cache: "no-store",
      });
      serverDocuments = normalizeDocuments(documentsData);
      state.caseDocumentsById.set(caseId, serverDocuments);
    } catch {
      serverDocuments = cachedDocuments;
    }

    documents = mergeDocuments(serverDocuments, optimisticDocuments);
    state.optimisticDocuments = pruneOptimisticDocuments(state.optimisticDocuments, serverDocuments, caseId);

    renderSharedDocuments(documents, caseId);
    renderThreadItems(messages, documents, caseId);
    markCaseMessagesRead(caseId, messages);
    state.documentSnapshots.set(caseId, getDocumentSnapshot(serverDocuments));
    if (state.unreadByCase.has(caseId)) {
      state.unreadByCase.set(caseId, 0);
      renderCaseList();
    }
    const streamStarted = startCaseStream(caseId);
    if (!streamStarted) {
      startMessagePolling();
    }
    showMsg(messageStatus, "");
  } catch (err) {
    if ((err?.status === 403 || err?.status === 404) && getCurrentUserRole() === "paralegal") {
      window.location.href = "dashboard-paralegal.html#cases";
      return;
    }
    showMsg(messageStatus, err.message || "Unable to load case.");
  }
}

function getLatestMessageTimestamp(messages = []) {
  let latest = 0;
  messages.forEach((msg) => {
    const stamp = msg?.createdAt || msg?.created || msg?.updatedAt;
    if (!stamp) return;
    const time = new Date(stamp).getTime();
    if (!Number.isNaN(time)) {
      latest = Math.max(latest, time);
    }
  });
  return latest ? new Date(latest).toISOString() : null;
}

async function markCaseMessagesRead(caseId, messages = []) {
  const upTo = getLatestMessageTimestamp(messages);
  if (!caseId || !upTo) return;
  try {
    await fetchCSRF().catch(() => "");
    await fetchWithFallback([`/api/messages/${encodeURIComponent(caseId)}/read`], {
      method: "POST",
      body: { upTo },
    });
  } catch (err) {
    console.warn("Unable to mark messages read", err);
  }
}

function getMessageSnapshot(messages = []) {
  let latestTime = 0;
  let latestId = "";
  messages.forEach((msg) => {
    const stamp = msg?.updatedAt || msg?.createdAt || msg?.created;
    if (!stamp) return;
    const time = new Date(stamp).getTime();
    if (Number.isNaN(time)) return;
    if (time >= latestTime) {
      latestTime = time;
      latestId = msg?._id || msg?.id || latestId;
    }
  });
  return { count: Array.isArray(messages) ? messages.length : 0, latestTime, latestId };
}

function getDocumentSnapshot(documents = []) {
  let latestTime = 0;
  let latestKey = "";
  documents.forEach((doc) => {
    const stamp = doc?.createdAt || doc?.uploadedAt || doc?.created;
    if (!stamp) return;
    const time = new Date(stamp).getTime();
    if (Number.isNaN(time)) return;
    if (time >= latestTime) {
      latestTime = time;
      latestKey = doc?.id || doc?._id || getDocumentKey(doc) || latestKey;
    }
  });
  return { count: Array.isArray(documents) ? documents.length : 0, latestTime, latestKey };
}

function getTaskSnapshot(caseData) {
  const tasks = getCaseTasks(caseData);
  const signature = tasks
    .map((task) => {
      const title = String(getTaskTitle(task) || "").trim();
      if (!title) return "";
      const completed = isTaskCompleted(task) ? "1" : "0";
      return `${title}:${completed}`;
    })
    .filter(Boolean)
    .join("|");
  return { count: tasks.length, signature };
}

function hasMessageSnapshotChanged(previous, next) {
  if (!previous) return true;
  return (
    previous.count !== next.count ||
    previous.latestTime !== next.latestTime ||
    previous.latestId !== next.latestId
  );
}

function hasDocumentSnapshotChanged(previous, next) {
  if (!previous) return true;
  return (
    previous.count !== next.count ||
    previous.latestTime !== next.latestTime ||
    previous.latestKey !== next.latestKey
  );
}

function hasTaskSnapshotChanged(previous, next) {
  if (!previous) return true;
  return previous.count !== next.count || previous.signature !== next.signature;
}

function stopMessagePolling() {
  if (state.messagePollTimer) {
    clearInterval(state.messagePollTimer);
    state.messagePollTimer = null;
  }
}

function startMessagePolling() {
  stopMessagePolling();
  if (!state.activeCaseId) return;
  state.messagePollTimer = setInterval(() => refreshCaseRealtime(), MESSAGE_POLL_INTERVAL);
}

function stopCaseStream() {
  if (state.caseEventSource) {
    state.caseEventSource.close();
    state.caseEventSource = null;
  }
  state.caseStreamActive = false;
}

function startCaseStream(caseId) {
  stopCaseStream();
  if (!caseId || typeof EventSource === "undefined") return false;
  const source = new EventSource(`/api/cases/${encodeURIComponent(caseId)}/stream`);
  state.caseEventSource = source;

  const handleRefresh = (scope) => {
    void queueRealtimeRefresh(scope);
  };

  source.addEventListener("open", () => {
    state.caseStreamActive = true;
    stopMessagePolling();
  });

  source.addEventListener("error", () => {
    state.caseStreamActive = false;
    if (!state.messagePollTimer) startMessagePolling();
  });

  source.addEventListener("messages", () => handleRefresh({ messages: true }));
  source.addEventListener("documents", () => handleRefresh({ documents: true }));
  source.addEventListener("tasks", () => handleRefresh({ tasks: true }));
  source.addEventListener("case", () =>
    handleRefresh({ messages: true, documents: true, tasks: true })
  );
  source.addEventListener("ping", () => {});

  return true;
}

function mergeRealtimeFlags(base, next) {
  const safeBase = base || {};
  const safeNext = next || {};
  return {
    messages: Boolean(safeBase.messages || safeNext.messages),
    documents: Boolean(safeBase.documents || safeNext.documents),
    tasks: Boolean(safeBase.tasks || safeNext.tasks),
  };
}

function normalizeRealtimeScope(scope) {
  if (!scope) return { messages: true, documents: true, tasks: true };
  return {
    messages: Boolean(scope.messages),
    documents: Boolean(scope.documents),
    tasks: Boolean(scope.tasks),
  };
}

async function queueRealtimeRefresh(scope) {
  const normalized = normalizeRealtimeScope(scope);
  state.pendingRealtime = mergeRealtimeFlags(state.pendingRealtime, normalized);
  if (state.messagePolling) return;
  const pending = { ...state.pendingRealtime };
  state.pendingRealtime = { messages: false, documents: false, tasks: false };
  await refreshCaseRealtime(pending);
}

async function refreshCaseRealtime(options = null) {
  const fetchMessages = options ? !!options.messages : true;
  const fetchDocuments = options ? !!options.documents : true;
  const fetchTasks = options ? !!options.tasks : true;
  const caseId = state.activeCaseId;
  if (!caseId || state.sending || state.messagePolling) {
    if (options) {
      state.pendingRealtime = mergeRealtimeFlags(state.pendingRealtime, options);
    }
    return false;
  }
  if (!state.workspaceEnabled && (fetchMessages || fetchDocuments)) {
    if (options) {
      state.pendingRealtime = mergeRealtimeFlags(state.pendingRealtime, options);
    }
    return false;
  }
  if (document.hidden) {
    if (options) {
      state.pendingRealtime = mergeRealtimeFlags(state.pendingRealtime, options);
    }
    return false;
  }
  state.messagePolling = true;
  try {
    let messages = null;
    let documents = null;
    let caseData = null;
    let messagesOk = false;
    let documentsOk = false;

    if (fetchMessages) {
      try {
        const messagesData = await fetchJSON(`/api/messages/${encodeURIComponent(caseId)}`, {
          cache: "no-store",
        });
        messages = normalizeMessages(messagesData);
        messagesOk = true;
      } catch (err) {
        console.warn("Unable to refresh messages", err);
      }
    }

    if (fetchDocuments) {
      try {
        const documentsData = await fetchJSON(`/api/uploads/case/${encodeURIComponent(caseId)}`, {
          cache: "no-store",
        });
        documents = normalizeDocuments(documentsData);
        documentsOk = true;
      } catch (err) {
        console.warn("Unable to refresh documents", err);
      }
    }

    if (fetchTasks && !taskUpdateInFlight) {
      try {
        caseData = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}`, {
          cache: "no-store",
        });
      } catch (err) {
        console.warn("Unable to refresh case data", err);
      }
    }

    if (caseId !== state.activeCaseId) return;

    const cachedMessages = state.messageCacheByCase.get(caseId) || [];
    const cachedDocuments = state.caseDocumentsById.get(caseId) || [];
    const optimisticDocuments = getOptimisticDocumentsForCase(caseId);
    const threadMessages = messagesOk ? messages : cachedMessages;
    const serverDocuments = documentsOk ? documents : cachedDocuments;
    const mergedDocuments = mergeDocuments(serverDocuments, optimisticDocuments);

    const messageSnapshot = getMessageSnapshot(threadMessages);
    const previousMessage = state.messageSnapshots.get(caseId);
    const documentSnapshot = getDocumentSnapshot(serverDocuments);
    const previousDocument = state.documentSnapshots.get(caseId);

    const messagesChanged =
      messagesOk && hasMessageSnapshotChanged(previousMessage, messageSnapshot);
    const documentsChanged =
      documentsOk && hasDocumentSnapshotChanged(previousDocument, documentSnapshot);

    if (messagesOk) {
      state.messageCacheByCase.set(caseId, threadMessages);
      if (messagesChanged) {
        state.messageSnapshots.set(caseId, messageSnapshot);
      }
    }
    if (documentsOk) {
      state.caseDocumentsById.set(caseId, serverDocuments);
      if (documentsChanged) {
        state.documentSnapshots.set(caseId, documentSnapshot);
      }
    }

    if (messagesChanged || documentsChanged) {
      if (documentsChanged) {
        renderSharedDocuments(mergedDocuments, caseId);
      }
      renderThreadItems(threadMessages, mergedDocuments, caseId);
      if (messagesOk) {
        markCaseMessagesRead(caseId, threadMessages);
        if (state.unreadByCase.has(caseId)) {
          state.unreadByCase.set(caseId, 0);
          renderCaseList();
        }
      }
    }

    if (caseData && !taskUpdateInFlight) {
      if (showParalegalCompletionOverlay(caseData)) {
        return true;
      }
      const completionRedirect = getCompletionRedirect(caseData);
      if (completionRedirect) {
        removeWorkspaceActions();
        window.location.href = completionRedirect;
        return true;
      }
      const taskSnapshot = getTaskSnapshot(caseData);
      const previousTask = state.taskSnapshots.get(caseId);
      if (hasTaskSnapshotChanged(previousTask, taskSnapshot)) {
        state.activeCase = { ...state.activeCase, ...caseData };
        state.taskSnapshots.set(caseId, taskSnapshot);
        renderCaseOverview(state.activeCase);
      }
    }
  } catch (err) {
    console.warn("Unable to refresh messages", err);
  } finally {
    state.messagePolling = false;
    const pending = state.pendingRealtime;
    if (pending && (pending.messages || pending.documents || pending.tasks)) {
      state.pendingRealtime = { messages: false, documents: false, tasks: false };
      await refreshCaseRealtime(pending);
    }
  }
  return true;
}

async function handleSendMessage(event) {
  event.preventDefault();
  const caseId = state.activeCaseId;
  if (!caseId) return;
  state.forceScrollToBottom = true;
  const text = (messageInput?.value || "").trim();
  const attachments = state.pendingAttachments.filter((entry) => entry.status === "pending");
  if (!text && !attachments.length) return;
  if (state.sending) return;
  state.sending = true;
  showMsg(messageStatus, attachments.length ? "Preparing uploads..." : "Sending message...");

  try {
    await fetchCSRF().catch(() => "");
    if (attachments.length) {
      const total = attachments.length;
      let current = 0;
      for (const entry of attachments) {
        current += 1;
        updateUploadStatus(current, total);
        entry.status = "uploading";
        entry.progress = 0;
        renderPendingAttachment();
        try {
          await uploadAttachment(entry, caseId, text);
        } catch (err) {
          if (err.code === "canceled") {
            continue;
          }
          throw err;
        }
      }
      state.pendingAttachments = state.pendingAttachments.filter((entry) => entry.status !== "uploaded");
      renderPendingAttachment();
    }

    if (text) {
      showMsg(messageStatus, "Sending message...");
      await fetchJSON(`/api/messages/${encodeURIComponent(caseId)}`, {
        method: "POST",
        body: { text, content: text, caseId },
      });
      messageInput.value = "";
      autoResizeMessageInput();
    }

    await loadCase(caseId);
    showMsg(messageStatus, "");
  } catch (err) {
    showMsg(messageStatus, err.message || "Unable to send update.");
  } finally {
    state.sending = false;
  }
}

function handleCaseListClick(event) {
  const button = event.target.closest(".case-card");
  if (!button) return;
  const caseId = button.dataset.caseId;
  if (!caseId || caseId === state.activeCaseId) return;
  loadCase(caseId);
}

function handleCaseSelect(event) {
  const selectedId = String(event.target.value || "");
  if (!selectedId || selectedId === state.activeCaseId) return;
  loadCase(selectedId);
}

function handleTabClick(event) {
  const tab = event.target;
  if (!tab || !tab.hasAttribute("role")) return;
  const label = String(tab.textContent || "").toLowerCase();
  state.filter = label.includes("unread") ? "unread" : "active";
  caseTabs.forEach((btn) => btn.setAttribute("aria-selected", btn === tab ? "true" : "false"));
  renderCaseList();
}

function setCaseNavStatus(message) {
  caseNavStatuses.forEach((node) => {
    if (node) node.textContent = message;
  });
}

function getActiveCases(list = []) {
  return (list || []).filter((item) => {
    const status = String(item?.status || "").toLowerCase();
    if (item?.isArchived) return false;
    if (status === "archived") return false;
    return true;
  });
}

function populateCaseSelect() {
  if (!caseSelect) return;
  const optionsList = [];
  const active = state.activeCase;
  const activeId = active ? getCaseId(active) : "";
  const selectableCases = state.caseOptions.length ? state.caseOptions : state.cases;
  if (active && activeId && !selectableCases.some((item) => getCaseId(item) === activeId)) {
    optionsList.push(active);
  }
  optionsList.push(...selectableCases);

  if (!optionsList.length) {
    caseSelect.innerHTML = "";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "No active cases";
    caseSelect.appendChild(emptyOption);
    caseSelect.disabled = true;
    return;
  }

  const sorted = [...optionsList].sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });

  caseSelect.disabled = false;
  caseSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a case";
  caseSelect.appendChild(placeholder);
  sorted.forEach((item) => {
    const id = getCaseId(item);
    if (!id) return;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = item?.title || "Case";
    caseSelect.appendChild(option);
  });
  updateCaseSelectSelection();
}

function updateCaseSelectSelection() {
  if (!caseSelect) return;
  const activeId = state.activeCaseId || "";
  if (!activeId) {
    caseSelect.value = "";
    return;
  }
  const hasOption = Array.from(caseSelect.options).some((option) => option.value === activeId);
  if (!hasOption) {
    populateCaseSelect();
    return;
  }
  caseSelect.value = activeId;
}

function renderCaseNavList() {
  if (!caseNavLists.length) return;
  const source = state.caseOptions.length ? state.caseOptions : state.cases;
  let activeCases = getActiveCases(source);
  const currentCase = state.activeCase;
  if (currentCase) {
    const currentId = getCaseId(currentCase);
    const alreadyListed = currentId
      ? activeCases.some((item) => getCaseId(item) === currentId)
      : false;
    if (!alreadyListed) {
      activeCases = [currentCase, ...activeCases];
    }
  }
  caseNavLists.forEach((list) => {
    if (!list) return;
    emptyNode(list);
    if (!activeCases.length) return;
    activeCases.forEach((item) => {
      const caseId = getCaseId(item);
      const title = String(item?.title || item?.name || "Untitled Case");
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.className = "case-nav-link";
      link.textContent = title;
      link.href = caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}` : "case-detail.html";
      li.appendChild(link);
      list.appendChild(li);
    });
  });
  setCaseNavStatus(activeCases.length ? "" : "No active cases.");
}

function initCaseNavDropdowns() {
  caseNavToggles.forEach((toggle) => {
    toggle.addEventListener("click", (event) => {
      const dropdown = toggle.parentElement?.querySelector("[data-case-nav-dropdown]");
      if (!dropdown) return;
      const hasModifier = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (!hasModifier) {
        event.preventDefault();
      }
      const shouldOpen = !dropdown.classList.contains("show");
      dropdown.classList.toggle("show", shouldOpen);
      dropdown.setAttribute("aria-hidden", shouldOpen ? "false" : "true");
      toggle.classList.toggle("is-open", shouldOpen);
    });
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-case-nav-toggle]")) return;
    caseNavDropdowns.forEach((dropdown) => {
      dropdown.classList.remove("show");
      dropdown.setAttribute("aria-hidden", "true");
    });
    caseNavToggles.forEach((toggle) => toggle.classList.remove("is-open"));
  });
}

function getDefaultBackUrl() {
  try {
    const stored = localStorage.getItem("lpc_user");
    const user = stored ? JSON.parse(stored) : null;
    const role = String(user?.role || "").toLowerCase();
    if (role === "paralegal") return "dashboard-paralegal.html#cases";
  } catch (_) {}
  return "dashboard-attorney.html#cases";
}

function handleBackNavigation() {
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
    } catch (_) {}
  }
  window.location.href = getDefaultBackUrl();
}

function initBackButton() {
  if (!backButton) return;
  backButton.addEventListener("click", (event) => {
    event.preventDefault();
    handleBackNavigation();
  });
}

function initProfileMenu() {
  if (profileToggle && profileMenu) {
    profileToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = !profileMenu.classList.contains("show");
      document.querySelectorAll("[data-profile-menu].show").forEach((menu) => {
        if (menu !== profileMenu) menu.classList.remove("show");
      });
      profileMenu.classList.toggle("show", willOpen);
      profileToggle.setAttribute("aria-expanded", String(willOpen));
    });
  }

  accountSettingsBtn?.addEventListener("click", () => {
    window.location.href = "profile-settings.html";
  });

  logoutTrigger?.addEventListener("click", (event) => {
    event.preventDefault();
    if (typeof window.logoutUser === "function") {
      window.logoutUser(event);
    } else {
      window.location.href = "login.html";
    }
  });

  document.addEventListener("click", (event) => {
    if (!profileMenu || !profileToggle) return;
    if (profileMenu.contains(event.target) || profileToggle.contains(event.target)) return;
    profileMenu.classList.remove("show");
    profileToggle.setAttribute("aria-expanded", "false");
  });
}

function initTasksHelpPopover() {
  const tasksHelp = document.querySelector(".case-tasks-help");
  if (!tasksHelp) return;
  const summary = tasksHelp.querySelector("summary");

  document.addEventListener("click", (event) => {
    if (!tasksHelp.open) return;
    const clickedSummary = summary && (event.target === summary || summary.contains(event.target));
    if (clickedSummary) return;
    tasksHelp.open = false;
  });

  document.addEventListener("keydown", (event) => {
    if (!tasksHelp.open) return;
    if (event.key !== "Escape") return;
    tasksHelp.open = false;
    summary?.focus?.();
  });
}

function init() {
  syncThemeFromSession();
  syncRoleVisibility();
  normalizeAttorneyCaseTheme();
  loadUserHeaderInfo().catch(() => {});
  initBackButton();
  initProfileMenu();
  ensureCompleteButtonBinding();
  initTasksHelpPopover();
  initCaseNavDropdowns();
  if (messageForm) {
    messageForm.addEventListener("submit", handleSendMessage);
  }
  if (messageInput) {
    autoResizeMessageInput();
    messageInput.addEventListener("input", autoResizeMessageInput);
    messageInput.addEventListener("focus", autoResizeMessageInput);
    messageInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.sending) return;
      handleSendMessage({ preventDefault() {} });
    });
  }
  if (messageAttachment) {
    messageAttachment.addEventListener("change", handleAttachmentChange);
  }
  if (messagePanel) {
    messagePanel.addEventListener("dragenter", handleDragEnter);
    messagePanel.addEventListener("dragover", handleDragOver);
    messagePanel.addEventListener("dragleave", handleDragLeave);
    messagePanel.addEventListener("drop", handleDrop);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshCaseRealtime({ messages: true, documents: true, tasks: true });
    }
  });
  window.addEventListener("beforeunload", () => {
    stopCaseStream();
    stopMessagePolling();
  });
  if (caseList) {
    caseList.addEventListener("click", handleCaseListClick);
  }
  if (caseSelect) {
    caseSelect.addEventListener("change", handleCaseSelect);
  }
  if (caseDisputeButton) {
    caseDisputeButton.addEventListener("click", handleFlagAction);
  }
  if (caseWithdrawButton) {
    caseWithdrawButton.addEventListener("click", handleRequestWithdrawal);
  }
  if (casePartialPayoutButton) {
    casePartialPayoutButton.addEventListener("click", handlePartialPayout);
  }
  if (caseRelistButton) {
    caseRelistButton.addEventListener("click", handleRelistCase);
  }
  caseTabs.forEach((tab) => tab.addEventListener("click", handleTabClick));
  if (messageList) {
    messageList.addEventListener("submit", (event) => {
      if (event.target?.dataset?.documentCommentForm) {
        event.preventDefault();
        showMsg(messageStatus, "Commenting will be available soon.");
      }
    });
  }

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("caseId");
  loadCases()
    .then(loadUnreadCounts)
    .then(() => {
      const source = state.caseOptions.length ? state.caseOptions : state.cases;
      const initial = fromQuery || (source[0] ? getCaseId(source[0]) : "");
      if (initial) {
        loadCase(initial);
        return;
      }
      showMsg(caseListStatus, "");
      setCaseNavStatus("No active cases.");
    })
    .catch((err) => {
      showMsg(caseListStatus, err.message || "Unable to load cases.");
    });
}

init();
