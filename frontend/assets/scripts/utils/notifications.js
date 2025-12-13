// Shared notification center for headers
import { secureFetch, getStoredSession } from "../auth.js";

export async function loadNotifications() {
  try {
    const res = await fetch("/api/notifications", { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await res.json();

    const lists = document.querySelectorAll("[data-notification-list]");
    lists.forEach((listEl) => {
      const emptyEl = listEl.parentElement?.querySelector("[data-notification-empty]") || null;
      renderNotificationList(listEl, emptyEl, items);
    });

    syncNotificationBadges(items.filter((i) => !i.read).length);
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
    case "profile_approved":
      return "Profile Approved";
    case "resume_uploaded":
      return "Resume Updated";
    case "payout_released":
      return "Payout Released";
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
    case "resume_uploaded":
      return "Your résumé has been successfully uploaded.";
    case "profile_approved":
      return "Your profile was approved.";
    case "payout_released":
      return `Your payout is on the way${payload.amount ? ` (${payload.amount})` : ""}.`;
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
  if (!id) return;
  try {
    await fetch(`/api/notifications/${id}/read`, {
      method: "POST",
      credentials: "include",
    });
  } catch (err) {
    console.warn("[notifications] mark single read failed", err);
  }
}

const centers = [];
let dismissBound = false;
let initBound = false;

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
  document.addEventListener("DOMContentLoaded", scanNotificationCenters);
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
      fetchNotifications(center);
    } else if (center.unread > 0) {
      markNotificationsRead(center);
    }
  }
}

function preload(center) {
  renderEmpty(center, "Loading…");
  fetchNotifications(center);
}

async function fetchNotifications(center) {
  if (center.loading) return;
  const session = getStoredSession();
  if (!session?.token) {
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
    center.notifications = Array.isArray(payload) ? payload : [];
    center.unread = center.notifications.filter((n) => !n.read).length;
    center.loaded = true;
    renderNotifications(center);
    syncNotificationBadges(center.unread);
  } catch (err) {
    console.warn("[notifications] load failed", err);
    renderEmpty(center, "Notifications unavailable.");
  } finally {
    center.loading = false;
  }
}

function renderNotifications(center) {
  updateBadge(center, center.unread);
  if (!center.list || !center.empty) return;
  center.list.innerHTML = "";
  if (!center.notifications.length) {
    renderEmpty(center, "You’re all caught up.");
    return;
  }
  center.empty.style.display = "none";
  center.notifications.forEach((item) => {
    const node = buildNotificationNode(item);
    center.list.appendChild(node);
  });
  syncNotificationBadges(center.unread);
}

function renderEmpty(center, text) {
  if (center.empty) {
    center.empty.style.display = "block";
    center.empty.textContent = text;
  }
  if (center.list) center.list.innerHTML = "";
  updateBadge(center, 0);
}

function updateBadge(center, count) {
  if (!center.badge) return;
  const value = count > 9 ? "9+" : String(count || 0);
  center.badge.textContent = value;
  center.badge.classList.toggle("show", count > 0);
}

async function markNotificationsRead(center) {
  if (!center.unread) return;
  try {
    await secureFetch("/api/notifications/read-all", {
      method: "POST",
      credentials: "include",
    });
    center.unread = 0;
    center.notifications = center.notifications.map((item) => ({ ...item, read: true }));
    updateBadge(center, 0);
    renderNotifications(center);
    syncNotificationBadges(0);
  } catch (err) {
    console.warn("[notifications] mark read failed", err);
  }
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

document.addEventListener("DOMContentLoaded", () => {
  loadNotifications();
  initPushNotifications();
});

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

function buildNotificationNode(item = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `notif-item ${item.read ? "read" : "unread"}`;
  const title = document.createElement("div");
  title.className = "notif-title";
  title.textContent = formatNotificationTitle(item);
  const body = document.createElement("div");
  body.className = "notif-body";
  body.textContent = formatNotificationBody(item);
  const time = document.createElement("div");
  time.className = "notif-time";
  time.textContent = formatTimeAgo(item.createdAt);
  wrapper.appendChild(title);
  wrapper.appendChild(body);
  wrapper.appendChild(time);
  if (item._id) {
    wrapper.addEventListener("click", async () => {
      if (!wrapper.classList.contains("read")) {
        await markNotificationRead(item._id);
        wrapper.classList.remove("unread");
        wrapper.classList.add("read");
        const remaining = document.querySelectorAll("[data-notification-list] .notif-item.unread").length;
        syncNotificationBadges(remaining);
      }
    });
  }
  return wrapper;
}

function renderNotificationList(listEl, emptyEl, items = []) {
  listEl.innerHTML = "";
  if (!items.length) {
    if (emptyEl) {
      emptyEl.style.display = "block";
      emptyEl.textContent = "You’re all caught up.";
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  items.forEach((item) => listEl.appendChild(buildNotificationNode(item)));
}

function syncNotificationBadges(unreadCount) {
  const label = unreadCount > 9 ? "9+" : unreadCount > 0 ? String(unreadCount) : "";
  document.querySelectorAll("[data-notification-toggle]").forEach((toggle) => {
    if (label) {
      toggle.dataset.count = label;
    } else {
      delete toggle.dataset.count;
    }
  });
}
