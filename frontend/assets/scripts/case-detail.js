import { secureFetch, fetchCSRF, showMsg, loadUserHeaderInfo, applyRoleVisibility } from "./auth.js";

const caseList = document.getElementById("caseList");
const caseListStatus = document.getElementById("caseListStatus");
const caseTitle = document.getElementById("caseTitle");
const caseStatusLine = document.getElementById("caseStatusLine");
const caseParticipants = document.getElementById("caseParticipants");
const messageList = document.getElementById("caseMessageList");
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
const caseZoomLink = document.getElementById("caseZoomLink");
const caseCompleteSection = document.getElementById("caseCompleteSection");
const caseCompleteButton = document.getElementById("caseCompleteButton");
const caseCompleteStatus = document.getElementById("caseCompleteStatus");
const caseThread = document.getElementById("case-messages");
const caseSearchInput = document.getElementById("case-search");
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
const CASE_STATES = {
  DRAFT: "draft",
  OPEN: "open",
  APPLIED: "applied",
  FUNDED_IN_PROGRESS: "funded_in_progress",
};
const FUNDED_WORKSPACE_STATUSES = new Set([
  CASE_STATES.FUNDED_IN_PROGRESS,
  "in progress",
  "in_progress",
  "active",
  "awaiting_documents",
  "reviewing",
]);
let attachmentDbPromise = null;
let dragDepth = 0;

const state = {
  cases: [],
  activeCaseId: "",
  unreadByCase: new Map(),
  filter: "active",
  search: "",
  pendingAttachments: [],
  sending: false,
  completing: false,
  workspaceEnabled: false,
  activeCase: null,
};

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
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeCaseStatus(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "in_progress") return "in progress";
  return lower;
}

function formatCaseStatus(value, caseData = {}) {
  const key = normalizeCaseStatus(value);
  if (!key) return "Open";
  const hasParalegal = !!(caseData?.paralegal || caseData?.paralegalId);
  const escrowFunded =
    !!caseData?.escrowIntentId && String(caseData?.escrowStatus || "").toLowerCase() === "funded";
  if (key === "awaiting_funding" || (hasParalegal && !escrowFunded && key !== "open")) {
    return "Hired - Pending Funding";
  }
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ensureCompleteModalStyles() {
  if (document.getElementById("case-complete-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "case-complete-modal-styles";
  style.textContent = `
    .case-complete-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1500}
    .case-complete-modal{background:var(--app-surface);color:var(--app-text);border:1px solid var(--app-border);border-radius:16px;padding:24px;max-width:520px;width:92%;box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:12px}
    .case-complete-title{font-weight:600;font-size:1.2rem}
    .case-complete-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
  `;
  document.head.appendChild(style);
}

function openCompleteConfirmModal() {
  return new Promise((resolve) => {
    ensureCompleteModalStyles();
    const overlay = document.createElement("div");
    overlay.className = "case-complete-overlay";
    overlay.innerHTML = `
      <div class="case-complete-modal" role="dialog" aria-modal="true" aria-labelledby="caseCompleteTitle">
        <div class="case-complete-title" id="caseCompleteTitle">Complete &amp; Release Funds</div>
        <p>Confirming will release escrow to the paralegal, lock messaging and file uploads, and archive the case.</p>
        <div class="case-complete-actions">
          <button class="case-action-btn secondary" type="button" data-complete-cancel>Cancel</button>
          <button class="case-action-btn" type="button" data-complete-confirm>Complete &amp; Release Funds</button>
        </div>
      </div>
    `;
    const close = (confirmed) => {
      overlay.remove();
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
  });
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
  if (status === CASE_STATES.FUNDED_IN_PROGRESS) return CASE_STATES.FUNDED_IN_PROGRESS;

  const hasParalegal = !!(caseData?.paralegal || caseData?.paralegalId);
  const escrowFunded =
    !!caseData?.escrowIntentId && String(caseData?.escrowStatus || "").toLowerCase() === "funded";
  if (hasParalegal && escrowFunded && FUNDED_WORKSPACE_STATUSES.has(status)) {
    return CASE_STATES.FUNDED_IN_PROGRESS;
  }
  if (status === CASE_STATES.DRAFT) return CASE_STATES.DRAFT;
  if (status === CASE_STATES.APPLIED) return CASE_STATES.APPLIED;
  if (status === CASE_STATES.OPEN || status === "assigned" || status === "awaiting_funding") {
    return viewerApplied(caseData) ? CASE_STATES.APPLIED : CASE_STATES.OPEN;
  }
  return status;
}

function isWorkspaceEligibleCase(caseData) {
  if (!caseData) return false;
  if (caseData.archived !== false) return false;
  if (caseData.paymentReleased !== false) return false;
  const status = normalizeCaseStatus(caseData?.status);
  if (!status || !FUNDED_WORKSPACE_STATUSES.has(status)) return false;
  const escrowFunded =
    !!caseData?.escrowIntentId && String(caseData?.escrowStatus || "").toLowerCase() === "funded";
  const hasParalegal = !!(caseData?.paralegal || caseData?.paralegalId);
  return hasParalegal && escrowFunded;
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
  if (["cancelled", "disputed"].includes(normalized)) {
    return "Workspace is closed for this case.";
  }
  return "Workspace unlocks once the case is funded and in progress.";
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
  if (role === "paralegal") return "dashboard-paralegal.html";
  if (role === "admin") return "admin-dashboard.html";
  return "dashboard-attorney.html#cases:archived";
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
  if (caseState !== CASE_STATES.FUNDED_IN_PROGRESS) {
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
    messagePanelBanner.textContent = message || "Workspace is locked.";
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
}

async function loadCases() {
  showMsg(caseListStatus, "Loading cases...");
  setCaseNavStatus("Loading cases...");
  const data = await fetchWithFallback(["/api/cases", "/api/cases/my"]);
  const allCases = normalizeCaseList(data);
  state.cases = allCases.filter((item) => isWorkspaceEligibleCase(item));
  if (!state.cases.length) {
    showMsg(caseListStatus, "No funded cases yet.");
    setCaseNavStatus("No funded cases.");
  } else {
    showMsg(caseListStatus, "");
    setCaseNavStatus("");
  }
  renderCaseList();
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
  const filtered = state.cases.filter((item) => {
    const title = String(item?.title || "");
    const matchesSearch = !search || title.toLowerCase().includes(search);
    const unread = state.unreadByCase.get(String(getCaseId(item))) || 0;
    const matchesFilter = state.filter === "unread" ? unread > 0 : true;
    return matchesSearch && matchesFilter;
  });

  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.textContent = search ? "No matching cases." : "No cases to show.";
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

  const currentUserId = getCurrentUserId();
  const currentRole = getCurrentUserRole();
  const canBlock = ["attorney", "paralegal"].includes(String(currentRole || "").toLowerCase());

  participants.forEach((entry) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${entry.label}: ${entry.value}`;
    li.appendChild(label);

    if (canBlock && entry.id && entry.id !== currentUserId) {
      const blockBtn = document.createElement("button");
      blockBtn.type = "button";
      blockBtn.textContent = "Block user";
      blockBtn.style.marginLeft = "8px";
      blockBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        blockUser(entry.id, entry.value);
      });
      li.appendChild(blockBtn);
    }
    caseParticipants.appendChild(li);
  });
}

async function blockUser(targetId, displayName) {
  if (!targetId) return;
  const name = displayName || "this user";
  const confirmed = window.confirm(`Block ${name}? They will no longer be able to interact with you.`);
  if (!confirmed) return;
  try {
    await fetchJSON("/api/blocks", { method: "POST", body: { blockedId: targetId } });
    window.alert("User blocked.");
    await loadCases();
    if (state.activeCaseId) {
      await loadCase(state.activeCaseId);
    }
  } catch (err) {
    window.alert(err?.message || "Unable to block user.");
  }
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
  const ext = getFileExtension(fileName);
  return ["pdf", "png", "jpg", "jpeg", "gif", "webp"].includes(ext);
}

function showDocumentActionMessage(message) {
  showMsg(messageStatus, message);
}

function buildViewUrl({ caseId, storageKey } = {}) {
  if (!caseId || !storageKey) return "";
  return `/api/uploads/view?caseId=${encodeURIComponent(caseId)}&key=${encodeURIComponent(storageKey)}`;
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
      return;
    }
  } catch (_) {}
  const cachedUser = window.getStoredUser?.();
  const cachedRole = String(cachedUser?.role || "").toLowerCase();
  if (cachedRole) applyRoleVisibility(cachedRole);
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
          entry.status = "uploaded";
          entry.progress = 100;
          entry.xhr = null;
          entry.error = "";
          renderPendingAttachment();
          removeAttachmentRecord(entry.id).catch(() => {});
          resolve();
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
      await sendWithEndpoint(endpoints[index]);
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

function renderCaseOverview(data) {
  const title = data?.title || "Case";
  const status = formatCaseStatus(data?.status, data);
  const summaryText = data?.briefSummary || data?.details || "";

  const escrowAmountRaw = Number.isFinite(data?.lockedTotalAmount)
    ? data.lockedTotalAmount / 100
    : Number.isFinite(data?.totalAmount)
    ? data.totalAmount / 100
    : null;

  const escrowStatus = data?.escrowStatus || (status ? status : "-");
  const hireDateValue = data?.hiredAt || data?.createdAt || "";
  const matterType = data?.practiceArea || data?.category || data?.type || "-";
  const deadlines = Array.isArray(data?.deadlines) ? data.deadlines : data?.deadline ? [data.deadline] : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data?.checklist) ? data.checklist : [];
  const zoomLink = data?.zoomLink || data?.meetingLink || "";
  const currency = data?.currency ? String(data.currency).toUpperCase() : "USD";
  const subtitleValue =
    data?.clientName ||
    data?.client?.name ||
    data?.client ||
    data?.company ||
    data?.firm ||
    data?.organization ||
    "Case details";

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
    if (["completed", "closed"].includes(normalized) && data?.paymentReleased) {
      messagePanelBanner.textContent = "Payment released. Workspace is now read-only.";
    } else {
      messagePanelBanner.textContent = opened ? `Opened on ${opened}` : "Case updates will appear here.";
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
        const label = deadline?.label || "Deadline";
        const date = formatDate(deadline?.date || deadline);
        li.textContent = date ? `${label}: ${date}` : String(deadline);
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
      tasks.forEach((task) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        const title =
          typeof task === "string"
            ? task
            : task?.title || task?.name || "";
        checkbox.type = "checkbox";
        checkbox.disabled = true;
        checkbox.checked = !!task?.completed;
        label.appendChild(checkbox);
        label.append(` ${title || "Task"}`);
        li.appendChild(label);
        caseTaskList.appendChild(li);
      });
    }
  }

  if (caseZoomLink) {
    if (zoomLink) {
      caseZoomLink.textContent = "Join scheduled Zoom";
      caseZoomLink.href = zoomLink;
    } else {
      caseZoomLink.textContent = "Zoom link not set";
      caseZoomLink.removeAttribute("href");
    }
  }
}

function updateCompleteAction(caseData, caseState) {
  if (!caseCompleteSection || !caseCompleteButton || !caseCompleteSection.isConnected) return;
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
  }
  if (!eligible) return;
  if (!caseCompleteButton.dataset.bound) {
    caseCompleteButton.dataset.bound = "true";
    caseCompleteButton.addEventListener("click", handleCompleteCase);
  }
}

async function handleCompleteCase() {
  if (state.completing) return;
  const caseId = state.activeCaseId;
  if (!caseId) return;
  const caseData = state.activeCase || {};
  const statusKey = normalizeCaseStatus(caseData?.status);
  const caseState = resolveCaseState(caseData);
  if (
    caseState !== CASE_STATES.FUNDED_IN_PROGRESS ||
    caseData?.readOnly ||
    caseData?.paymentReleased ||
    statusKey === "completed"
  ) {
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
  if (caseCompleteButton) {
    caseCompleteButton.textContent = "Releasing funds...";
  }
  showMsg(caseCompleteStatus, "Releasing funds...");
  try {
    await fetchCSRF().catch(() => "");
    await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}/complete`, { method: "POST" });
    const confirmation = "Payment released. Case completed and archived.";
    showMsg(caseCompleteStatus, confirmation);
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
    showMsg(caseCompleteStatus, err.message || "Unable to complete this case.");
  } finally {
    state.completing = false;
    if (caseCompleteButton && !completionSucceeded) {
      caseCompleteButton.disabled = false;
      caseCompleteButton.textContent = originalText || "Complete & Release Funds";
    }
  }
}

function renderThreadItems(messages, documents, caseId) {
  if (!messageList) return;
  emptyNode(messageList);

  const items = [];
  messages.forEach((msg) => {
    items.push({ type: "message", createdAt: msg?.createdAt, data: msg });
  });
  documents.forEach((doc) => {
    items.push({ type: "document", createdAt: doc?.createdAt, data: doc });
  });

  items.sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });

  if (messagePanelDivider) {
    const firstWithDate = items.find((item) => item.createdAt);
    if (firstWithDate?.createdAt) {
      const date = new Date(firstWithDate.createdAt);
      messagePanelDivider.textContent = Number.isNaN(date.getTime())
        ? "Today"
        : weekdayFormatter.format(date);
    } else {
      messagePanelDivider.textContent = "Today";
    }
  }

  if (!items.length) {
    const li = document.createElement("li");
    const empty = document.createElement("div");
    empty.className = "thread-card";
    empty.textContent = "No conversation yet. Start the thread below.";
    li.appendChild(empty);
    messageList.appendChild(li);
  } else {
    items.forEach((item) => {
      const li = document.createElement("li");
      if (item.type === "message") {
        li.appendChild(buildMessageCard(item.data));
      } else {
        li.appendChild(buildDocumentCard(item.data, caseId));
      }
      messageList.appendChild(li);
    });
  }

}

function buildMessageCard(message) {
  const sender = message?.senderId || {};
  const name = formatPerson(sender);
  const role = message?.senderRole || sender?.role || "Participant";
  const created = message?.createdAt || message?.created || "";
  const body = message?.text || message?.content || "";
  const avatarUrl = getAvatarUrl(message, sender);
  const senderId = getMessageSenderId(message);
  const currentUserId = getCurrentUserId();

  const card = document.createElement("article");
  card.className = "thread-card message-card";
  if (message?._id) card.dataset.messageId = message._id;
  if (senderId && currentUserId && senderId === currentUserId) {
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
  const downloadUrl =
    (caseId && docId ? `/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(docId)}/download` : "");
  const storageKey = documentData?.storageKey || documentData?.key || "";
  const mimeType = documentData?.mimeType || documentData?.mime || "";
  const canPreview = isPreviewSupported({ fileName, mimeType });
  const viewUrl = buildViewUrl({ caseId, storageKey });

  const card = document.createElement("article");
  card.className = "thread-card document-card";
  if (docId) card.dataset.documentId = docId;

  const header = document.createElement("header");
  header.className = "card-header";
  const title = document.createElement("h3");
  title.textContent = fileName;
  header.append(title);

  const footer = document.createElement("footer");
  footer.className = "card-footer";
  const actions = document.createElement("div");
  actions.className = "document-actions";
  actions.setAttribute("aria-label", "Document actions");

  if (downloadUrl || viewUrl) {
    const view = document.createElement("a");
    view.href = viewUrl || "#";
    view.target = "_blank";
    view.rel = "noopener";
    view.textContent = "View";
    view.addEventListener("click", (event) => {
      if (!viewUrl || !canPreview) {
        event.preventDefault();
        showDocumentActionMessage(
          canPreview
            ? "Preview unavailable for this file. Please download to view."
            : "Preview not supported for this file type. Please download to view."
        );
      }
    });

    const download = document.createElement("a");
    download.href = downloadUrl || "#";
    download.textContent = "Download";
    download.setAttribute("download", fileName);
    download.addEventListener("click", (event) => {
      if (!downloadUrl) {
        event.preventDefault();
        showDocumentActionMessage("Download unavailable for this file.");
      }
    });

    actions.append(view, download);
  }
  footer.appendChild(actions);

  card.append(header, footer);
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
  setActiveCase(caseId);
  await restorePendingAttachments(caseId);
  showMsg(messageStatus, "Loading case data...");
  try {
    const caseData = await fetchJSON(`/api/cases/${encodeURIComponent(caseId)}`);
    state.activeCase = caseData;
    const completionRedirect = getCompletionRedirect(caseData);
    if (completionRedirect) {
      removeWorkspaceActions();
      window.location.href = completionRedirect;
      return;
    }
    const caseState = resolveCaseState(caseData);
    if (shouldRedirectFromWorkspace(caseState)) {
      showMsg(messageStatus, workspaceLockCopy(caseState, caseData));
      redirectFromWorkspace();
      return;
    }
    renderParticipants(caseData);
    renderCaseOverview(caseData);
    updateCompleteAction(caseData, caseState);
    const workspace = getWorkspaceState(caseData, caseState);
    setWorkspaceEnabled(workspace.ready, workspace.reason);
    if (!workspace.ready) {
      renderWorkspaceLocked(workspace.reason);
      showMsg(messageStatus, workspace.reason);
      return;
    }

    let messages = [];
    let documents = [];

    try {
      const messagesData = await fetchWithFallback(
        [
          `/api/chat/${encodeURIComponent(caseId)}`,
          `/api/messages?caseId=${encodeURIComponent(caseId)}`,
          `/api/messages/${encodeURIComponent(caseId)}`,
        ],
        { cache: "no-store" }
      );
      messages = normalizeMessages(messagesData);
    } catch (err) {
      showMsg(messageStatus, err.message || "Unable to load messages.");
    }

    try {
      const documentsData = await fetchWithFallback(
        [
          `/api/uploads/case/${encodeURIComponent(caseId)}`,
          `/api/uploads?caseId=${encodeURIComponent(caseId)}`,
        ],
        { cache: "no-store" }
      );
      documents = normalizeDocuments(documentsData);
    } catch {
      documents = [];
    }

    renderThreadItems(messages, documents, caseId);
    if (state.unreadByCase.has(caseId)) {
      state.unreadByCase.set(caseId, 0);
      renderCaseList();
    }
    showMsg(messageStatus, "");
  } catch (err) {
    showMsg(messageStatus, err.message || "Unable to load case.");
  }
}

async function handleSendMessage(event) {
  event.preventDefault();
  const caseId = state.activeCaseId;
  if (!caseId) return;
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
      await fetchWithFallback(
        [
          `/api/chat/${encodeURIComponent(caseId)}`,
          "/api/messages",
          `/api/messages?caseId=${encodeURIComponent(caseId)}`,
          `/api/messages/${encodeURIComponent(caseId)}`,
        ],
        {
          method: "POST",
          body: { text, content: text, caseId },
        }
      );
      messageInput.value = "";
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

function handleSearch(event) {
  state.search = event.target.value || "";
  renderCaseList();
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

function renderCaseNavList() {
  if (!caseNavLists.length) return;
  const activeCases = getActiveCases(state.cases);
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

function init() {
  syncThemeFromSession();
  syncRoleVisibility();
  loadUserHeaderInfo().catch(() => {});
  initBackButton();
  initProfileMenu();
  initCaseNavDropdowns();
  if (messageForm) {
    messageForm.addEventListener("submit", handleSendMessage);
  }
  if (messageInput) {
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
  if (caseList) {
    caseList.addEventListener("click", handleCaseListClick);
  }
  if (caseSearchInput) {
    caseSearchInput.addEventListener("input", handleSearch);
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
      const initial = fromQuery || (state.cases[0] ? getCaseId(state.cases[0]) : "");
      if (initial) {
        loadCase(initial);
        return;
      }
      showMsg(caseListStatus, "No funded cases yet.");
      setCaseNavStatus("No funded cases.");
    })
    .catch((err) => {
      showMsg(caseListStatus, err.message || "Unable to load cases.");
    });
}

init();
