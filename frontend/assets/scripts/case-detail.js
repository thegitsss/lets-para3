import { secureFetch, fetchCSRF, showMsg } from "./auth.js";

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
const messageComposer = document.querySelector(".message-composer");
const caseEscrowAmount = document.getElementById("caseEscrowAmount");
const caseEscrowStatus = document.getElementById("caseEscrowStatus");
const caseHireDate = document.getElementById("caseHireDate");
const caseMatterType = document.getElementById("caseMatterType");
const caseDeadlineList = document.getElementById("caseDeadlineList");
const caseSummary = document.getElementById("caseSummary");
const caseTaskList = document.getElementById("caseTaskList");
const caseZoomLink = document.getElementById("caseZoomLink");
const caseThread = document.getElementById("case-messages");
const caseSearchInput = document.getElementById("case-search");
const caseTabs = document.querySelectorAll(".case-rail-tabs button");

const ATTACHMENT_DB = "lpc_case_attachments";
const ATTACHMENT_STORE = "attachments";
let attachmentDbPromise = null;

const state = {
  cases: [],
  activeCaseId: "",
  unreadByCase: new Map(),
  filter: "active",
  search: "",
  pendingAttachments: [],
  sending: false,
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

async function loadCases() {
  showMsg(caseListStatus, "Loading cases...");
  const data = await fetchWithFallback(["/api/cases", "/api/cases/my"]);
  state.cases = normalizeCaseList(data);
  if (!state.cases.length) {
    showMsg(caseListStatus, "No active cases found.");
  } else {
    showMsg(caseListStatus, "");
  }
  renderCaseList();
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
    const status = String(item?.status || "").replace(/_/g, " ").trim();
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
    participants.push({ label: "Attorney", value: formatPerson(attorney) });
  }
  if (paralegal) {
    participants.push({ label: "Paralegal", value: formatPerson(paralegal) });
  }

  if (!participants.length) {
    const li = document.createElement("li");
    li.textContent = "Participants will appear once assigned.";
    caseParticipants.appendChild(li);
    return;
  }

  participants.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = `${entry.label}: ${entry.value}`;
    caseParticipants.appendChild(li);
  });
}

function formatPerson(person) {
  if (!person) return "Team member";
  if (typeof person === "string") return person;
  const fullName = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
  return fullName || person.name || person.email || person.role || "Team member";
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
    "/api/uploads",
    `/api/uploads?caseId=${encodeURIComponent(caseId)}`,
    `/api/uploads/${encodeURIComponent(caseId)}`,
    `/api/uploads/case/${encodeURIComponent(caseId)}`,
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
        const error = new Error(`Upload failed (${xhr.status})`);
        error.status = xhr.status;
        entry.error = `Upload failed (${xhr.status}).`;
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

function handleDragOver(event) {
  event.preventDefault();
  if (messageComposer) messageComposer.classList.add("is-dragover");
}

function handleDragLeave(event) {
  if (event.target === messageComposer || event.currentTarget === messageComposer) {
    if (messageComposer) messageComposer.classList.remove("is-dragover");
  }
}

function handleDrop(event) {
  event.preventDefault();
  if (messageComposer) messageComposer.classList.remove("is-dragover");
  addPendingAttachments(event.dataTransfer?.files);
}

function handleAttachmentChange(event) {
  addPendingAttachments(event.target?.files);
  if (messageAttachment) messageAttachment.value = "";
}

function renderCaseOverview(data) {
  const title = data?.title || "Case";
  const status = String(data?.status || "").replace(/_/g, " ").trim();
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

  if (caseTitle) caseTitle.textContent = title;
  if (caseStatusLine) {
    caseStatusLine.textContent = status ? `Status: ${status}` : "Status: -";
  }
  if (caseEscrowAmount) caseEscrowAmount.textContent = formatCurrency(escrowAmountRaw, currency);
  if (caseEscrowStatus) caseEscrowStatus.textContent = escrowStatus || "-";
  if (caseHireDate) caseHireDate.textContent = formatDate(hireDateValue) || "-";
  if (caseMatterType) caseMatterType.textContent = matterType || "-";
  if (caseSummary) caseSummary.textContent = summaryText || "No case summary yet.";

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
        checkbox.type = "checkbox";
        checkbox.disabled = true;
        checkbox.checked = !!task?.completed;
        label.appendChild(checkbox);
        label.append(` ${task?.title || task?.name || "Task"}`);
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

  const card = document.createElement("article");
  card.className = "thread-card message-card";
  if (message?._id) card.dataset.messageId = message._id;

  const header = document.createElement("header");
  header.className = "card-header";

  const left = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = name;
  const roleNode = document.createElement("p");
  roleNode.className = "card-role";
  roleNode.textContent = role;
  left.append(title, roleNode);

  const time = document.createElement("time");
  if (created) time.setAttribute("datetime", created);
  time.textContent = formatTime(created);

  header.append(left, time);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "card-body";
  const bodyText = document.createElement("p");
  bodyText.textContent = body || "Message content unavailable.";
  bodyWrap.appendChild(bodyText);

  card.append(header, bodyWrap);
  return card;
}

function buildDocumentCard(documentData, caseId) {
  const fileName = documentData?.originalName || documentData?.filename || documentData?.name || "Document";
  const uploader = resolveUploader(documentData);
  const created = documentData?.createdAt || "";
  const docId = documentData?.id || documentData?._id || "";
  const previewUrl =
    (caseId && docId ? `/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(docId)}/download` : "");
  const description =
    documentData?.description ||
    documentData?.note ||
    documentData?.revisionNotes ||
    "No description provided.";

  const card = document.createElement("article");
  card.className = "thread-card document-card";
  if (docId) card.dataset.documentId = docId;

  const header = document.createElement("header");
  header.className = "card-header";
  const left = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = fileName;
  const roleNode = document.createElement("p");
  roleNode.className = "card-role";
  roleNode.textContent = "Secure document card";
  left.append(title, roleNode);

  const time = document.createElement("time");
  if (created) time.setAttribute("datetime", created);
  time.textContent = formatTime(created);
  header.append(left, time);

  const body = document.createElement("div");
  body.className = "card-body";
  const details = document.createElement("dl");

  details.appendChild(buildDefinition("File", fileName));
  details.appendChild(buildDefinition("Prepared by", formatPerson(uploader)));
  details.appendChild(buildDefinition("Status", "Ready for review"));

  const note = document.createElement("p");
  note.textContent = description;
  body.append(details, note);

  const footer = document.createElement("footer");
  footer.className = "card-footer";
  const actions = document.createElement("div");
  actions.className = "document-actions";
  actions.setAttribute("aria-label", "Document actions");

  if (previewUrl) {
    const view = document.createElement("a");
    view.href = previewUrl;
    view.target = "_blank";
    view.rel = "noopener";
    view.textContent = "View";

    const download = document.createElement("a");
    download.href = previewUrl;
    download.textContent = "Download";
    download.setAttribute("download", fileName);

    actions.append(view, download);
  }
  footer.appendChild(actions);

  card.append(header, body, footer);
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
    renderParticipants(caseData);
    renderCaseOverview(caseData);

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
          `/api/uploads?caseId=${encodeURIComponent(caseId)}`,
          `/api/uploads/case/${encodeURIComponent(caseId)}`,
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

function init() {
  if (messageForm) {
    messageForm.addEventListener("submit", handleSendMessage);
  }
  if (messageAttachment) {
    messageAttachment.addEventListener("change", handleAttachmentChange);
  }
  if (messageComposer) {
    messageComposer.addEventListener("dragover", handleDragOver);
    messageComposer.addEventListener("dragleave", handleDragLeave);
    messageComposer.addEventListener("drop", handleDrop);
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
      const initial = fromQuery || getCaseId(state.cases[0]);
      if (initial) loadCase(initial);
    })
    .catch((err) => {
      showMsg(caseListStatus, err.message || "Unable to load cases.");
    });
}

init();
