// Shared notification center for headers
import { secureFetch } from "../auth.js";

const NOTIFICATION_STYLE_ID = "lpc-notification-styles";
let lastKnownUnread = 0;

function ensureNotificationStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(NOTIFICATION_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = NOTIFICATION_STYLE_ID;
  style.textContent = `
    .notification-wrapper{position:relative;}
    .notification-dropdown{position:absolute;top:calc(100% + 8px);right:0;z-index:100000;}
    [data-notification-list]{max-height:220px;overflow-y:auto;}
    .notif-item{display:flex;align-items:flex-start;gap:12px;}
    .notif-main{display:flex;align-items:flex-start;gap:12px;flex:1;}
    .notif-avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#f2f4f8;flex-shrink:0;}
    .notif-copy{display:flex;flex-direction:column;gap:4px;flex:1;}
    .notif-dot{width:10px;height:10px;border-radius:50%;background:var(--accent,#b6a47a);margin-top:6px;opacity:0;flex-shrink:0;}
    .notif-item.unread .notif-dot{opacity:0.9;}
    .notif-dismiss{background:transparent;border:none;color:var(--muted,#7a7a7a);font-size:0.9rem;cursor:pointer;padding:6px;border-radius:8px;align-self:flex-start;flex-shrink:0;}
    .notif-dismiss:hover{background:rgba(0,0,0,0.06);color:var(--ink,#1a1a1a);}
    .notif-time{color:var(--muted,#6b7280);}
    .notif-header{display:flex;align-items:center;justify-content:space-between;gap:12px;}
    .notif-header-title{flex:1;}
    .notif-actions{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:1px solid rgba(0,0,0,0.08);background:transparent;}
    .notif-actions.notif-actions-header{padding:0;border-top:none;background:transparent;margin-left:auto;}
    .notif-actions .notif-markall{border:1px solid rgba(0,0,0,0.2);background:transparent;color:var(--ink,#1a1a1a);padding:4px 8px;text-align:center;font-size:0.78rem;font-weight:400;border-radius:4px;cursor:pointer;box-shadow:none;}
    .notif-actions .notif-markall:hover{background:transparent;box-shadow:none;color:var(--ink,#1a1a1a);}
    .notif-actions .notif-clear{border-color:rgba(0,0,0,0.2);color:var(--ink,#1a1a1a);}
    .notif-actions .notif-clear:hover{background:transparent;box-shadow:none;color:var(--ink,#1a1a1a);}
    .notif-actions .notif-markall:disabled{opacity:0.5;cursor:default;}
    @media (max-width: 600px){
      .notification-dropdown,
      [data-notification-panel],
      .notifications-panel{
        position:fixed !important;
        left:12px !important;
        right:12px !important;
        top:64px !important;
        width:auto !important;
        max-width:calc(100vw - 24px) !important;
      }
      [data-notification-list]{max-height:50vh;}
      .notif-actions.notif-actions-header{flex-wrap:wrap;justify-content:flex-end;gap:6px;}
    }
  `;
  document.head.appendChild(style);
}

function normalizeNotification(item = {}) {
  const hasRead = typeof item.read === "boolean";
  const hasIsRead = typeof item.isRead === "boolean";
  const read = hasRead ? item.read : hasIsRead ? item.isRead : false;
  return { ...item, isRead: read, read };
}

function isNotificationRead(item = {}) {
  return item?.read === true;
}

function getUnreadCount(list = []) {
  return list.filter((item) => item?.read === false).length;
}

function getAvatarFallback(name = "") {
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#eef1f7"/><text x="50%" y="56%" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="#5c6477">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const ADMIN_NOTIFICATION_IMAGE = "/hero-mountain.jpg";
const ADMIN_TITLE_HINT = "welcome to let's-paraconnect";

function isAdminNotification(item = {}) {
  const actorName = String(item.actorFirstName || "").trim().toLowerCase();
  const payloadRole = String(item.payload?.actorRole || item.payload?.fromRole || "").trim().toLowerCase();
  const fromName = String(item.payload?.fromName || "").trim().toLowerCase();
  if (actorName === "admin" || payloadRole === "admin" || fromName === "admin") return true;
  const message = String(item.message || item.payload?.message || "").trim().toLowerCase();
  const title = String(item.payload?.title || "").trim().toLowerCase();
  if (message.includes(ADMIN_TITLE_HINT) || title.includes(ADMIN_TITLE_HINT)) return true;
  const type = String(item.type || "").trim().toLowerCase();
  return type === "paralegal_welcome";
}

function getNotificationAvatar(item = {}, actorName = "") {
  if (item.actorProfileImage) return item.actorProfileImage;
  if (isAdminNotification(item)) return ADMIN_NOTIFICATION_IMAGE;
  return getAvatarFallback(actorName);
}

function formatNotificationMessage(item = {}) {
  if (item.type === "paralegal_welcome") {
    const title = String(item.payload?.title || "").trim();
    const body = String(item.payload?.body || "").trim();
    if (title && body) {
      return `${title} ${body}`;
    }
    if (item.message) {
      return item.message.replace(/\.\./g, ".");
    }
  }
  if (item.message) return item.message;
  if (item.type === "message" && item.actorFirstName) {
    return `${item.actorFirstName} sent you a message.`;
  }
  return "You have a new notification.";
}

export async function loadNotifications() {
  try {
    const res = await fetch("/api/notifications", { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const items = (Array.isArray(payload) ? payload : []).map(normalizeNotification);

    const lists = document.querySelectorAll("[data-notification-list]");
    lists.forEach((listEl) => {
      const emptyEl = listEl.parentElement?.querySelector("[data-notification-empty]") || null;
      renderNotificationList(listEl, emptyEl, items);
    });

    const unreadCount = getUnreadCount(items);
    lastKnownUnread = unreadCount;
    syncNotificationBadges(unreadCount);
  } catch (err) {
    console.warn("[notifications] loadNotifications failed", err);
  }
}

function formatNotificationTitle(item = {}) {
  switch (item.type) {
    case "message":
      return "New Message";
    case "case_invite":
      return "Case Invitation";
    case "case_update":
      return "Case Update";
    case "case_invite_response":
      return "Invitation Update";
    case "application_submitted":
      return "New Application";
    case "application_accepted":
      return "Application Accepted";
    case "application_denied":
      return "Application Update";
    case "profile_approved":
      return "Profile Approved";
    case "profile_photo_approved":
      return "Profile Photo Approved";
    case "resume_uploaded":
      return "Resume Updated";
    case "payout_released":
      return "Payout Released";
    case "case_awaiting_funding":
      return "Funding Needed";
    case "case_work_ready":
      return "Work Ready";
    case "case_file_uploaded":
      return "Document Uploaded";
    default:
      return "Notification";
  }
}

function formatNotificationBody(item = {}) {
  const payload = item.payload || {};
  switch (item.type) {
    case "message":
      return `Message from ${payload.fromName || "a user"}`;
    case "case_invite":
      return `You've been invited to "${payload.caseTitle || "a case"}"`;
    case "case_invite_response":
      if (payload.response === "accepted") {
        return `${payload.paralegalName || "Paralegal"} accepted your invitation`;
      }
      if (payload.response === "filled") {
        return `The position for "${payload.caseTitle || "this case"}" has been filled.`;
      }
      return `${payload.paralegalName || "Paralegal"} declined your invitation`;
    case "case_update":
      return payload.summary || `Case "${payload.caseTitle || "update"}" has changed.`;
    case "application_submitted":
      return `${payload.paralegalName || "A paralegal"} applied to "${payload.title || "your job"}"`;
    case "application_accepted":
      return `Your application for "${payload.caseTitle || "the case"}" was accepted.`;
    case "application_denied":
      return `Your application for "${payload.caseTitle || "the case"}" was not selected.`;
    case "resume_uploaded":
      return "Your resume has been successfully uploaded.";
    case "profile_approved":
      return "Your profile was approved.";
    case "profile_photo_approved":
      return "Your profile photo was approved.";
    case "payout_released":
      return `Your payout is on the way${payload.amount ? ` (${payload.amount})` : ""}.`;
    case "case_awaiting_funding":
      return `${payload.caseTitle || "A case"} is awaiting funding.`;
    case "case_work_ready":
      return `${payload.caseTitle || "A case"} is funded. Work can begin.`;
    case "case_file_uploaded":
      return `${payload.fileName || "A document"} was uploaded${payload.caseTitle ? ` to "${payload.caseTitle}"` : "."}`;
    default:
      return "You have a new notification.";
  }
}

function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function markNotificationRead(id) {
  if (!id) return false;
  try {
    await secureFetch(`/api/notifications/${id}/read`, {
      method: "POST",
      credentials: "include",
    });
    return true;
  } catch (err) {
    console.warn("[notifications] mark single read failed", err);
    return false;
  }
}

const centers = [];
let dismissBound = false;
let initBound = false;

function closeAllNotificationPanels() {
  document.querySelectorAll("[data-notification-panel].show").forEach((panel) => {
    panel.classList.remove("show");
    panel.classList.add("hidden");
  });
  document.querySelectorAll(".notification-dropdown").forEach((dropdown) => {
    dropdown.style.display = "none";
  });
}

function totalUnread() {
  if (!centers.length) return lastKnownUnread || 0;
  const ids = new Set();
  centers.forEach((center, centerIndex) => {
    (center.notifications || []).forEach((item, itemIndex) => {
      if (item?.read !== false) return;
      const id = item?._id || item?.id;
      ids.add(id ? String(id) : `${centerIndex}-${itemIndex}`);
    });
  });
  return ids.size;
}

ensureNotificationStyles();

export function scanNotificationCenters() {
  document.querySelectorAll("[data-notification-center]").forEach((root) => {
    if (root.dataset.boundNotificationCenter === "true") return;
    const center = createCenter(root);
    if (center) {
      centers.push(center);
      preload(center);
    }
  });
  bindGlobalDismiss();
}

export function initNotificationCenters() {
  if (initBound) return;
  initBound = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanNotificationCenters, { once: true });
  } else {
    scanNotificationCenters();
  }
}

// Auto-init on import
const notificationsOptOut =
  typeof window !== "undefined" && window.__SKIP_NOTIFICATIONS__ === true;
if (!notificationsOptOut) {
  initNotificationCenters();
}
// Expose for late-mounted clusters (e.g., injected shells)
if (typeof window !== "undefined") {
  window.initNotificationCenters = scanNotificationCenters;
  window.scanNotificationCenters = scanNotificationCenters;
  window.refreshNotificationCenters = refreshNotificationCenters;
  window.initPushNotifications = initPushNotifications;
}

function refreshNotificationCenters() {
  centers.forEach((center) => {
    if (center.loading) return;
    center.loaded = false;
    fetchNotifications(center);
  });
}

function createCenter(root) {
  const toggle = root.querySelector("[data-notification-toggle]");
  const panel = root.querySelector("[data-notification-panel]");
  if (!toggle || !panel) return null;
  const badge = root.querySelector("[data-notification-badge]");
  const list = root.querySelector("[data-notification-list]");
  const empty = root.querySelector("[data-notification-empty]");
  const markBtn = root.querySelector("[data-notification-mark]");
  let clearBtn = root.querySelector("[data-notification-clear]");
  if (!clearBtn && panel) {
    clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "notif-markall notif-clear";
    clearBtn.textContent = "Clear All";
    clearBtn.setAttribute("data-notification-clear", "true");
  }
  const header = panel?.querySelector(".notif-header") || null;
  let actionsWrap = panel?.querySelector(".notif-actions") || null;
  if (panel && !actionsWrap && (markBtn || clearBtn)) {
    actionsWrap = document.createElement("div");
    actionsWrap.className = "notif-actions";
  }
  if (actionsWrap) {
    if (markBtn) actionsWrap.appendChild(markBtn);
    if (clearBtn) actionsWrap.appendChild(clearBtn);
    if (header) {
      let titleEl = header.querySelector(".notif-header-title");
      if (!titleEl) {
        titleEl = document.createElement("span");
        titleEl.className = "notif-header-title";
        titleEl.textContent = header.textContent.trim();
        header.textContent = "";
        header.appendChild(titleEl);
      }
      actionsWrap.classList.add("notif-actions-header");
      header.appendChild(actionsWrap);
    } else if (panel && !panel.contains(actionsWrap)) {
      panel.appendChild(actionsWrap);
    }
  } else if (clearBtn && panel) {
    panel.appendChild(clearBtn);
  }
  const state = {
    root,
    toggle,
    panel,
    badge,
    list,
    empty,
    markBtn,
    clearBtn,
    notifications: [],
    unread: 0,
    loading: false,
    loaded: false,
  };

  if (!root.dataset.boundNotificationCenter) {
    root.dataset.boundNotificationCenter = "true";
    toggle.addEventListener("click", () => togglePanel(state));
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        togglePanel(state);
      }
    });
    markBtn?.addEventListener("click", () => markNotificationsRead(state));
    clearBtn?.addEventListener("click", () => clearNotifications(state));
  }
  return state;
}

function togglePanel(center) {
  const willShow = !center.panel.classList.contains("show");
  document.querySelectorAll("[data-notification-panel].show").forEach((panel) => {
    if (panel !== center.panel) panel.classList.remove("show");
  });
  center.panel.classList.toggle("show", willShow);
  center.panel.classList.toggle("hidden", !willShow);
  if (willShow) {
    if (!center.loaded) {
      fetchNotifications(center, { markReadOnLoad: true });
    } else {
      markNotificationsRead(center);
    }
  }
}

function preload(center) {
  renderEmpty(center, "Loading...");
  fetchNotifications(center);
}

async function fetchNotifications(center, options = {}) {
  if (center.loading) return;
  center.loading = true;
  try {
    const res = await secureFetch("/api/notifications", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      noRedirect: true,
    });
    if (res.status === 401 || res.status === 403) {
      lastKnownUnread = 0;
      syncNotificationBadges(0);
      renderEmpty(center, "Sign in to view notifications.");
      center.loaded = true;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    center.notifications = Array.isArray(payload) ? payload.map(normalizeNotification) : [];
    center.unread = getUnreadCount(center.notifications);
    center.loaded = true;
    renderNotifications(center);
    const total = totalUnread();
    lastKnownUnread = total;
    syncNotificationBadges(total);
    if (options.markReadOnLoad && center.unread > 0 && center.panel.classList.contains("show")) {
      await markNotificationsRead(center);
    }
  } catch (err) {
    console.warn("[notifications] load failed", err);
    renderEmpty(center, "Notifications unavailable.");
  } finally {
    center.loading = false;
  }
}

function renderNotifications(center) {
  center.unread = getUnreadCount(center.notifications || []);
  updateBadge(center, center.unread);
  if (!center.list || !center.empty) {
    const totalIfMissing = totalUnread();
    lastKnownUnread = totalIfMissing;
    syncNotificationBadges(totalIfMissing);
    return;
  }
  center.list.innerHTML = "";
  if (!center.notifications.length) {
    renderEmpty(center, "You're all caught up.");
    return;
  }
  center.empty.style.display = "none";
  center.notifications.forEach((item) => {
    const node = buildNotificationNode(item, center);
    center.list.appendChild(node);
  });
  const total = totalUnread();
  lastKnownUnread = total;
  syncNotificationBadges(total);
}

function renderEmpty(center, text) {
  if (center) {
    center.unread = getUnreadCount(center.notifications || []);
  }
  if (center.empty) {
    center.empty.style.display = "block";
    center.empty.textContent = text;
  }
  if (center.list) center.list.innerHTML = "";
  updateBadge(center, getUnreadCount(center?.notifications || []));
  syncNotificationBadges(totalUnread());
}

function updateBadge(center, count) {
  if (!center.badge) return;
  const value = Math.max(0, Number(count) || 0);
  center.badge.textContent = String(value);
  center.badge.classList.toggle("show", value > 0);
}

async function markNotificationsRead(center) {
  const hasUnread = (center.notifications || []).some((item) => !isNotificationRead(item));
  if (!hasUnread) return;
  try {
    await secureFetch("/api/notifications/read-all", {
      method: "POST",
      credentials: "include",
    });
    centers.forEach((c) => {
      c.notifications = (c.notifications || []).map((item) => ({ ...item, read: true, isRead: true }));
      c.unread = getUnreadCount(c.notifications);
      updateBadge(c, c.unread);
      if (c !== center) renderNotifications(c);
    });
    renderNotifications(center);
  } catch (err) {
    console.warn("[notifications] mark read failed", err);
  }
}

async function clearNotifications(center) {
  if (!center?.notifications?.length) {
    renderEmpty(center, "You're all caught up.");
    return;
  }
  const confirmed = window.confirm("Confirm clear all notifications?");
  if (!confirmed) return;
  try {
    await secureFetch("/api/notifications", {
      method: "DELETE",
      credentials: "include",
    });
    centers.forEach((c) => {
      c.notifications = [];
      c.unread = getUnreadCount(c.notifications);
      renderEmpty(c, "You're all caught up.");
    });
    syncNotificationBadges(totalUnread());
  } catch (err) {
    console.warn("[notifications] clear all failed", err);
  }
}

async function dismissNotification(center, id, options = {}) {
  if (!id) return false;
  const store = Array.isArray(options.store) ? options.store : null;
  try {
    await secureFetch(`/api/notifications/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch (err) {
    console.warn("[notifications] dismiss failed", err);
  }
  const targetId = String(id);
  if (store) {
    const updated = store.filter((item) => String(item._id || item.id) !== targetId);
    if (updated.length !== store.length) {
      store.splice(0, store.length, ...updated);
    }
  }
  centers.forEach((c) => {
    const before = (c.notifications || []).length;
    c.notifications = (c.notifications || []).filter(
      (item) => String(item._id || item.id) !== targetId
    );
    if (before !== c.notifications.length) {
      c.unread = getUnreadCount(c.notifications);
      updateBadge(c, c.unread);
      renderNotifications(c);
    }
  });
  if (!centers.length) {
    if (store) {
      syncNotificationBadges(getUnreadCount(store));
    } else {
      syncNotificationBadges(lastKnownUnread || 0);
    }
    return true;
  }
  syncNotificationBadges(totalUnread());
  return true;
}

function bindGlobalDismiss() {
  if (dismissBound) return;
  dismissBound = true;
  const isNotificationTarget = (event) => {
    const target = event.target;
    if (target?.closest?.("[data-notification-panel], [data-notification-toggle], .notification-dropdown")) {
      return true;
    }
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.some(
      (node) =>
        node?.matches?.("[data-notification-panel]") ||
        node?.matches?.("[data-notification-toggle]") ||
        node?.matches?.(".notification-dropdown")
    );
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (isNotificationTarget(event)) return;
      closeAllNotificationPanels();
    },
    true
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllNotificationPanels();
    }
  });
}

function bindMinimalToggleHandler() {
  document.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-notification-toggle]");
    if (!toggle) {
      const panel = event.target.closest("[data-notification-panel]");
      if (panel) return;
      closeAllNotificationPanels();
      return;
    }
    const root = toggle.closest("[data-notification-center]") || document;
    const panel =
      root.querySelector("[data-notification-panel]") ||
      toggle.parentElement?.querySelector("[data-notification-panel]");
    if (!panel) return;
    const willShow = !panel.classList.contains("show");
    document.querySelectorAll("[data-notification-panel]").forEach((node) => {
      if (node !== panel) {
        node.classList.remove("show");
        node.classList.add("hidden");
      }
    });
    panel.classList.toggle("show", willShow);
    panel.classList.toggle("hidden", !willShow);
  });
}

function formatRelativeTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Moments ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function extractId(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return value._id || value.id || value.caseId || value.jobId || "";
  }
  return value;
}

function resolveNotificationLink(item = {}) {
  const payload = item.payload || {};
  const primaryLink = typeof item.link === "string" ? item.link.trim() : "";
  const payloadLink = typeof payload.link === "string" ? payload.link.trim() : "";
  const payloadUrl = typeof payload.url === "string" ? payload.url.trim() : "";
  const explicitLink = primaryLink || payloadLink || payloadUrl;
  if (explicitLink) return explicitLink;
  const type = String(item.type || "").toLowerCase();
  const role = String(item.userRole || "").toLowerCase();
  const caseId = extractId(
    item.caseId ||
      payload.caseId ||
      payload.caseID ||
      payload.case ||
      payload.case_id ||
      payload.caseRef ||
      payload.caseDoc
  );
  if (caseId) {
    const base = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
    if (type === "message") return `${base}#messages`;
    if (type === "case_file_uploaded") return `${base}#caseFilesSection`;
    if (type === "case_invite") return "paralegal-invitations.html";
    return base;
  }
  if (type === "case_invite") return "paralegal-invitations.html";
  const jobId = extractId(item.jobId || payload.jobId || payload.job || payload.job_id || payload.jobRef);
  if (type === "application_submitted" && role === "attorney") {
    return "dashboard-attorney.html#applicationsSection";
  }
  if (type === "application_accepted") {
    return caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}` : "dashboard-paralegal.html";
  }
  if (type === "application_denied") {
    return "browse-jobs.html";
  }
  if (jobId) return `browse-jobs.html?id=${encodeURIComponent(jobId)}`;
  if (type === "profile_approved" || type === "profile_photo_approved" || type === "resume_uploaded") {
    return "profile-settings.html";
  }
  if (type === "payout_released") {
    return role === "attorney" ? "dashboard-attorney.html#billing" : "dashboard-paralegal.html";
  }
  if (role === "attorney") return "dashboard-attorney.html";
  if (role === "paralegal") return "dashboard-paralegal.html";
  return "";
}

if (!notificationsOptOut) {
  document.addEventListener("DOMContentLoaded", () => {
    ensureNotificationStyles();
    loadNotifications();
    initPushNotifications();
    bindMinimalToggleHandler();
  });
}

async function initPushNotifications() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const permission = await window.Notification?.requestPermission?.();
    if (permission && permission !== "granted") return;
    const publicKey = await fetchVapidKey();
    if (!publicKey) return;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await sendSubscriptionToServer(existing);
      return;
    }
    const convertedKey = urlBase64ToUint8Array(publicKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedKey,
    });
    await sendSubscriptionToServer(subscription);
  } catch (err) {
    console.warn("[push] initialization failed", err);
  }
}

async function fetchVapidKey() {
  try {
    const res = await fetch("/api/notifications/vapid-key");
    if (!res.ok) return null;
    const data = await res.json();
    return data?.key || null;
  } catch {
    return null;
  }
}

async function sendSubscriptionToServer(subscription) {
  try {
    await fetch("/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(subscription),
    });
  } catch (err) {
    console.warn("[push] subscription save failed", err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function buildNotificationNode(item = {}, center = null, options = {}) {
  const normalized = normalizeNotification(item);
  const onDismiss = typeof options.onDismiss === "function" ? options.onDismiss : null;
  const wrapper = document.createElement("div");
  wrapper.className = `notif-item ${normalized.isRead ? "read" : "unread"}`;
  wrapper.dataset.id = normalized.id || normalized._id || "";
  const actorName = normalized.actorFirstName || "";

  const avatar = document.createElement("img");
  avatar.className = "notif-avatar";
  avatar.src = getNotificationAvatar(normalized, actorName);
  avatar.alt = actorName
    ? `${actorName}'s profile photo`
    : isAdminNotification(normalized)
    ? "Admin notification"
    : "Notification";
  avatar.loading = "lazy";

  const dot = document.createElement("span");
  dot.className = "notif-dot";
  dot.setAttribute("aria-hidden", "true");

  const message = document.createElement("div");
  message.className = "notif-title";
  message.textContent = formatNotificationMessage(normalized);

  const time = document.createElement("div");
  time.className = "notif-time";
  time.textContent = formatRelativeTime(normalized.createdAt);

  const copy = document.createElement("div");
  copy.className = "notif-copy";
  copy.appendChild(message);
  copy.appendChild(time);

  const main = document.createElement("div");
  main.className = "notif-main";
  main.appendChild(dot);
  main.appendChild(copy);

  const dismiss = document.createElement("button");
  dismiss.className = "notif-dismiss";
  dismiss.type = "button";
  dismiss.title = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss notification");
  dismiss.textContent = "x";
  dismiss.addEventListener("click", async (event) => {
    event.stopPropagation();
    const ok = await dismissNotification(center, normalized._id || normalized.id, options);
    if (!center && ok) {
      wrapper.remove();
      if (onDismiss) onDismiss();
    }
  });

  wrapper.appendChild(avatar);
  wrapper.appendChild(main);
  wrapper.appendChild(dismiss);

  const link = resolveNotificationLink(normalized);
  wrapper.addEventListener("click", async () => {
    const id = normalized._id || normalized.id;
    if (!isNotificationRead(normalized) && id) {
      const success = await markNotificationRead(id);
      if (success) {
        normalized.isRead = true;
        normalized.read = true;
        wrapper.classList.remove("unread");
        wrapper.classList.add("read");
        if (centers.length) {
          const targetId = String(id);
          centers.forEach((c) => {
            let touched = false;
            c.notifications = (c.notifications || []).map((n) => {
              if (String(n._id || n.id) !== targetId) return n;
              touched = true;
              return { ...n, isRead: true, read: true };
            });
            if (touched) {
              c.unread = getUnreadCount(c.notifications);
              updateBadge(c, c.unread);
              renderNotifications(c);
            }
          });
          const total = totalUnread();
          syncNotificationBadges(total);
        } else if (Array.isArray(options.store)) {
          const targetId = String(id);
          const store = options.store;
          let touched = false;
          const updated = store.map((entry) => {
            if (String(entry._id || entry.id) !== targetId) return entry;
            touched = true;
            return { ...entry, isRead: true, read: true };
          });
          if (touched) {
            store.splice(0, store.length, ...updated);
            syncNotificationBadges(getUnreadCount(store));
          }
        } else {
          syncNotificationBadges(lastKnownUnread || 0);
        }
      }
    }
    if (link) {
      window.location.href = link;
    }
  });

  return wrapper;
}

function renderNotificationList(listEl, emptyEl, items = []) {
  if (!listEl) return;
  listEl.innerHTML = "";
  const normalized = (Array.isArray(items) ? items : []).map(normalizeNotification);
  syncNotificationBadges(getUnreadCount(normalized));
  if (!normalized.length) {
    if (emptyEl) {
      emptyEl.style.display = "block";
      emptyEl.textContent = "You're all caught up.";
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  const panel = listEl.closest("[data-notification-panel]");
  if (panel) panel.style.display = "block";
  normalized.forEach((item) =>
    listEl.appendChild(
      buildNotificationNode(item, null, {
        store: normalized,
        onDismiss: () => {
          if (!listEl.children.length && emptyEl) {
            emptyEl.style.display = "block";
            emptyEl.textContent = "You're all caught up.";
          }
        },
      })
    )
  );
}

function syncNotificationBadges(unreadCount) {
  lastKnownUnread = Math.max(0, Number(unreadCount) || 0);
  const label = lastKnownUnread > 0 ? String(lastKnownUnread) : "";
  document.querySelectorAll("[data-notification-toggle]").forEach((toggle) => {
    if (label) {
      toggle.dataset.count = label;
    } else {
      delete toggle.dataset.count;
    }
  });
}
