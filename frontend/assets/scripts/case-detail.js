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
const caseOverviewTasks = document.querySelector(".case-overview-tasks");
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
  lockedTaskKeys: new Map(),
  pendingRealtime: { messages: false, documents: false, tasks: false },
  caseEventSource: null,
  caseStreamActive: false,
  messagePollTimer: null,
  messagePolling: false,
  threadResetAt: null,
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
  blockingFutureInteraction: false,
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

function escapeHTML(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
});
const sharedDocumentsTwoColumnMedia = window.matchMedia("(max-width: 1200px) and (min-width: 901px)");

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

function syncSharedDocumentsHeightLimit() {
  if (!caseSharedDocuments) return;
  if (!sharedDocumentsTwoColumnMedia.matches) {
    caseSharedDocuments.style.removeProperty("--case-documents-visible-height");
    return;
  }
  const items = Array.from(caseSharedDocuments.children).filter((node) => node instanceof HTMLElement);
  if (items.length <= 3) {
    caseSharedDocuments.style.removeProperty("--case-documents-visible-height");
    return;
  }
  const computed = window.getComputedStyle(caseSharedDocuments);
  const gap = parseFloat(computed.rowGap || computed.gap || "0") || 0;
  const height = items
    .slice(0, 3)
    .reduce((total, item) => total + item.getBoundingClientRect().height, 0) + gap * 2;
  caseSharedDocuments.style.setProperty("--case-documents-visible-height", `${Math.ceil(height)}px`);
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

function getWithdrawnParalegalName(caseData) {
  if (!caseData) return "Paralegal";
  const withdrawn = caseData.withdrawnParalegalId;
  if (withdrawn && typeof withdrawn === "object") {
    return formatPerson(withdrawn);
  }
  if (caseData.paralegalNameSnapshot) return caseData.paralegalNameSnapshot;
  if (caseData.paralegal) return formatPerson(caseData.paralegal);
  if (caseData.paralegalId && typeof caseData.paralegalId === "object") {
    return formatPerson(caseData.paralegalId);
  }
  return "Paralegal";
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

function maybeShowAttorneyWithdrawalNotice(previousCase, nextCase) {
  if (getCurrentUserRole() !== "attorney") return;
  if (!nextCase) return;
  const statusKey = normalizeCaseStatus(nextCase?.status);
  if (statusKey !== "paused") return;
  if (String(nextCase?.pausedReason || "") !== "paralegal_withdrew") return;
  if (!previousCase) return;
  if (
    previousCase.pausedReason === "paralegal_withdrew" &&
    normalizeCaseStatus(previousCase.status) === "paused"
  ) {
    return;
  }
  const caseId = nextCase?.id || nextCase?._id || state.activeCaseId || "";
  const stamp = nextCase?.pausedAt || "withdrawal";
  const noticeKey = `lpc-attorney-withdrawal:${caseId}:${stamp}`;
  if (state.withdrawalNoticeKey === noticeKey) return;
  state.withdrawalNoticeKey = noticeKey;
  const actionState = getAttorneyWithdrawalActionState(nextCase);
  if (!actionState?.eligible) return;
  setTimeout(async () => {
    if (state.activeCaseId && String(state.activeCaseId) !== String(caseId)) return;
    const action = await openAttorneyFlagMenu(nextCase, actionState);
    await handleWithdrawalActionSelection(action, nextCase, actionState);
  }, 0);
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
  const role = getCurrentUserRole();
  if (!["paralegal", "attorney"].includes(role)) return false;
  if (!caseData) return false;
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (["disputed", "closed", "completed"].includes(statusKey)) return false;
  return true;
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
    .case-action-btn:focus,
    .case-action-btn:focus-visible{
      outline:none;
      box-shadow:none;
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
      color:var(--app-text);
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
    .case-dispute-title{
      font-weight:500;
      font-size:1.4rem;
      text-align:center;
      font-family:"Cormorant Garamond", var(--font-serif, serif);
    }
    .case-dispute-help{color:var(--app-muted);font-size:.92rem;line-height:1.55}
    .case-dispute-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
    .case-dispute-actions .case-action-btn{font-weight:250}
    .case-dispute-modal input[type="number"],
    .case-dispute-modal textarea{width:100%;border-radius:12px;border:1px solid var(--app-border-soft);padding:10px 12px;font-family:var(--font-sans)}
    .case-dispute-modal input[type="number"]{min-height:44px}
    .case-dispute-modal textarea{min-height:88px;resize:vertical}
    .case-dispute-modal label{display:grid;gap:6px;font-size:.9rem;color:var(--app-muted)}
    .case-dispute-footer{color:var(--app-muted);font-size:9pt;line-height:1.55;text-align:right}
  `;
  document.head.appendChild(style);
}

function openDisputeConfirmModal({ showAmount = false } = {}) {
  return new Promise((resolve) => {
    ensureDisputeModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-dispute-overlay";
    const amountField = showAmount
      ? `
        <label>
          <span>Amount you believe you're owed (optional)</span>
          <input type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" data-dispute-amount>
        </label>
      `
      : "";
    overlay.innerHTML = `
      <div class="case-dispute-modal" role="dialog" aria-modal="true" aria-labelledby="caseDisputeTitle">
        <div class="case-dispute-title" id="caseDisputeTitle">Flag a Dispute</div>
        ${amountField}
        <label>
          <span class="visually-hidden">Dispute details (optional)</span>
          <textarea data-dispute-message placeholder="Provide details (optional)"></textarea>
        </label>
        <div class="case-dispute-actions">
          <button class="case-action-btn secondary" type="button" data-dispute-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-dispute-confirm>Flag dispute</button>
        </div>
        <p class="case-dispute-footer">Confirming will pause this workspace for both parties until the dispute is reviewed and resolved.</p>
      </div>
    `;
    const close = (confirmed) => {
      dismissPopupOverlay(overlay);
      if (!confirmed) {
        resolve({ confirmed: false, message: "", amount: "" });
        return;
      }
      const message = overlay.querySelector("[data-dispute-message]")?.value || "";
      const amount = showAmount ? overlay.querySelector("[data-dispute-amount]")?.value || "" : "";
      resolve({ confirmed: true, message, amount });
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
    .case-withdraw-title{
      font-weight:500;
      font-size:1.4rem;
      text-align:center;
      font-family:"Cormorant Garamond", var(--font-serif, serif);
    }
    .case-withdraw-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
    .case-withdraw-actions .case-action-btn{font-weight:250}
    .case-withdraw-footnote{font-size:9pt;color:var(--app-muted);text-align:right;line-height:1.55}
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
        ? "Withdrawing will pause the case. No payout will be issued because no tasks were completed."
        : "Withdrawing will close this case for you. The attorney will then decide whether to issue a partial payout based on completed work.";
    overlay.innerHTML = `
      <div class="case-withdraw-modal" role="dialog" aria-modal="true" aria-labelledby="caseWithdrawTitle">
        <div class="case-withdraw-title" id="caseWithdrawTitle">Withdraw from Case</div>
        <p>${bodyCopy}</p>
        <div class="case-withdraw-actions">
          <button class="case-action-btn secondary" type="button" data-withdraw-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-withdraw-confirm>Withdraw from Case</button>
        </div>
        <div class="case-withdraw-footnote">Payout decisions are at the sole discretion of the attorney.</div>
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

function ensureWithdrawalNoticeModalStyles() {
  if (document.getElementById("case-withdrawal-notice-styles")) return;
  const style = document.createElement("style");
  style.id = "case-withdrawal-notice-styles";
  style.textContent = `
    .tour-overlay{position:fixed;inset:0;display:none;z-index:12000;pointer-events:none}
    .tour-overlay.is-active{display:block}
    .tour-overlay::before{content:"";position:absolute;inset:0;background:rgba(10,15,25,.6)}
    .tour-modal{width:min(420px,92vw);background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(15,23,42,.35);text-align:center;display:none;z-index:12001;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%)}
    .tour-modal.is-active{display:block}
    .tour-hero{height:150px;background-image:url("hero-mountain.jpg");background-size:cover;background-position:center}
    .tour-content{padding:22px 26px 28px}
    .tour-title{font-family:var(--font-serif);font-size:1.6rem;color:var(--app-text);margin-bottom:8px;font-weight:500}
    .tour-text{color:var(--app-muted);font-size:.98rem;line-height:1.5;margin-bottom:20px}
    .tour-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
    .tour-btn{border:1px solid var(--app-border);background:var(--app-surface);color:var(--app-text);padding:10px 20px;border-radius:999px;font-weight:300;cursor:pointer;transition:transform .2s ease, box-shadow .2s ease}
    .tour-btn.primary{background:var(--accent);color:#fff;border-color:transparent;box-shadow:0 12px 24px rgba(182,164,122,.35)}
    .tour-btn:hover{transform:translateY(-1px)}
    .tour-close{position:absolute;top:10px;right:12px;width:32px;height:32px;border-radius:50%;border:1px solid var(--app-border);background:var(--app-surface);color:var(--app-text);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
    .withdrawal-decision{display:grid;gap:14px;text-align:left;margin-bottom:16px}
    .decision-card{border:1px solid var(--app-border);border-radius:16px;padding:14px 16px;display:grid;gap:6px;cursor:pointer;transition:border-color .2s ease, box-shadow .2s ease;background:var(--app-surface)}
    .decision-card.selected{border-color:var(--accent);box-shadow:0 0 0 1px rgba(182,164,122,.25)}
    .decision-title{font-weight:500;color:var(--app-text)}
    .decision-text{font-size:.9rem;color:var(--app-muted)}
    .decision-card.decision-deny{
      background:linear-gradient(135deg, var(--app-accent-soft), rgba(255,255,255,0));
      border-color:rgba(182,164,122,.35);
    }
    html.theme-dark .decision-card.decision-deny,
    body.theme-dark .decision-card.decision-deny,
    html.theme-mountain-dark .decision-card.decision-deny,
    body.theme-mountain-dark .decision-card.decision-deny{
      background:var(--app-surface);
      border-color:var(--app-border);
    }
    .decision-card.decision-deny .decision-title{
      letter-spacing:.01em;
    }
    .decision-card.decision-deny .decision-text{
      font-family:'Cormorant Garamond', serif;
      font-size:.95rem;
      color:var(--app-muted);
      line-height:1.6;
    }
    .decision-input{display:none;gap:6px;margin-top:8px}
    .decision-input.is-active{display:grid}
    .decision-input-field{position:relative;display:flex;align-items:center;justify-content:flex-end}
    .decision-prefix{
      position:absolute;
      left:12px;
      color:var(--app-muted);
      font-weight:500;
      font-size:.95rem;
      pointer-events:none;
    }
    .decision-input input{
      width:100%;
      max-width:220px;
      border-radius:12px;
      border:1px solid var(--app-border-soft);
      background:var(--app-surface);
      color:var(--app-text);
      padding:10px 12px 10px 26px;
      font-family:var(--font-sans);
    }
    .decision-caption{font-size:.85rem;color:var(--app-muted);line-height:1.4}
    .decision-error{font-size:.85rem;color:#b91c1c;min-height:1.1em}
    .decision-note{display:flex;align-items:center;gap:6px;font-size:.8rem;color:var(--app-muted)}
    .decision-note-icon{
      width:18px;
      height:18px;
      border-radius:999px;
      border:1px solid var(--app-border);
      display:inline-flex;
      align-items:center;
      justify-content:center;
      font-size:.75rem;
      font-weight:600;
      color:var(--app-muted);
      flex:0 0 auto;
    }
  `;
  document.head.appendChild(style);
}

function showWithdrawalNoticeModal({ title = "Case Paused", message = "", caseData = null } = {}) {
  const existingOverlay = document.getElementById("withdrawalNoticeOverlay");
  const existingModal = document.getElementById("withdrawalNoticeModal");
  if (existingOverlay || existingModal) {
    existingOverlay?.remove();
    existingModal?.remove();
  }
  ensureWithdrawalNoticeModalStyles();
  const overlay = document.createElement("div");
  overlay.id = "withdrawalNoticeOverlay";
  overlay.className = "tour-overlay";
  const modal = document.createElement("div");
  modal.id = "withdrawalNoticeModal";
  modal.className = "tour-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  let step = 1;
  let selection = "";
  let submitting = false;
  const caseId = caseData?.id || caseData?._id || state.activeCaseId || "";
  const currency = String(caseData?.currency || "USD").toUpperCase();
  const baseAmountCents = Number(caseData?.lockedTotalAmount ?? caseData?.totalAmount ?? 0);
  const remainingCents = Number.isFinite(resolveRemainingAmount(caseData))
    ? resolveRemainingAmount(caseData)
    : baseAmountCents;
  const capCentsRaw =
    Number.isFinite(baseAmountCents) && baseAmountCents > 0 ? Math.round(baseAmountCents * 0.7) : 0;
  const maxCents = Math.max(
    0,
    Math.min(Number.isFinite(remainingCents) ? remainingCents : baseAmountCents, capCentsRaw || 0)
  );

  const renderStepOne = () => {
    modal.innerHTML = `
      <button type="button" class="tour-close" aria-label="Close withdrawal notice">×</button>
      <div class="tour-hero" role="presentation"></div>
      <div class="tour-content">
        <div class="tour-title">${escapeHTML(title)}</div>
        <p class="tour-text">${escapeHTML(message || "The case has been paused.")}</p>
        <div class="tour-actions">
          <button type="button" class="tour-btn primary" data-withdrawal-next>Next</button>
        </div>
      </div>
    `;
  };

  const renderStepTwo = () => {
    const maxLabel = formatCurrency(maxCents / 100, currency);
    const capCopy = maxCents > 0
      ? `Max available: ${maxLabel} (70% cap of the total case amount).`
      : "Max available: 70% cap of the total case amount.";
    modal.innerHTML = `
      <button type="button" class="tour-close" aria-label="Close withdrawal notice">×</button>
      <div class="tour-hero" role="presentation"></div>
      <div class="tour-content">
        <div class="tour-title">Choose Next Step</div>
        <p class="tour-text">Please choose how you'd like to proceed.</p>
        <div class="withdrawal-decision">
          <div class="decision-card" data-decision="partial">
            <div class="decision-title">Release a partial payout</div>
            <div class="decision-input" data-decision-input>
              <div class="decision-input-field">
                <span class="decision-prefix" aria-hidden="true">$</span>
                <input type="text" inputmode="decimal" placeholder="0.00" data-payout-input />
              </div>
              <div class="decision-caption">${escapeHTML(capCopy)}</div>
              <div class="decision-note">
                <span class="decision-note-icon" aria-hidden="true">?</span>
                <span>All payments are in USD.</span>
              </div>
              <div class="decision-error" data-decision-error></div>
            </div>
          </div>
          <div class="decision-card decision-deny" data-decision="deny">
            <div class="decision-title">Close without release</div>
            <div class="decision-text">We'll start a 24-hour window for the paralegal to dispute. If no dispute is filed, the case will relist automatically.</div>
          </div>
        </div>
        <div class="tour-actions">
          <button type="button" class="tour-btn primary" data-withdrawal-submit disabled>Submit</button>
        </div>
      </div>
    `;
  };

  const close = () => {
    overlay.classList.remove("is-active");
    modal.classList.remove("is-active");
    overlay.remove();
    modal.remove();
  };

  const submitPartial = async (amountCents, statusNode) => {
    if (submitting) return;
    submitting = true;
    if (statusNode) showMsg(statusNode, "Finalizing partial payout...");
    try {
      await fetchCSRF().catch(() => "");
      await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/partial-payout`, {
        method: "POST",
        body: { amountCents },
        noRedirect: true,
      });
      if (statusNode) showMsg(statusNode, "Partial payout finalized. Case relisted.");
      await loadCase(caseId);
      close();
      const payoutLabel = formatCurrency(amountCents / 100, currency);
      showCaseActionAcknowledgement({
        title: "Partial Payout Submitted",
        message: `A partial payout of ${payoutLabel} was submitted. The case will be relisted automatically.`,
      });
    } catch (err) {
      if (statusNode) showMsg(statusNode, err.message || "Unable to finalize partial payout.");
    } finally {
      submitting = false;
    }
  };

  const submitReject = async (statusNode) => {
    if (submitting) return;
    submitting = true;
    if (statusNode) showMsg(statusNode, "Closing without release...");
    try {
      await fetchCSRF().catch(() => "");
      await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/reject-payout`, {
        method: "POST",
        noRedirect: true,
      });
      if (statusNode) {
        showMsg(
          statusNode,
          "Closing without release starts a 24-hour window for the paralegal to dispute. If no dispute is filed, the case will relist automatically."
        );
      }
      await loadCase(caseId);
      close();
    } catch (err) {
      if (statusNode) showMsg(statusNode, err.message || "Unable to close without release.");
    } finally {
      submitting = false;
    }
  };

  const bindStepOne = () => {
    modal.querySelector(".tour-close")?.addEventListener("click", close);
    modal.querySelector("[data-withdrawal-next]")?.addEventListener("click", () => {
      step = 2;
      renderStepTwo();
      bindStepTwo();
    });
  };

  const bindStepTwo = () => {
    const cards = Array.from(modal.querySelectorAll("[data-decision]"));
    const submitBtn = modal.querySelector("[data-withdrawal-submit]");
    const input = modal.querySelector("[data-payout-input]");
    const inputWrap = modal.querySelector("[data-decision-input]");
    const errorEl = modal.querySelector("[data-decision-error]");

    const updateSubmitState = () => {
      let valid = false;
      if (selection === "partial") {
        const amountCents = parseCurrencyInput(input?.value || "");
        if (Number.isFinite(amountCents) && amountCents > 0 && amountCents <= maxCents) {
          valid = true;
          if (errorEl) errorEl.textContent = "";
        } else if (errorEl) {
          errorEl.textContent =
            !Number.isFinite(amountCents) || amountCents <= 0
              ? "Enter a valid amount."
              : "Amount exceeds the 70% cap.";
        }
      } else if (selection === "deny") {
        valid = true;
        if (errorEl) errorEl.textContent = "";
      }
      if (submitBtn) submitBtn.disabled = !valid || submitting;
    };

    const setSelection = (next) => {
      selection = next;
      cards.forEach((card) => {
        card.classList.toggle("selected", card.dataset.decision === selection);
      });
      if (inputWrap) {
        inputWrap.classList.toggle("is-active", selection === "partial");
      }
      updateSubmitState();
    };

    cards.forEach((card) => {
      card.addEventListener("click", () => setSelection(card.dataset.decision || ""));
    });
    input?.addEventListener("input", () => {
      const cleaned = sanitizeCurrencyInput(input.value);
      if (cleaned !== input.value) {
        input.value = cleaned;
      }
      updateSubmitState();
    });
    modal.querySelector(".tour-close")?.addEventListener("click", close);
    submitBtn?.addEventListener("click", async () => {
      if (!selection || submitting) return;
      const statusNode = resolveCaseActionStatusNode();
      if (selection === "partial") {
        const amountCents = parseCurrencyInput(input?.value || "");
        if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > maxCents) {
          updateSubmitState();
          return;
        }
        await submitPartial(amountCents, statusNode);
        return;
      }
      await submitReject(statusNode);
    });
    updateSubmitState();
  };

  renderStepOne();
  document.body.appendChild(overlay);
  document.body.appendChild(modal);

  overlay.addEventListener("click", close);
  bindStepOne();

  requestAnimationFrame(() => {
    overlay.classList.add("is-active");
    modal.classList.add("is-active");
  });
}

function showCaseActionAcknowledgement({ title = "Update saved", message = "" } = {}) {
  ensureWithdrawalNoticeModalStyles();
  const overlay = document.createElement("div");
  overlay.className = "tour-overlay";
  const modal = document.createElement("div");
  modal.className = "tour-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `
    <button type="button" class="tour-close" aria-label="Close notice">×</button>
    <div class="tour-hero" role="presentation"></div>
    <div class="tour-content">
      <div class="tour-title">${escapeHTML(title)}</div>
      <p class="tour-text">${escapeHTML(message || "Your update has been saved.")}</p>
      <div class="tour-actions">
        <button type="button" class="tour-btn primary" data-ack-close>Close</button>
      </div>
    </div>
  `;
  const close = () => {
    overlay.classList.remove("is-active");
    modal.classList.remove("is-active");
    overlay.remove();
    modal.remove();
  };
  overlay.addEventListener("click", close);
  modal.querySelector(".tour-close")?.addEventListener("click", close);
  modal.querySelector("[data-ack-close]")?.addEventListener("click", close);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") close();
    },
    { once: true }
  );
  document.body.appendChild(overlay);
  document.body.appendChild(modal);
  requestAnimationFrame(() => {
    overlay.classList.add("is-active");
    modal.classList.add("is-active");
  });
}

function ensurePartialPayoutModalStyles() {
  if (document.getElementById("case-payout-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "case-payout-modal-styles";
  style.textContent = `
    .case-payout-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;transition:opacity .18s ease}
    .case-payout-modal{background:var(--app-surface);color:var(--app-text);border:1px solid rgba(15,23,42,.12);border-radius:22px;padding:20px 22px;max-width:440px;width:92%;box-shadow:none;display:grid;gap:0;opacity:0;transform:translateY(4px);transition:opacity .18s ease, transform .18s ease;position:relative}
    .case-payout-overlay.is-visible{opacity:1}
    .case-payout-overlay.is-visible .case-payout-modal{opacity:1;transform:translateY(0) scale(1)}
    body.theme-dark .case-payout-modal,
    html.theme-dark .case-payout-modal,
    body.theme-mountain-dark .case-payout-modal,
    html.theme-mountain-dark .case-payout-modal{
      background:#1c2333;
      border-color:rgba(255,255,255,.12);
      box-shadow:0 20px 40px rgba(0,0,0,.35);
    }
    .case-payout-title{font-weight:400;font-size:1.35rem;text-align:center;font-family:var(--font-serif);margin:0 0 6px}
    .case-payout-divider{height:1px;background:var(--app-border);margin:0 0 12px}
    .case-payout-body{display:grid;gap:0;transition:opacity .2s ease}
    .case-payout-copy{font-family:'Cormorant Garamond', serif;font-size:1rem;line-height:1.5;text-align:left;margin:0 0 12px}
    .case-payout-subcopy{display:block;margin-top:6px;color:var(--app-muted);font-size:.95rem}
    .line-item-card{
      border:0;
      border-radius:0;
      padding:0;
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:16px;
      background:transparent;
      box-shadow:none;
    }
    .line-item-details{display:flex;align-items:center;gap:12px;min-width:0;flex:1;padding-top:10px}
    .line-item-icon{display:none}
    .line-item-text{display:flex;align-items:center;gap:10px;min-width:0}
    .line-item-title{
      font-family:var(--font-serif);
      font-weight:500;
      color:var(--app-text);
      font-size:1.05rem;
      line-height:1.2;
    }
    .line-item-subtitle{font-size:.82rem;color:rgba(15,23,42,.6)}
    .line-item-amount{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-left:auto}
    .money-input{
      display:flex;
      align-items:center;
      width:200px;
      height:44px;
      border-radius:12px;
      border:1px solid rgba(15,23,42,.16);
      background:#fff;
      transition:border-color .18s ease, box-shadow .18s ease, background .18s ease;
      overflow:hidden;
    }
    .money-input:focus-within{
      border-color:rgba(182,164,122,.75);
      box-shadow:0 0 0 3px rgba(182,164,122,.18);
      background:#fff;
    }
    .money-input .prefix{
      padding:0 12px;
      color:rgba(15,23,42,.6);
      font-weight:500;
      font-size:.95rem;
      border-right:1px solid rgba(15,23,42,.14);
      height:100%;
      display:flex;
      align-items:center;
      background:rgba(15,23,42,.03);
    }
    .money-input .amount{
      flex:1;
      border:0;
      height:100%;
      padding:0 12px;
      font-family:'Sarabun', sans-serif;
      font-weight:300;
      font-size:1rem;
      font-variant-numeric:tabular-nums;
      text-align:right;
      background:transparent;
      outline:none;
    }
    .case-payout-hint{
      font-size:.8rem;
      color:rgba(15,23,42,.58);
      text-align:right;
      margin:0;
      white-space:nowrap;
    }
    .case-payout-summary{
      display:flex;
      justify-content:space-between;
      align-items:center;
      font-size:.95rem;
      margin:0 0 8px;
    }
    .case-payout-summary .summary-label{color:rgba(15,23,42,.7)}
    .case-payout-summary .summary-value{font-weight:500;color:var(--app-text)}
    .case-payout-error{font-size:.82rem;color:#b91c1c;min-height:1.1em}
    .case-payout-footer{display:flex;flex-direction:column;gap:8px;margin-top:0;padding-top:0;transition:opacity .2s ease}
    .case-payout-body.is-fading,
    .case-payout-footer.is-fading{opacity:0}
    .case-payout-actions{display:flex;flex-direction:row;flex-wrap:wrap;justify-content:flex-end;gap:10px}
    .case-payout-actions .case-action-btn{font-family:var(--font-serif);font-weight:500;letter-spacing:.02em}
    .case-payout-actions .case-action-btn.primary{width:auto}
    .case-payout-help-text{font-size:.8rem;color:rgba(15,23,42,.6);margin-top:2px}
    .case-payout-modal.is-processing .case-payout-actions .case-action-btn{cursor:progress}
    .case-payout-success{
      display:grid;
      gap:12px;
      text-align:left;
    }
    .case-payout-success-title{
      font-family:var(--font-serif);
      font-size:1.2rem;
      font-weight:500;
      color:var(--app-text);
    }
    .case-payout-success-copy{
      font-size:.95rem;
      color:var(--app-muted);
      line-height:1.5;
    }
    body.theme-dark .case-payout-subcopy,
    html.theme-dark .case-payout-subcopy,
    body.theme-mountain-dark .case-payout-subcopy,
    html.theme-mountain-dark .case-payout-subcopy,
    body.theme-dark .case-payout-help-text,
    html.theme-dark .case-payout-help-text,
    body.theme-mountain-dark .case-payout-help-text,
    html.theme-mountain-dark .case-payout-help-text,
    body.theme-dark .case-payout-hint,
    html.theme-dark .case-payout-hint,
    body.theme-mountain-dark .case-payout-hint,
    html.theme-mountain-dark .case-payout-hint{
      color:rgba(226,232,240,.85);
    }
    body.theme-dark .case-payout-summary .summary-label,
    html.theme-dark .case-payout-summary .summary-label,
    body.theme-mountain-dark .case-payout-summary .summary-label,
    html.theme-mountain-dark .case-payout-summary .summary-label{
      color:rgba(226,232,240,.85);
    }
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

function sanitizeCurrencyInput(value) {
  if (value == null) return "";
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned) return "";
  const parts = cleaned.split(".");
  if (parts.length === 1) return parts[0];
  const whole = parts.shift() || "";
  const decimals = parts.join("").slice(0, 2);
  return decimals ? `${whole}.${decimals}` : `${whole}.`;
}

function openPartialPayoutModal({ maxCents = 0, currency = "USD", paralegalName = "Paralegal" } = {}) {
  return new Promise((resolve) => {
    ensurePartialPayoutModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-payout-overlay";
    const maxLabel = formatCurrency(maxCents / 100, currency);
    const maxPlaceholder = maxLabel.replace(/[^0-9.,]/g, "");
    const safeParalegalName = escapeHTML(paralegalName);
    const capCopy = maxCents > 0
      ? `Maximum available: ${maxLabel} ${currency} (70% cap)`
      : "Maximum available: 70% cap";
    overlay.innerHTML = `
      <div class="case-payout-modal" role="dialog" aria-modal="true" aria-labelledby="casePayoutTitle">
        <div class="case-payout-title" id="casePayoutTitle" data-payout-title>Enter Partial Release</div>
        <div class="case-payout-divider" role="presentation"></div>
        <div class="case-payout-body" data-payout-body>
          <p class="case-payout-copy">
            Enter the amount to release to the withdrawn paralegal. This will finalize the case closure on your side.
          </p>
          <div class="line-item-card">
            <div class="line-item-details">
              <span class="line-item-icon" aria-hidden="true"></span>
              <div class="line-item-text">
                <span class="line-item-title">${safeParalegalName}</span>
              </div>
            </div>
            <div class="line-item-amount">
              <span class="money-input">
                <span class="prefix" aria-hidden="true">$</span>
                <input type="text" inputmode="decimal" class="amount" placeholder="${maxPlaceholder}" data-payout-input />
              </span>
              <div class="case-payout-hint">${escapeHTML(capCopy)}</div>
            </div>
          </div>
          <div class="case-payout-divider" role="presentation"></div>
          <div class="case-payout-summary">
            <span class="summary-label">Amount to release (${currency})</span>
            <span class="summary-value" data-payout-summary>—</span>
          </div>
        </div>
        <div class="case-payout-error" data-payout-error></div>
        <div class="case-payout-footer" data-payout-footer>
          <div class="case-payout-actions" data-payout-actions>
            <button class="case-action-btn secondary" type="button" data-payout-cancel>Cancel</button>
            <button class="case-action-btn primary" type="button" data-payout-confirm>Confirm Release</button>
          </div>
        </div>
      </div>
    `;
    const input = overlay.querySelector("[data-payout-input]");
    const error = overlay.querySelector("[data-payout-error]");
    const confirmBtn = overlay.querySelector("[data-payout-confirm]");
    const cancelBtn = overlay.querySelector("[data-payout-cancel]");
    const summaryValue = overlay.querySelector("[data-payout-summary]");
    const modal = overlay.querySelector(".case-payout-modal");
    const titleEl = overlay.querySelector("[data-payout-title]");
    const bodyEl = overlay.querySelector("[data-payout-body]");
    const footerEl = overlay.querySelector("[data-payout-footer]");
    const actionsEl = overlay.querySelector("[data-payout-actions]");
    const defaultTitle = titleEl?.textContent || "Enter Partial Release";
    const swapContent = (nextBodyHtml, nextFooterHtml, onDone) => {
      const duration = 180;
      if (bodyEl) bodyEl.classList.add("is-fading");
      if (footerEl) footerEl.classList.add("is-fading");
      window.setTimeout(() => {
        if (bodyEl && typeof nextBodyHtml === "string") {
          bodyEl.innerHTML = nextBodyHtml;
        }
        if (footerEl && typeof nextFooterHtml === "string") {
          footerEl.innerHTML = nextFooterHtml;
        }
        requestAnimationFrame(() => {
          if (bodyEl) bodyEl.classList.remove("is-fading");
          if (footerEl) footerEl.classList.remove("is-fading");
          if (typeof onDone === "function") onDone();
        });
      }, duration);
    };

    const updateState = () => {
      if (confirmBtn?.disabled && confirmBtn.dataset.forceDisabled === "true") return;
      const amountCents = parseCurrencyInput(input?.value || "");
      if (summaryValue) {
        summaryValue.textContent =
          Number.isFinite(amountCents) && amountCents > 0
            ? `${formatCurrency(amountCents / 100, currency)} USD`
            : "—";
      }
      let message = "";
      if (!Number.isFinite(amountCents)) {
        message = "";
      } else if (amountCents < 0) {
        message = "Amount cannot be negative.";
      } else if (amountCents > maxCents) {
        message = "Amount exceeds the 70% cap.";
      }
      if (error) error.textContent = message;
      if (confirmBtn) confirmBtn.disabled = !!message;
    };

    const close = (payload) => {
      dismissPopupOverlay(overlay);
      resolve(payload);
    };
    const resolveWithControls = (payload) => {
      resolve(payload);
    };

    let isProcessing = false;
    const setProcessing = () => {
      isProcessing = true;
      if (modal) modal.classList.add("is-processing");
      if (titleEl) titleEl.textContent = "Processing partial release";
      if (confirmBtn) {
        confirmBtn.dataset.forceDisabled = "true";
        confirmBtn.disabled = true;
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (input) input.disabled = true;
      if (error) error.textContent = "";
      swapContent(
        `
          <div class="case-payout-success">
            <div class="case-payout-success-title">Processing partial release</div>
            <div class="case-payout-success-copy">Please keep this window open while we finalize the release.</div>
          </div>
        `,
        `
          <div class="case-payout-actions">
            <button class="case-action-btn primary" type="button" disabled>Processing…</button>
          </div>
        `
      );
    };

    const setError = (message) => {
      isProcessing = false;
      if (modal) modal.classList.remove("is-processing");
      if (titleEl) titleEl.textContent = "Unable to finalize";
      const safeMessage = escapeHTML(message || "Unable to finalize partial payout.");
      swapContent(
        `
          <div class="case-payout-success">
            <div class="case-payout-success-title">Partial release not completed</div>
            <div class="case-payout-success-copy">${safeMessage}</div>
            <div class="case-payout-success-copy">Please try again in a moment.</div>
          </div>
        `,
        `
          <div class="case-payout-actions">
            <button class="case-action-btn primary" type="button" data-payout-close>Close</button>
          </div>
        `,
        () => {
          footerEl?.querySelector("[data-payout-close]")?.addEventListener("click", () =>
            close({ completed: false })
          );
        }
      );
    };

    const setSuccess = ({ payoutLabel, paralegalName, receiptUrl, relistCopy, pending } = {}) => {
      isProcessing = false;
      if (modal) modal.classList.remove("is-processing");
      const safeName = escapeHTML(paralegalName || "the paralegal");
      const safeRelist = escapeHTML(relistCopy || "The case has been automatically relisted.");
      const receiptLink = receiptUrl
        ? `<a class="case-action-btn secondary" href="${receiptUrl}" target="_blank" rel="noopener">View / Download Receipt</a>`
        : "";
      if (titleEl) {
        titleEl.textContent = pending ? "Processing partial release" : "Partial payment released";
      }
      const nextBody = `
        <div class="case-payout-success">
          <div class="case-payout-success-title">
            ${pending ? "Processing partial release" : `Partial payment released to ${safeName}`}
          </div>
          <div class="case-payout-success-copy">
            ${pending ? "We’re processing the release now. You can close this window or keep it open." : `Partial payment released to ${safeName}.`}
          </div>
          ${payoutLabel ? `<div class="case-payout-success-copy">Amount released: ${escapeHTML(payoutLabel)}.</div>` : ""}
          <div class="case-payout-success-copy">${safeRelist}</div>
        </div>
      `;
      const nextFooter = `
        <div class="case-payout-actions">
          ${receiptLink}
          <button class="case-action-btn primary" type="button" data-payout-close>Close</button>
        </div>
      `;
      swapContent(nextBody, nextFooter, () => {
        footerEl?.querySelector("[data-payout-close]")?.addEventListener("click", () => close({ completed: true }));
      });
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && !isProcessing) close({ cancelled: true, reason: "overlay" });
    });
    overlay
      .querySelector("[data-payout-cancel]")
      ?.addEventListener("click", () => close({ cancelled: true, reason: "cancel" }));
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
      resolveWithControls({
        amountCents,
        cancelled: false,
        setProcessing,
        setError,
        setSuccess,
        closeModal: () => close({ completed: true }),
      });
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !isProcessing) close({ cancelled: true, reason: "escape" });
      },
      { once: true }
    );
    if (input) {
      input.addEventListener("input", () => {
        const cleaned = sanitizeCurrencyInput(input.value);
        if (cleaned !== input.value) {
          input.value = cleaned;
        }
        updateState();
      });
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
    .case-reject-title{
      font-family:'Cormorant Garamond', serif;
      font-weight:400;
      font-size:12pt;
      line-height:1.45;
      text-align:center;
      color:#000;
    }
    .case-reject-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
    .case-reject-modal .case-action-btn{
      font-family:'Sarabun', sans-serif;
      font-weight:400;
      letter-spacing:.01em;
    }
  `;
  document.head.appendChild(style);
}

const CLOSE_WITHOUT_RELEASE_COPY =
  "This will initiate a 24-hour pause. Because the paralegal submitted deliverables, they may request payment during this period. After 24 hours, the case will automatically relist.";

function openRejectPayoutConfirmModal() {
  return new Promise((resolve) => {
    ensureRejectPayoutModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-reject-overlay";
    overlay.innerHTML = `
      <div class="case-reject-modal" role="dialog" aria-modal="true" aria-labelledby="caseRejectTitle">
        <div class="case-reject-title" id="caseRejectTitle">${CLOSE_WITHOUT_RELEASE_COPY}</div>
        <div class="case-reject-actions">
          <button class="case-action-btn secondary" type="button" data-reject-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-reject-confirm>Confirm</button>
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
      font-weight:400;
      font-size:1.35rem;
      letter-spacing:.01em;
      text-align:center;
      font-family:var(--font-serif);
    }
    .case-flag-actions{
      display:grid;
      gap:10px;
    }
    .case-flag-actions .case-action-btn{
      text-align:center;
      padding:12px 14px;
      border-radius:12px;
      font-weight:500;
      font-family:'Sarabun', sans-serif;
      letter-spacing:.01em;
      display:flex;
      align-items:center;
      justify-content:center;
      background:var(--app-surface-contrast, rgba(15,23,42,.04));
      border:1px solid var(--app-border-soft, rgba(15,23,42,.08));
      color:inherit;
      transition:none;
    }
    .case-flag-actions .case-action-btn.secondary{
      background:transparent;
    }
    .case-flag-actions .case-action-btn:hover{
      transform:none;
      box-shadow:none;
    }
    .case-flag-actions .case-action-btn:disabled{
      opacity:.55;
      cursor:not-allowed;
      transform:none;
      box-shadow:none;
    }
    .case-flag-actions .case-action-btn::after{
      content:"";
    }
    .case-flag-muted{
      font-size:.86rem;
      color:var(--app-muted, rgba(15,23,42,.6));
      line-height:1.45;
    }
    .case-flag-info{
      font-size:1rem;
      color:var(--app-muted, rgba(15,23,42,.65));
      line-height:1.5;
      font-family:'Cormorant Garamond', serif;
    }
    .case-flag-note{
      margin:-4px 0 4px;
      font-size:.85rem;
      color:var(--app-muted, rgba(15,23,42,.6));
      line-height:1.45;
      text-align:left;
      font-family:'Cormorant Garamond', serif;
    }
    .case-flag-overlay.is-visible{
      opacity:1;
    }
    .case-flag-overlay.is-visible .case-flag-modal{
      opacity:1;
      transform:translateY(0) scale(1);
    }
    body.theme-dark .case-flag-modal,
    html.theme-dark .case-flag-modal,
    body.theme-mountain-dark .case-flag-modal,
    html.theme-mountain-dark .case-flag-modal{
      background:#151b29;
      color:var(--app-text);
      border-color:rgba(255,255,255,.12);
    }
    body.theme-dark .case-flag-modal::before,
    html.theme-dark .case-flag-modal::before,
    body.theme-mountain-dark .case-flag-modal::before,
    html.theme-mountain-dark .case-flag-modal::before{
      background:linear-gradient(135deg, rgba(182,164,122,.12), transparent 55%);
    }
    body.theme-dark .case-flag-actions .case-action-btn,
    html.theme-dark .case-flag-actions .case-action-btn,
    body.theme-mountain-dark .case-flag-actions .case-action-btn,
    html.theme-mountain-dark .case-flag-actions .case-action-btn{
      background:rgba(255,255,255,.06);
      border-color:rgba(255,255,255,.12);
      color:var(--app-text);
    }
    body.theme-dark .case-flag-actions .case-action-btn.secondary,
    html.theme-dark .case-flag-actions .case-action-btn.secondary,
    body.theme-mountain-dark .case-flag-actions .case-action-btn.secondary,
    html.theme-mountain-dark .case-flag-actions .case-action-btn.secondary{
      background:transparent;
    }
    body.theme-dark .case-flag-info,
    html.theme-dark .case-flag-info,
    body.theme-mountain-dark .case-flag-info,
    html.theme-mountain-dark .case-flag-info,
    body.theme-dark .case-flag-muted,
    html.theme-dark .case-flag-muted,
    body.theme-mountain-dark .case-flag-muted,
    html.theme-mountain-dark .case-flag-muted,
    body.theme-dark .case-flag-note,
    html.theme-dark .case-flag-note,
    body.theme-mountain-dark .case-flag-note,
    html.theme-mountain-dark .case-flag-note{
      color:#9aa7c4;
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
    const blockState = getBlockMenuState(caseData);
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
    if (blockState.canBlock) {
      options.push(
        `<button type="button" class="case-action-btn secondary" data-flag-action="block">Block future interaction</button>`
      );
    } else if (blockState.blocked) {
      options.push(
        `<button type="button" class="case-action-btn secondary" disabled>Blocked - manage in Settings</button>`
      );
    }
    const blockNote = blockState.blocked
      ? `<p class="case-flag-note">Manage unblocking from Settings in the Blocked Users section.</p>`
      : "";
    const emptyCopy = !options.length
      ? `<p class="case-flag-muted">No actions are available right now.</p>`
      : "";
    overlay.innerHTML = `
      <div class="case-flag-modal" role="dialog" aria-modal="true" aria-labelledby="caseFlagTitle">
        <div class="case-flag-title" id="caseFlagTitle">Case Actions</div>
        ${blockNote}
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
  const adminReviewHold = !!caseData?.disputeDeadlineAt && !payoutFinalized;
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
  } else if (adminReviewHold) {
    bannerText =
      "Closing without release starts a 24-hour window for the paralegal to dispute. If no dispute is filed, the case will relist automatically.";
    disablePartial = true;
    disableReject = true;
  } else if (completedCount === 0) {
    bannerText = "Paralegal withdrew before any tasks were completed. No payout will be issued.";
    statusText = "Case relisted and ready for hiring.";
  } else if (completedCount > 0 && completedCount < totalTasks) {
    bannerText =
      "Paralegal withdrew. Please choose a partial payout or close without release. Case will automatically relist once decision is finalized.";
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
    if (document.querySelector(".case-flag-overlay")) {
      resolve("cancel");
      return;
    }
    ensureFlagMenuStyles();
    const state = actionState?.eligible ? actionState : getAttorneyWithdrawalActionState(caseData);
    const canDispute = canOpenDisputeFromCase(caseData);
    const blockState = getBlockMenuState(caseData);
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
        }>Close without release</button>`
      );
    }
    if (state.showRelist) {
      options.push(
        `<button type="button" class="case-action-btn secondary" data-flag-action="relist" ${
          state.disableRelist ? "disabled" : ""
        }>Relist Case</button>`
      );
    }
    if (canDispute) {
      options.push(
        `<button type="button" class="case-action-btn secondary" data-flag-action="dispute">Open Dispute</button>`
      );
    }
    if (blockState.canBlock) {
      options.push(
        `<button type="button" class="case-action-btn secondary" data-flag-action="block">Block future interaction</button>`
      );
    } else if (blockState.blocked) {
      options.push(
        `<button type="button" class="case-action-btn secondary" disabled>Blocked - manage in Settings</button>`
      );
    }
    const infoParts = [state.bannerText, state.statusText].filter(Boolean);
    if (blockState.blocked) {
      infoParts.push("Manage unblocking from Settings in the Blocked Users section.");
    }
    const infoCopy = infoParts.length ? `<p class="case-flag-info">${infoParts.join(" ")}</p>` : "";
    const emptyCopy = !options.length
      ? `<p class="case-flag-muted">No actions are available right now.</p>`
      : "";
    const title = state.eligible ? "Paralegal Withdrawal" : "Case Actions";
    overlay.innerHTML = `
      <div class="case-flag-modal" role="dialog" aria-modal="true" aria-labelledby="caseFlagTitle">
        <div class="case-flag-title" id="caseFlagTitle">${title}</div>
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

async function handleWithdrawalActionSelection(action, caseData, actionState) {
  if (action === "partial") {
    await handlePartialPayout({ returnToMenu: true, menuCaseData: caseData, menuActionState: actionState });
    return true;
  }
  if (action === "reject") {
    await handleRejectPayout();
    return true;
  }
  if (action === "relist") {
    await handleRelistCase();
    return true;
  }
  if (action === "dispute") {
    await handleDisputeCase();
    return true;
  }
  return false;
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
  const actionState = getAttorneyWithdrawalActionState(caseData);
  if (!actionState?.eligible) return;
  const stamp = caseData?.pausedAt || "withdrawal";
  const noticeKey = `lpc-attorney-withdrawal:${caseId}:${stamp}`;
  if (state.withdrawalNoticeKey === noticeKey) return;
  state.withdrawalNoticeKey = noticeKey;

  setTimeout(async () => {
    if (state.activeCaseId && String(state.activeCaseId) !== String(caseId)) return;
    const action = await openAttorneyFlagMenu(caseData, actionState);
    await handleWithdrawalActionSelection(action, caseData, actionState);
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
  if (role === "paralegal") return getParalegalCompletionRedirect(caseData);
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

function getParalegalCompletionRedirect(caseData) {
  const caseId = caseData?.id || caseData?.caseId || caseData?._id || "";
  const highlightParam = caseId ? `?highlightCase=${encodeURIComponent(caseId)}` : "";
  return `dashboard-paralegal.html${highlightParam}#cases-completed`;
}

function setParalegalCompletionToast(caseData) {
  try {
    const title = "Case Completed";
    const caseTitle = String(caseData?.title || caseData?.jobTitle || "").trim();
    const message = caseTitle
      ? `“${caseTitle}” has been marked complete and moved to Completed Cases.`
      : "Your case has been marked complete and moved to Completed Cases.";
    sessionStorage.setItem(
      "lpc-case-completed-toast",
      JSON.stringify({ title, message })
    );
  } catch (err) {}
}

function redirectParalegalCompletionFallback(caseId, caseTitle) {
  if (getCurrentUserRole() !== "paralegal") return false;
  const safeId = String(caseId || "").trim();
  if (!safeId) return false;
  const payload = { id: safeId, caseId: safeId, _id: safeId, title: caseTitle || "" };
  setParalegalCompletionToast(payload);
  window.location.href = getParalegalCompletionRedirect(payload);
  return true;
}

function showParalegalCompletionOverlay(caseData) {
  if (getCurrentUserRole() !== "paralegal") return false;
  if (!isCompletedCase(caseData)) return false;
  const caseId = caseData?.id || caseData?.caseId || caseData?._id || "";
  if (state.completionOverlayActive && state.completionOverlayCaseId === caseId) return true;

  clearCompletionOverlay();
  setParalegalCompletionToast(caseData);
  state.completionOverlayActive = true;
  state.completionOverlayCaseId = caseId;
  stopCaseStream();
  stopMessagePolling();
  setWorkspaceEnabled(false, "");
  removeWorkspaceActions();
  window.location.href = getParalegalCompletionRedirect(caseData);
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
    const role = document.createElement("span");
    role.className = "participant-role";
    role.textContent = entry.label;
    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent = entry.value;
    li.append(role, name);
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

function getLocalDayKey(value) {
  const time = typeof value === "number" ? value : getItemTimestamp(value);
  if (!time) return "";
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function computeThreadResetAt(caseData) {
  if (!caseData?.withdrawnParalegalId) return null;
  const hiredAt = getItemTimestamp(caseData?.hiredAt);
  return hiredAt || null;
}

function updateThreadReset(caseData) {
  const next = computeThreadResetAt(caseData);
  if (state.threadResetAt === next) return false;
  state.threadResetAt = next;
  return true;
}

function filterMessagesForViewer(messages = []) {
  const resetAt = state.threadResetAt;
  if (!resetAt || getCurrentUserRole() !== "paralegal") return messages;
  return messages.filter((msg) => {
    const time = getItemTimestamp(msg?.createdAt || msg?.created);
    if (!time) return true;
    return time >= resetAt;
  });
}

function filterDocumentsForViewer(documents = []) {
  const resetAt = state.threadResetAt;
  if (!resetAt || getCurrentUserRole() !== "paralegal") return documents;
  return documents.filter((doc) => {
    const time = getItemTimestamp(doc?.createdAt || doc?.uploadedAt || doc?.created);
    if (!time) return true;
    return time >= resetAt;
  });
}

function refreshThreadFromCache(caseId) {
  const messages = state.messageCacheByCase.get(caseId) || [];
  const serverDocuments = state.caseDocumentsById.get(caseId) || [];
  const optimisticDocuments = getOptimisticDocumentsForCase(caseId);
  const mergedDocuments = mergeDocuments(serverDocuments, optimisticDocuments);
  renderSharedDocuments(mergedDocuments, caseId);
  renderThreadItems(messages, mergedDocuments, caseId);
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

function flashMessageStatus(text, duration = 1800) {
  if (!messageStatus) return;
  showMsg(messageStatus, text);
  messageStatus.classList.remove("status-flash");
  void messageStatus.offsetWidth;
  messageStatus.classList.add("status-flash");
  window.setTimeout(() => {
    messageStatus.classList.remove("status-flash");
    if (messageStatus.textContent === text) {
      showMsg(messageStatus, "");
    }
  }, duration);
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

function getTaskKey(task) {
  return String(getTaskTitle(task) || "").trim().toLowerCase();
}

function getLockedTaskKeys(caseData, forceUpdate = false) {
  if (!caseData) return null;
  const caseId = String(caseData._id || caseData.id || state.activeCaseId || "");
  if (!caseId) return null;
  const existing = state.lockedTaskKeys.get(caseId);
  const shouldUpdate = forceUpdate || shouldLockCompletedTasks(caseData);
  if (!shouldUpdate) {
    return existing && existing.size ? existing : null;
  }
  const locked = existing || new Set();
  const tasks = getCaseTasks(caseData);
  tasks.forEach((task) => {
    if (!isTaskCompleted(task)) return;
    const key = getTaskKey(task);
    if (key) locked.add(key);
  });
  if (locked.size) {
    state.lockedTaskKeys.set(caseId, locked);
  }
  return locked.size ? locked : null;
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

function getTaskCheckboxes() {
  const listCheckboxes = caseTaskList
    ? Array.from(caseTaskList.querySelectorAll('input[type="checkbox"]'))
    : [];
  if (listCheckboxes.length) return listCheckboxes;
  if (caseOverviewTasks) {
    return Array.from(caseOverviewTasks.querySelectorAll('input[type="checkbox"]'));
  }
  return [];
}

function getRenderedTaskCompletionState() {
  const checkboxes = getTaskCheckboxes();
  if (!checkboxes.length) return null;
  const checkedCount = checkboxes.reduce((count, checkbox) => count + (checkbox.checked ? 1 : 0), 0);
  return { total: checkboxes.length, checked: checkedCount };
}

function areRenderedTasksComplete() {
  const state = getRenderedTaskCompletionState();
  if (!state) return null;
  return state.total > 0 && state.checked === state.total;
}

function areCompletionTasksComplete(caseData) {
  const renderedComplete = areRenderedTasksComplete();
  if (renderedComplete !== null) return renderedComplete;
  return areAllTasksComplete(caseData);
}

function setCompleteButtonLock(locked) {
  if (!caseCompleteButton) return;
  let isLocked = !!locked;
  if (!isLocked) {
    const renderedState = getRenderedTaskCompletionState();
    if (renderedState && renderedState.checked !== renderedState.total) {
      isLocked = true;
    }
  }
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
  if (caseCompleteStatus) {
    caseCompleteStatus.textContent = "Please do not refresh the page";
  }
  const render = () => {
    const label = `Releasing funds${frames[frame % frames.length]}`;
    if (caseCompleteButton && !caseCompleteButton.hidden) {
      caseCompleteButton.textContent = label;
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

function shouldLockCompletedTasks(caseData) {
  if (!caseData) return false;
  if (!hasAssignedParalegal(caseData)) return false;
  const payoutType = String(caseData?.payoutFinalizedType || "");
  const pausedReason = String(caseData?.pausedReason || "");
  const hasWithdrawalHistory =
    !!caseData.withdrawnParalegalId ||
    pausedReason === "paralegal_withdrew" ||
    ["zero_auto", "partial_attorney", "admin", "expired_zero"].includes(payoutType);
  if (!hasWithdrawalHistory) return false;
  const statusKey = normalizeCaseStatus(caseData?.status);
  if (["completed", "closed", "disputed"].includes(statusKey)) return false;
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

async function updateTaskCompletion(taskIndex, checked, checkbox) {
  if (taskUpdateInFlight) return false;
  const caseId = state.activeCaseId;
  if (!caseId || !state.activeCase) return false;
  const tasks = Array.isArray(state.activeCase.tasks) ? state.activeCase.tasks : [];
  if (!tasks.length || !tasks[taskIndex]) return false;
  const lockCompletedTasks = shouldLockCompletedTasks(state.activeCase);
  const lockedTasks = getLockedTaskKeys(state.activeCase, lockCompletedTasks);
  const taskKey = getTaskKey(tasks[taskIndex]);
  if ((lockCompletedTasks || lockedTasks) && lockedTasks?.has(taskKey) && !checked) {
    showMsg(messageStatus, "Completed tasks are locked after a withdrawal.");
    return false;
  }
  if (lockedTasks && lockedTasks.size) {
    tasks.forEach((task) => {
      if (!task || typeof task !== "object") return;
      if (lockedTasks.has(getTaskKey(task))) {
        task.completed = true;
      }
    });
  }
  const previousTasks = tasks.map((task) => (typeof task === "string" ? task : { ...task }));
  const payload = buildTaskPayload(tasks, taskIndex, checked);
  if (!payload.length) return false;
  taskUpdateInFlight = true;
  if (caseTaskList) caseTaskList.setAttribute("aria-busy", "true");
  if (checkbox) checkbox.disabled = true;
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
      refreshTaskCheckboxStates(state.activeCase);
      updateCompleteAction(state.activeCase, resolveCaseState(state.activeCase));
      state.taskSnapshots.set(caseId, getTaskSnapshot(state.activeCase));
    }
  }
  return true;
}

function refreshTaskCheckboxStates(caseData) {
  if (!caseTaskList || !caseData) return;
  const tasks = getCaseTasks(caseData);
  if (!tasks.length) return;
  const labels = Array.from(caseTaskList.querySelectorAll("li label"));
  if (labels.length !== tasks.length) {
    renderCaseOverview(caseData);
    return;
  }
  const hasParalegal = hasAssignedParalegal(caseData);
  const role = getCurrentUserRole();
  const showCompletion = role === "attorney" || hasParalegal;
  const allowTaskEdit = canEditTasks(caseData) && hasParalegal;
  const lockCompletedTasks = shouldLockCompletedTasks(caseData);
  const lockedTasks = getLockedTaskKeys(caseData, lockCompletedTasks);

  labels.forEach((label, index) => {
    const checkbox = label.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    const task = tasks[index];
    const taskKey = getTaskKey(task);
    const isLocked = !!(lockedTasks && taskKey && lockedTasks.has(taskKey));
    const completed = isTaskCompleted(task) || isLocked;
    if (isLocked && task && typeof task === "object") {
      task.completed = true;
    }
    checkbox.disabled =
      !allowTaskEdit || taskUpdateInFlight || (lockCompletedTasks && completed) || isLocked;
    checkbox.checked = showCompletion && completed;
    const title = getTaskTitle(task) || "Task";
    const textNode = Array.from(label.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (textNode) {
      textNode.textContent = ` ${title}`;
    }
  });
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
      const hasParalegal = hasAssignedParalegal(data);
      const role = getCurrentUserRole();
      const showCompletion = role === "attorney" || hasParalegal;
      const allowTaskEdit = canEditTasks(data) && hasParalegal;
      const lockCompletedTasks = shouldLockCompletedTasks(data);
      const lockedTasks = getLockedTaskKeys(data, lockCompletedTasks);
      tasks.forEach((task, taskIndex) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        const title = getTaskTitle(task);
        checkbox.type = "checkbox";
        const taskKey = getTaskKey(task);
        const isLocked = !!(lockedTasks && taskKey && lockedTasks.has(taskKey));
        const completed = isTaskCompleted(task) || isLocked;
        if (isLocked && task && typeof task === "object") {
          task.completed = true;
        }
        checkbox.disabled =
          !allowTaskEdit || taskUpdateInFlight || (lockCompletedTasks && completed) || isLocked;
        checkbox.checked = showCompletion && completed;
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
            const updated = await updateTaskCompletion(taskIndex, checkbox.checked, checkbox);
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
  const isPaused = statusKey === "paused";
  const isFinal = statusKey === "completed" || caseData?.paymentReleased === true;
  const eligible =
    isAttorney &&
    caseState === CASE_STATES.FUNDED_IN_PROGRESS &&
    !caseData?.readOnly &&
    !caseData?.paymentReleased &&
    !isFinal &&
    hasParalegal;
  if (isAttorney && isPaused) {
    caseCompleteSection.hidden = false;
    setCompleteButtonLock(true);
    if (caseCompleteStatus) {
      caseCompleteStatus.textContent = "Case is paused.";
      caseCompleteStatus.classList.add("is-alert");
      caseCompleteStatus.dataset.lockReason = "paused";
    }
    return;
  }
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

function getCaseBlockConfirmMessage() {
  return "Block future interaction with this user? This will prevent future applications, invitations, hiring, and direct messaging between the two of you on Let's ParaConnect. This user will not be notified. Existing case and payment history will remain available.";
}

function getBlockMenuState(caseData) {
  const blockStatus = caseData?.blockStatus || null;
  return {
    blocked: !!blockStatus?.blocked,
    canBlock: !!blockStatus?.canBlock,
  };
}

function updateDisputeAction(caseData) {
  if (!caseDisputeButton) return;
  const statusKey = normalizeCaseStatus(caseData?.status);
  const isDisputed = statusKey === "disputed" || caseData?.terminationStatus === "disputed";
  const isClosed = ["completed", "closed"].includes(statusKey);
  const role = getCurrentUserRole();
  const blockState = getBlockMenuState(caseData);
  const hasFutureInteractionAction = blockState.blocked || blockState.canBlock;
  const isWithdrawal = isWithdrawalCase(caseData);
  const isWithdrawn = isWithdrawnViewer(caseData);
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

  const canDispute = canOpenDisputeFromCase(caseData);
  const canWithdraw = canRequestWithdrawal(caseData);
  const hasAttorneyWithdrawalAction =
    !!attorneyActionState?.showPartial ||
    !!attorneyActionState?.showReject ||
    !!attorneyActionState?.showRelist;
  const hasMenuActions =
    role === "paralegal"
      ? canWithdraw || canDispute || hasFutureInteractionAction
      : role === "attorney"
        ? hasAttorneyWithdrawalAction || canDispute || hasFutureInteractionAction
        : canDispute;

  hidden = !hasMenuActions;
  disabled = !hasMenuActions;

  const flagLabel =
    role === "paralegal" || (role === "attorney" && (isWithdrawal || hasFutureInteractionAction || isClosed))
      ? "Case actions"
      : "Flag dispute";
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
      caseDisputeStatus.innerHTML = `Paralegal withdrew. Please choose a ${partialLabel} or ${rejectLabel}. Case will relist after the payout is finalized.${suffix}`;
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
  const caseState = resolveCaseState(caseData);
  const statusKey = normalizeCaseStatus(caseData?.status);
  const eligibleBase =
    caseState === CASE_STATES.FUNDED_IN_PROGRESS &&
    !caseData?.readOnly &&
    !caseData?.paymentReleased &&
    statusKey !== "completed" &&
    statusKey !== "closed" &&
    statusKey !== "disputed" &&
    hasAssignedParalegal(caseData) &&
    isEscrowFunded(caseData);
  if (!eligibleBase) {
    setCompletionStatusMessage(resolveCompletionIneligibleReason(caseData, caseState));
    return;
  }
  if (!areCompletionTasksComplete(caseData)) {
    showCompleteLockMessage();
    return;
  }
  clearCompleteLockMessage();
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
  const originalText = caseWithdrawButton?.textContent || "Withdraw from Case";
  if (caseWithdrawButton) caseWithdrawButton.disabled = true;
  if (caseWithdrawButton) caseWithdrawButton.textContent = "Withdrawing...";
  showMsg(caseWithdrawStatus, "Submitting withdrawal request...");
  try {
    await fetchCSRF().catch(() => "");
    const payload = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/withdraw`, { method: "POST" });
    try {
      sessionStorage.removeItem("lpc-case-completed-toast");
      sessionStorage.setItem(
        "lpc-withdrawal-toast",
        JSON.stringify({
          message:
            payload?.message ||
            (completedCount === 0
              ? "You withdrew from this case. No payout will be issued because no tasks were completed, and the case has been relisted."
              : "You withdrew from this case. The attorney will now decide whether to issue a partial payout based on completed work."),
          type: "success",
        })
      );
    } catch {}
    showMsg(
      caseWithdrawStatus,
      payload?.message ||
        (completedCount === 0
          ? "You withdrew from this case. No payout will be issued because no tasks were completed, and the case has been relisted."
          : "You withdrew from this case. The attorney will now decide whether to issue a partial payout based on completed work.")
    );
    window.location.href = "dashboard-paralegal.html#cases";
    return;
  } catch (err) {
    showMsg(caseWithdrawStatus, err.message || "Unable to withdraw from case.");
  } finally {
    state.withdrawing = false;
    if (caseWithdrawButton) {
      caseWithdrawButton.disabled = false;
      caseWithdrawButton.textContent = originalText;
    }
  }
}

async function handleBlockFutureInteraction() {
  if (state.blockingFutureInteraction) return;
  const caseId = state.activeCaseId;
  const caseData = state.activeCase || {};
  const blockStatus = caseData?.blockStatus || null;
  if (!caseId) return;
  if (!blockStatus?.canBlock) return;

  const confirmed = window.confirm(getCaseBlockConfirmMessage());
  if (!confirmed) return;

  state.blockingFutureInteraction = true;
  const statusNode = resolveCaseActionStatusNode();
  if (statusNode) showMsg(statusNode, "Blocking future interaction...");

  try {
    await fetchCSRF().catch(() => "");
    await fetchJSON("/api/blocks", {
      method: "POST",
      body: { caseId },
    });
    if (statusNode) showMsg(statusNode, "Future interaction blocked. This user was not notified.");
    await loadCase(caseId, { suppressStatus: true });
  } catch (err) {
    if (statusNode) showMsg(statusNode, err.message || "Unable to block future interaction.");
  } finally {
    state.blockingFutureInteraction = false;
  }
}

async function reopenWithdrawalMenu(caseData, actionState) {
  if (!caseData) return;
  const action = await openAttorneyFlagMenu(caseData, actionState);
  if (action === "partial") {
    await handlePartialPayout({ returnToMenu: true, menuCaseData: caseData, menuActionState: actionState });
    return;
  }
  if (action === "reject") {
    await handleRejectPayout();
    return;
  }
  if (action === "relist") {
    await handleRelistCase();
    return;
  }
  if (action === "dispute") {
    await handleDisputeCase();
  }
}

async function handlePartialPayout({ returnToMenu = false, menuCaseData = null, menuActionState = null } = {}) {
  if (state.partialPayoutSubmitting) return;
  const caseId = state.activeCaseId;
  if (!caseId) return;
  const caseData = menuCaseData || state.activeCase || {};
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
  const baseAmount = Number(caseData?.lockedTotalAmount ?? caseData?.totalAmount ?? remainingCents);
  const capCentsRaw =
    Number.isFinite(baseAmount) && baseAmount > 0 ? Math.round(baseAmount * 0.7) : 0;
  const maxCents = Math.max(0, Math.min(remainingCents, capCentsRaw || 0));
  const result = await openPartialPayoutModal({
    maxCents,
    currency,
    paralegalName: getWithdrawnParalegalName(caseData),
  });
  if (!result || result.cancelled) {
    if (returnToMenu && result?.reason === "cancel") {
      const actionState = menuActionState || getAttorneyWithdrawalActionState(caseData);
      await reopenWithdrawalMenu(caseData, actionState);
    }
    return;
  }
  const amountCents = result.amountCents;
  if (!Number.isFinite(amountCents)) return;
  if (typeof result.setProcessing === "function") {
    result.setProcessing();
  }
  state.partialPayoutSubmitting = true;
  if (casePartialPayoutButton) casePartialPayoutButton.disabled = true;
  if (statusNode) showMsg(statusNode, "Finalizing partial payout...");
  try {
    await fetchCSRF().catch(() => "");
    const payload = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/partial-payout`, {
      method: "POST",
      body: { amountCents },
    });
    if (statusNode) showMsg(statusNode, "Partial payout finalized. Case relisted.");
    await loadCase(caseId);
    const payoutLabel = formatCurrency(amountCents / 100, currency);
    if (typeof result.setSuccess === "function") {
      const receiptUrl = `/api/payments/receipt/attorney/${encodeURIComponent(caseId)}`;
      const pending = !payload?.transferId && Number(payload?.payout || 0) > 0;
      result.setSuccess({
        payoutLabel,
        paralegalName: getWithdrawnParalegalName(caseData),
        receiptUrl,
        relistCopy: "The case has been automatically relisted.",
        pending,
      });
    } else {
      showCaseActionAcknowledgement({
        title: "Partial Payout Submitted",
        message: `A partial payout of ${payoutLabel} was submitted. The case will be relisted automatically.`,
      });
    }
  } catch (err) {
    if (statusNode) showMsg(statusNode, err.message || "Unable to finalize partial payout.");
    if (typeof result.setError === "function") {
      result.setError(err.message || "Unable to finalize partial payout.");
    }
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
        "Closing without release starts a 24-hour window for the paralegal to dispute. If no dispute is filed, the case will relist automatically."
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
  const originalText = caseRelistButton?.textContent || "Relist";
  if (caseRelistButton) caseRelistButton.disabled = true;
  if (caseRelistButton) caseRelistButton.textContent = "Relisting...";
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
    if (caseRelistButton) {
      caseRelistButton.disabled = false;
      caseRelistButton.textContent = originalText;
    }
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
      return;
    }
    if (action === "block") {
      await handleBlockFutureInteraction();
    }
    return;
  }
  if (role === "attorney") {
    const actionState = getAttorneyWithdrawalActionState(caseData);
    const blockState = getBlockMenuState(caseData);
    if (actionState.eligible || blockState.blocked || blockState.canBlock) {
      const action = await openAttorneyFlagMenu(caseData, actionState);
      if (action === "partial") {
        await handlePartialPayout({ returnToMenu: true, menuCaseData: caseData, menuActionState: actionState });
        return;
      }
      if (action === "reject") {
        await handleRejectPayout();
        return;
      }
      if (action === "relist") {
        await handleRelistCase();
        return;
      }
      if (action === "dispute") {
        await handleDisputeCase();
        return;
      }
      if (action === "block") {
        await handleBlockFutureInteraction();
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
  const showAmount = isDisputeWindowActive(caseData) && isWithdrawnViewer(caseData);
  const { confirmed, message, amount } = await openDisputeConfirmModal({ showAmount });
  if (!confirmed) return;
  state.disputing = true;
  const originalText = caseDisputeButton?.textContent || "Flag issue";
  if (caseDisputeButton) caseDisputeButton.disabled = true;
  if (caseDisputeButton) caseDisputeButton.textContent = "Opening dispute...";
  showMsg(caseDisputeStatus, "Opening dispute...");
  try {
    await fetchCSRF().catch(() => "");
    const note = (message || "").trim() || "Dispute flagged from the case workspace.";
    await fetchJSON(`/api/disputes/${encodeURIComponent(caseId)}`, {
      method: "POST",
      body: { message: note, amount },
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
  } finally {
    state.disputing = false;
    if (caseDisputeButton) {
      caseDisputeButton.disabled = false;
      caseDisputeButton.textContent = originalText;
    }
  }
}

function renderThreadItems(messages, documents, caseId) {
  if (!messageList) return;
  const shouldScroll = state.forceScrollToBottom || shouldAutoScroll();
  state.forceScrollToBottom = false;
  emptyNode(messageList);
  try {
    const visibleMessages = filterMessagesForViewer(messages);
    const visibleDocuments = filterDocumentsForViewer(documents);

    const items = [];
    visibleMessages.forEach((msg) => {
      items.push({ type: "message", createdAt: msg?.createdAt || msg?.created, data: msg });
    });
    visibleDocuments.forEach((doc) => {
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

    const resetAt = state.threadResetAt;
    const shouldInsertBreak =
      getCurrentUserRole() === "attorney" &&
      !!resetAt &&
      items.some((item) => getItemTimestamp(item.createdAt) < resetAt) &&
      items.some((item) => getItemTimestamp(item.createdAt) >= resetAt);

    const fragment = document.createDocumentFragment();
    if (!items.length) {
      const li = document.createElement("li");
      const empty = document.createElement("div");
      empty.className = "thread-card";
      empty.textContent = "No messages yet. Use the thread below to coordinate work.";
      li.appendChild(empty);
      fragment.appendChild(li);
	    } else {
	      let previousMeta = null;
	      let previousDayKey = "";
	      let dividerInserted = false;
	      for (const item of items) {
	        const itemTime = getItemTimestamp(item.createdAt);
	        const itemDayKey = getLocalDayKey(itemTime);
	        if (itemDayKey && previousDayKey && itemDayKey !== previousDayKey) {
	          const dayDivider = document.createElement("li");
	          dayDivider.className = "thread-date-divider";
	          const dayLabel = document.createElement("span");
	          dayLabel.className = "thread-date-label";
	          dayLabel.textContent = formatDate(new Date(itemTime)) || "";
	          if (dayLabel.textContent) {
	            dayDivider.appendChild(dayLabel);
	            fragment.appendChild(dayDivider);
	          }
	        }
	        if (shouldInsertBreak && !dividerInserted && itemTime && itemTime >= resetAt) {
	          const divider = document.createElement("li");
	          divider.className = "thread-break";
          const line = document.createElement("div");
          line.className = "thread-break-line";
          divider.appendChild(line);
          fragment.appendChild(divider);
          dividerInserted = true;
        }
        const li = document.createElement("li");
        const senderKey =
          item.type === "message" ? getMessageSenderKey(item.data) : getDocumentSenderKey(item.data);
        const timeValue = itemTime;
        if (previousMeta && senderKey && senderKey === previousMeta.senderKey) {
          const closeInTime =
            !timeValue ||
            !previousMeta.timeValue ||
            Math.abs(timeValue - previousMeta.timeValue) <= 5 * 60 * 1000;
          if (closeInTime) li.classList.add("is-grouped");
        }
        try {
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
        } catch (err) {
          console.warn("Unable to render thread item", err);
          continue;
	        }
	        fragment.appendChild(li);
	        previousMeta = { senderKey, timeValue };
	        if (itemDayKey) previousDayKey = itemDayKey;
	      }
	    }
    messageList.appendChild(fragment);
  } catch (err) {
    console.warn("Thread render failed", err);
    const li = document.createElement("li");
    const empty = document.createElement("div");
    empty.className = "thread-card";
    empty.textContent = "Unable to render the conversation. Please refresh.";
    li.appendChild(empty);
    messageList.appendChild(li);
  }
  if (shouldScroll) {
    requestAnimationFrame(() => scrollMessagesToBottom());
  }
}

function renderSharedDocuments(documents, caseId, { emptyMessage } = {}) {
  if (!caseSharedDocuments || !caseSharedDocumentsEmpty) return;
  emptyNode(caseSharedDocuments);
  const list = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const visibleList = filterDocumentsForViewer(list);
  const currentRole = getCurrentUserRole();
  caseSharedDocuments.classList.toggle("case-documents-attorney", currentRole === "attorney");
  if (!visibleList.length) {
    caseSharedDocuments.hidden = true;
    caseSharedDocuments.style.removeProperty("--case-documents-visible-height");
    caseSharedDocumentsEmpty.textContent = emptyMessage || "No documents shared yet.";
    caseSharedDocumentsEmpty.hidden = false;
    return;
  }

  caseSharedDocuments.hidden = false;
  caseSharedDocumentsEmpty.hidden = true;

  const sorted = [...visibleList].sort((a, b) => {
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
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.setAttribute("aria-label", `Open ${fileName}`);

    li.append(meta);
    const openDocument = () => {
      if (canPreview) {
        openDocumentPreview({
          fileName,
          viewUrl,
          mimeType,
          caseId,
          storageKey,
          uploadedAt: createdAt,
          uploaderName: formatUploaderName(documentData, state.activeCase),
        });
        return;
      }
      if (downloadUrl) {
        window.open(downloadUrl, "_blank", "noopener");
      }
    };
    li.addEventListener("click", (event) => {
      if (event.target?.closest(".case-documents-actions")) return;
      if (event.target?.closest("input")) return;
      if (event.target?.closest("label")) return;
      openDocument();
    });
    li.addEventListener("keydown", (event) => {
      if (event.target?.closest(".case-documents-actions")) return;
      if (event.target?.closest("input")) return;
      if (event.target?.closest("label")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDocument();
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
  syncSharedDocumentsHeightLimit();
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

async function loadCase(caseId, options = {}) {
  if (!caseId) return;
  stopMessagePolling();
  stopCaseStream();
  setActiveCase(caseId);
  state.forceScrollToBottom = true;
  await restorePendingAttachments(caseId);
  const suppressStatus = options?.suppressStatus === true;
  if (!suppressStatus) {
    showMsg(messageStatus, "");
  }
  try {
    const caseData = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}`, {
      noRedirect: true,
    });
    if (getCurrentUserRole() === "paralegal" && isWithdrawnViewer(caseData)) {
      window.location.href = "dashboard-paralegal.html#cases";
      return;
    }
    state.activeCase = caseData;
    updateThreadReset(caseData);
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
    const allowReadOnly = !workspace.ready && isWithdrawalPause(caseData);
    setWorkspaceEnabled(workspace.ready, allowReadOnly ? null : workspace.reason);
    if (!workspace.ready && !allowReadOnly) {
      renderWorkspaceLocked(workspace.reason);
      showMsg(messageStatus, workspace.reason || "");
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
        noRedirect: true,
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
        noRedirect: true,
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
      if (redirectParalegalCompletionFallback(caseId, state.activeCase?.title || "")) {
        return;
      }
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
  const visibleMessages = filterMessagesForViewer(messages);
  const upTo = getLatestMessageTimestamp(visibleMessages);
  if (!caseId || !upTo) return;
  try {
    await fetchCSRF().catch(() => "");
    await fetchWithFallback([`/api/messages/${encodeURIComponent(caseId)}/read`], {
      method: "POST",
      body: { upTo },
      noRedirect: true,
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
  const previousCase = state.activeCase
    ? {
        status: state.activeCase.status,
        pausedReason: state.activeCase.pausedReason,
        pausedAt: state.activeCase.pausedAt,
        withdrawnParalegalId: getWithdrawnParalegalId(state.activeCase),
      }
    : null;
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
          noRedirect: true,
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
          noRedirect: true,
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
          noRedirect: true,
        });
      } catch (err) {
        console.warn("Unable to refresh case data", err);
        if ((err?.status === 403 || err?.status === 404) && getCurrentUserRole() === "paralegal") {
          if (redirectParalegalCompletionFallback(caseId, state.activeCase?.title || "")) {
            return true;
          }
        }
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
      const nextCase = { ...state.activeCase, ...caseData };
      state.activeCase = nextCase;
      const resetChanged = updateThreadReset(nextCase);
      renderCaseOverview(nextCase);
      if (hasTaskSnapshotChanged(previousTask, taskSnapshot)) {
        state.taskSnapshots.set(caseId, taskSnapshot);
      }
      if (resetChanged) {
        refreshThreadFromCache(caseId);
      }
      maybeShowAttorneyWithdrawalNotice(previousCase, nextCase);
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
  showMsg(messageStatus, attachments.length ? "Preparing uploads..." : "");

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
      await fetchJSON(`/api/messages/${encodeURIComponent(caseId)}`, {
        method: "POST",
        body: { text, content: text, caseId },
      });
      messageInput.value = "";
      autoResizeMessageInput();
    }

    await loadCase(caseId, { suppressStatus: true });
    flashMessageStatus("Sent");
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
  window.addEventListener("resize", syncSharedDocumentsHeightLimit);
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
