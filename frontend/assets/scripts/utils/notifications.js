// Shared notification center for headers
import { secureFetch, getStoredSession } from "../auth.js";

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
    .notif-item{display:flex;align-items:flex-start;gap:12px;}
    .notif-main{display:flex;align-items:flex-start;gap:12px;flex:1;}
    .notif-avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#f2f4f8;flex-shrink:0;}
    .notif-copy{display:flex;flex-direction:column;gap:4px;flex:1;}
    .notif-dot{width:10px;height:10px;border-radius:50%;background:var(--accent,#b6a47a);margin-top:6px;opacity:0;flex-shrink:0;}
    .notif-item.unread .notif-dot{opacity:0.9;}
    .notif-dismiss{background:transparent;border:none;color:var(--muted,#7a7a7a);font-size:0.9rem;cursor:pointer;padding:6px;border-radius:8px;align-self:flex-start;flex-shrink:0;}
    .notif-dismiss:hover{background:rgba(0,0,0,0.06);color:var(--ink,#1a1a1a);}
    .notif-time{color:var(--muted,#6b7280);}
  `;
  document.head.appendChild(style);
}

function normalizeNotification(item = {}) {
  const isRead = item.isRead ?? item.read ?? false;
  return { ...item, isRead, read: isRead };
}

function isNotificationRead(item = {}) {
  return item?.isRead ?? item?.read ?? false;
}

function getUnreadCount(list = []) {
  return list.filter((item) => !isNotificationRead(item)).length;
}

function getAvatarFallback(name = "") {
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#eef1f7"/><text x="50%" y="56%" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="#5c6477">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function formatNotificationMessage(item = {}) {
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
    case "profile_approved":
      return "Profile Approved";
    case "resume_uploaded":
      return "Resume Updated";
    case "payout_released":
      return "Payout Released";
    case "case_awaiting_funding":
      return "Funding Needed";
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
      return payload.response === "accepted"
        ? `${payload.paralegalName || "Paralegal"} accepted your invitation`
        : `${payload.paralegalName || "Paralegal"} declined your invitation`;
    case "case_update":
      return payload.summary || `Case "${payload.caseTitle || "update"}" has changed.`;
    case "application_submitted":
      return `${payload.paralegalName || "A paralegal"} applied to "${payload.title || "your job"}"`;
    case "resume_uploaded":
      return "Your resume has been successfully uploaded.";
    case "profile_approved":
      return "Your profile was approved.";
    case "payout_released":
      return `Your payout is on the way${payload.amount ? ` (${payload.amount})` : ""}.`;
    case "case_awaiting_funding":
      return `${payload.caseTitle || "A case"} is awaiting funding.`;
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

function totalUnread() {
  const centerTotal = centers.reduce((sum, center) => {
    return sum + getUnreadCount(center.notifications || []);
  }, 0);
  return centerTotal || lastKnownUnread || 0;
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
  const state = {
    root,
    toggle,
    panel,
    badge,
    list,
    empty,
    markBtn,
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
  const session = getStoredSession();
  if (!session?.user) {
    lastKnownUnread = 0;
    syncNotificationBadges(0);
    renderEmpty(center, "Sign in to view notifications.");
    center.loaded = true;
    return;
  }
  center.loading = true;
  try {
    const res = await secureFetch("/api/notifications", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      noRedirect: true,
    });
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
    center.unread = 0;
  }
  if (center.empty) {
    center.empty.style.display = "block";
    center.empty.textContent = text;
  }
  if (center.list) center.list.innerHTML = "";
  updateBadge(center, 0);
  const total = totalUnread();
  lastKnownUnread = total;
  syncNotificationBadges(total);
}

function updateBadge(center, count) {
  if (!center.badge) return;
  const value = count > 9 ? "9+" : String(count || 0);
  center.badge.textContent = value;
  center.badge.classList.toggle("show", count > 0);
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
      c.unread = 0;
      updateBadge(c, 0);
      if (c !== center) {
        renderNotifications(c);
      }
    });
    renderNotifications(center);
  } catch (err) {
    console.warn("[notifications] mark read failed", err);
  }
}

async function dismissNotification(center, id) {
  if (!id) return false;
  try {
    await secureFetch(`/api/notifications/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch (err) {
    console.warn("[notifications] dismiss failed", err);
  }
  const targetId = String(id);
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
    const remaining = document.querySelectorAll("[data-notification-list] .notif-item.unread").length;
    syncNotificationBadges(remaining);
    return true;
  }
  const total = totalUnread();
  syncNotificationBadges(total);
  return true;
}

function bindGlobalDismiss() {
  if (dismissBound) return;
  dismissBound = true;
  document.addEventListener("click", (event) => {
    centers.forEach((center) => {
      if (!center.root.contains(event.target)) {
        center.panel.classList.remove("show");
      }
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      centers.forEach((center) => center.panel.classList.remove("show"));
    }
  });
}

function bindMinimalToggleHandler() {
  document.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-notification-toggle]");
    if (!toggle) return;
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
  avatar.src = normalized.actorProfileImage || getAvatarFallback(actorName);
  avatar.alt = actorName ? `${actorName}'s profile photo` : "Notification";
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
    const ok = await dismissNotification(center, normalized._id || normalized.id);
    if (!center && ok) {
      wrapper.remove();
      if (onDismiss) onDismiss();
    }
  });

  wrapper.appendChild(avatar);
  wrapper.appendChild(main);
  wrapper.appendChild(dismiss);

  const link = typeof normalized.link === "string" ? normalized.link.trim() : "";
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
        } else {
          const remaining = document.querySelectorAll("[data-notification-list] .notif-item.unread").length;
          syncNotificationBadges(remaining);
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
  lastKnownUnread = unreadCount;
  const label = unreadCount > 9 ? "9+" : unreadCount > 0 ? String(unreadCount) : "";
  document.querySelectorAll("[data-notification-toggle]").forEach((toggle) => {
    if (label) {
      toggle.dataset.count = label;
    } else {
      delete toggle.dataset.count;
    }
  });
}
