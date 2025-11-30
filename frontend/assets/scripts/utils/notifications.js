// Shared notification center for headers
import { secureFetch, getStoredSession } from "../auth.js";

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
initNotificationCenters();
// Expose for late-mounted clusters (e.g., injected shells)
if (typeof window !== "undefined") {
  window.initNotificationCenters = scanNotificationCenters;
  window.scanNotificationCenters = scanNotificationCenters;
  window.refreshNotificationCenters = refreshNotificationCenters;
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
    const res = await secureFetch("/api/users/me/notifications", {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    center.notifications = Array.isArray(payload.items) ? payload.items : [];
    center.unread = Number(payload.unread) || 0;
    center.loaded = true;
    renderNotifications(center);
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
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = item.title || "Notification";
    li.appendChild(title);
    if (item.body) {
      const body = document.createElement("p");
      body.textContent = item.body;
      li.appendChild(body);
    }
    const meta = document.createElement("span");
    meta.textContent = formatRelativeTime(item.createdAt);
    li.appendChild(meta);
    center.list.appendChild(li);
  });
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
    await secureFetch("/api/users/me/notifications/read", { method: "POST" });
    center.unread = 0;
    updateBadge(center, 0);
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
