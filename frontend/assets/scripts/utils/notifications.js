// Shared notification center for headers
import { secureFetch } from "../auth.js";
import { closeSupportDrawer, scanSupportLaunchers } from "./support-drawer.js";
import { confirmAction } from "./dialogs.js";

const MAX_VISIBLE_NOTIFICATION_CARDS = 3;
const NOTIFICATION_POLL_INTERVAL_MS = 10000;
const NOTIF_FADE_ENHANCE_KEY = "notifFadeEnhanced";
const NOTIF_FADE_ITEM_KEY = "notifFadeItemBound";
let lastKnownUnread = 0;
let viewportResizeBound = false;
let notificationEventSource = null;
let notificationStreamActive = false;
let notificationRefreshTimer = null;
let notificationReconnectTimer = null;
let notificationPollTimer = null;
let lastNotificationEventAt = 0;

function emitNotificationRefresh(payload = {}) {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  const now = Date.now();
  if (now - lastNotificationEventAt < 300) return;
  lastNotificationEventAt = now;
  window.dispatchEvent(new CustomEvent("lpc:notifications-refreshed", { detail: payload }));
}

function summarizeNotificationTypes(items = []) {
  const types = new Set();
  (items || []).forEach((item) => {
    const type = item?.type || item?.payload?.type;
    if (type) types.add(String(type));
  });
  return Array.from(types);
}

function ensureNotificationStyles() {
  return;
}

function syncNotificationListViewport(listEl) {
  if (!listEl || typeof window === "undefined") return;
  const cards = listEl.querySelectorAll(".notif-item, .notif-card");
  if (!cards.length) {
    listEl.style.removeProperty("--notif-three-card-max-height");
    delete listEl.dataset.notifThreeCardHeight;
    return;
  }
  const targetIndex = Math.min(MAX_VISIBLE_NOTIFICATION_CARDS, cards.length) - 1;
  const targetCard = cards[targetIndex];
  if (!targetCard) {
    listEl.style.removeProperty("--notif-three-card-max-height");
    return;
  }
  const listStyles = window.getComputedStyle(listEl);
  const gap = parseFloat(listStyles.rowGap || listStyles.gap || "0") || 0;
  const paddingTop = parseFloat(listStyles.paddingTop || "0") || 0;
  const paddingBottom = parseFloat(listStyles.paddingBottom || "0") || 0;
  let measuredHeight = paddingTop + paddingBottom;
  const visibleCards = Math.min(MAX_VISIBLE_NOTIFICATION_CARDS, cards.length);
  for (let index = 0; index < visibleCards; index += 1) {
    measuredHeight += cards[index].offsetHeight;
  }
  if (visibleCards > 1) measuredHeight += gap * (visibleCards - 1);
  measuredHeight = Math.round(measuredHeight);
  if (measuredHeight > 0) {
    const px = `${measuredHeight}px`;
    listEl.style.setProperty("--notif-three-card-max-height", px);
    listEl.dataset.notifThreeCardHeight = px;
    return;
  }
  if (listEl.dataset.notifThreeCardHeight) {
    listEl.style.setProperty("--notif-three-card-max-height", listEl.dataset.notifThreeCardHeight);
    return;
  }
  listEl.style.removeProperty("--notif-three-card-max-height");
}

function scheduleNotificationListViewportSync(listEl) {
  if (!listEl || typeof window === "undefined") return;
  window.requestAnimationFrame(() => syncNotificationListViewport(listEl));
}

function syncAllNotificationListViewports() {
  document.querySelectorAll("[data-notification-list]").forEach((listEl) => {
    syncNotificationListViewport(listEl);
  });
}

function bindNotificationViewportResize() {
  if (viewportResizeBound || typeof window === "undefined") return;
  viewportResizeBound = true;
  window.addEventListener("resize", () => {
    window.requestAnimationFrame(syncAllNotificationListViewports);
  });
}

function enhanceNotificationListFade(list) {
  if (!list || typeof window === "undefined") return;
  if (list.dataset[NOTIF_FADE_ENHANCE_KEY] === "true") return;
  if (list.dataset.sharedNotifEnhanced === "true") return;
  if (!("IntersectionObserver" in window)) return;
  list.dataset[NOTIF_FADE_ENHANCE_KEY] = "true";

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const item = entry.target;
        if (!(item instanceof HTMLElement)) return;
        if (!entry.isIntersecting) return;
        item.classList.add("notif-fade-in");
        observer.unobserve(item);
      });
    },
    { root: list, threshold: 0.2, rootMargin: "0px 0px -4% 0px" }
  );

  const bindItems = () => {
    const items = list.querySelectorAll(".notif-item");
    items.forEach((item) => {
      if (!(item instanceof HTMLElement)) return;
      if (item.dataset[NOTIF_FADE_ITEM_KEY] === "true") return;
      item.dataset[NOTIF_FADE_ITEM_KEY] = "true";
      item.classList.add("notif-fade-ready");
      observer.observe(item);
    });
  };

  const itemObserver = new MutationObserver(() => bindItems());
  itemObserver.observe(list, { childList: true, subtree: true });
  bindItems();
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

function getAvatarFallback() {
  return "/assets/avatar-placeholder.svg";
}




const ADMIN_NOTIFICATION_IMAGE = "/hero-mountain.jpg";
const ADMIN_TITLE_HINT = "welcome to let's-paraconnect";
const PLATFORM_NOTIFICATION_TYPES = new Set([
  "paralegal_welcome",
  "profile_approved",
  "profile_photo_approved",
  "profile_photo_rejected",
]);

function isAdminNotification(item = {}) {
  const actorName = String(item.actorFirstName || "").trim().toLowerCase();
  const payloadRole = String(item.payload?.actorRole || item.payload?.fromRole || "").trim().toLowerCase();
  const fromName = String(item.payload?.fromName || "").trim().toLowerCase();
  const type = String(item.type || "").trim().toLowerCase();
  if (
    actorName === "admin" ||
    payloadRole === "admin" ||
    payloadRole === "platform" ||
    payloadRole === "system" ||
    fromName === "admin"
  ) {
    return true;
  }
  if (PLATFORM_NOTIFICATION_TYPES.has(type)) return true;
  const message = String(item.message || item.payload?.message || "").trim().toLowerCase();
  const title = String(item.payload?.title || "").trim().toLowerCase();
  if (message.includes(ADMIN_TITLE_HINT) || title.includes(ADMIN_TITLE_HINT)) return true;
  return false;
}

function getNotificationAvatar(item = {}, actorName = "") {
  if (isAdminNotification(item)) return ADMIN_NOTIFICATION_IMAGE;
  if (item.actorProfileImage) return item.actorProfileImage;
  const hasActor =
    Boolean(actorName) ||
    Boolean(item.actorUserId) ||
    Boolean(item.payload?.actorFirstName) ||
    Boolean(item.payload?.fromName) ||
    Boolean(item.payload?.actorName) ||
    Boolean(item.payload?.paralegalName);
  if (!hasActor) return ADMIN_NOTIFICATION_IMAGE;
  return getAvatarFallback();
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
  bindNotificationViewportResize();
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
    syncAllNotificationListViewports();

    const unreadCount = getUnreadCount(items);
    lastKnownUnread = unreadCount;
    syncNotificationBadges(unreadCount);
    emitNotificationRefresh({
      source: "list",
      unread: unreadCount,
      totalUnread: unreadCount,
      types: summarizeNotificationTypes(items),
    });
  } catch (err) {
    console.warn("[notifications] loadNotifications failed", err);
  }
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
    panel.style.removeProperty("display");
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
  bindNotificationViewportResize();
  document.querySelectorAll("[data-notification-center]").forEach((root) => {
    if (root.dataset.boundNotificationCenter === "true") return;
    const center = createCenter(root);
    if (center) {
      centers.push(center);
      preload(center);
    }
  });
  scanSupportLaunchers();
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
}

function refreshNotificationCenters() {
  centers.forEach((center) => {
    if (center.loading) return;
    center.loaded = false;
    fetchNotifications(center);
  });
}

function scheduleNotificationRefresh() {
  if (notificationRefreshTimer) return;
  notificationRefreshTimer = window.setTimeout(() => {
    notificationRefreshTimer = null;
    if (centers.length) {
      refreshNotificationCenters();
    } else {
      loadNotifications();
    }
  }, 200);
}

function stopNotificationPolling() {
  if (!notificationPollTimer) return;
  window.clearInterval(notificationPollTimer);
  notificationPollTimer = null;
}

function startNotificationPolling() {
  if (notificationPollTimer || document.hidden) return;
  scheduleNotificationRefresh();
  notificationPollTimer = window.setInterval(() => {
    if (!document.hidden) scheduleNotificationRefresh();
  }, NOTIFICATION_POLL_INTERVAL_MS);
}

function stopNotificationStream() {
  if (notificationEventSource) {
    notificationEventSource.close();
    notificationEventSource = null;
  }
  notificationStreamActive = false;
  if (notificationReconnectTimer) {
    clearTimeout(notificationReconnectTimer);
    notificationReconnectTimer = null;
  }
}

function startNotificationStream() {
  if (notificationEventSource || typeof EventSource === "undefined") return false;
  const source = new EventSource("/api/notifications/stream");
  notificationEventSource = source;

  const onError = () => {
    notificationStreamActive = false;
    stopNotificationStream();
    if (!document.hidden) {
      startNotificationPolling();
      notificationReconnectTimer = window.setTimeout(startNotificationStream, 5000);
    }
  };

  source.addEventListener("open", () => {
    notificationStreamActive = true;
    stopNotificationPolling();
  });
  source.addEventListener("error", onError);
  source.addEventListener("notifications", () => scheduleNotificationRefresh());
  source.addEventListener("ping", () => {});

  return true;
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
  if (markBtn) markBtn.textContent = "Mark all as read";
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
        titleEl.textContent = header.textContent.trim() || "Notifications";
        header.textContent = "";
        header.appendChild(titleEl);
      } else if (!titleEl.textContent.trim()) {
        titleEl.textContent = "Notifications";
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

  enhanceNotificationListFade(list);

  if (!root.dataset.boundNotificationCenter) {
    root.dataset.boundNotificationCenter = "true";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      togglePanel(state);
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePanel(state);
      }
    });
    markBtn?.addEventListener("click", () => markNotificationsRead(state));
    clearBtn?.addEventListener("click", () => clearNotifications(state));
  }
  return state;
}

function togglePanel(center) {
  if (!center?.panel) return;
  if (center.panel.dataset.toggleLock === "true") return;
  center.panel.dataset.toggleLock = "true";
  window.setTimeout(() => {
    if (center.panel) center.panel.dataset.toggleLock = "";
  }, 120);
  center.panel.style.removeProperty("display");
  const willShow = !center.panel.classList.contains("show");
  document.querySelectorAll("[data-notification-panel].show").forEach((panel) => {
    if (panel !== center.panel) panel.classList.remove("show");
  });
  if (!willShow) {
    center.panel.classList.remove("show");
    center.panel.classList.add("hidden");
    center.panel.dataset.pendingShow = "";
    return;
  }
  closeSupportDrawer({ restoreFocus: false });
  if (!center.loaded) {
    renderEmpty(center, "Loading...");
    center.panel.dataset.pendingShow = "";
    showPanel(center);
    fetchNotifications(center);
    return;
  }
  showPanel(center);
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
    const items = Array.isArray(payload) ? payload : [];
    const normalized = items.map(normalizeNotification);
    center.notifications = normalized;
    center.unread = getUnreadCount(center.notifications);
    center.loaded = true;
    renderNotifications(center);
    emitNotificationRefresh({
      source: "center",
      unread: center.unread,
      totalUnread: totalUnread(),
      types: summarizeNotificationTypes(center.notifications),
    });
    const total = totalUnread();
    lastKnownUnread = total;
    syncNotificationBadges(total);
    if (options.openAfterLoad && center.panel?.dataset?.pendingShow === "true") {
      center.panel.dataset.pendingShow = "";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      showPanel(center);
    }
  } catch (err) {
    console.warn("[notifications] load failed", err);
    renderEmpty(center, "Notifications unavailable.");
  } finally {
    center.loading = false;
    if (center.panel?.dataset?.pendingShow === "true") {
      center.panel.dataset.pendingShow = "";
      requestAnimationFrame(() => requestAnimationFrame(() => showPanel(center)));
    }
  }
}

function showPanel(center) {
  if (!center?.panel) return;
  document.querySelectorAll("[data-notification-panel].show").forEach((panel) => {
    if (panel !== center.panel) {
      panel.classList.remove("show");
      panel.classList.add("hidden");
      panel.dataset.pendingShow = "";
      panel.style.removeProperty("display");
    }
  });
  scheduleNotificationListViewportSync(center.list);
  center.panel.style.removeProperty("display");
  center.panel.classList.add("show");
  center.panel.classList.remove("hidden");
}

function renderNotifications(center) {
  center.unread = getUnreadCount(center.notifications || []);
  updateBadge(center, center.unread);
  if (center.clearBtn) center.clearBtn.hidden = center.notifications.length === 0;
  if (center.markBtn) center.markBtn.hidden = center.unread === 0;
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
    try {
      const node = buildNotificationNode(item, center);
      center.list.appendChild(node);
    } catch (err) {
      console.warn("[notifications] render item failed", item?.type, err);
    }
  });
  if (!center.list.children.length) {
    renderEmpty(center, "You're all caught up.");
    return;
  }
  scheduleNotificationListViewportSync(center.list);
  const total = totalUnread();
  lastKnownUnread = total;
  syncNotificationBadges(total);
}

function renderEmpty(center, text) {
  if (center) {
    center.unread = getUnreadCount(center.notifications || []);
    if (center.clearBtn) center.clearBtn.hidden = true;
    if (center.markBtn) center.markBtn.hidden = true;
  }
  if (center.empty) {
    center.empty.style.display = "block";
    center.empty.textContent = text;
  }
  if (center.list) {
    center.list.innerHTML = "";
    center.list.style.removeProperty("--notif-three-card-max-height");
  }
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
  const confirmed = await confirmAction("This removes every notification from your notification center.", {
    title: "Clear all notifications?",
    confirmLabel: "Clear all",
    tone: "danger",
  });
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

async function dismissNotification(id, options = {}) {
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
    const root = toggle?.closest("[data-notification-center]");
    if (root?.dataset?.boundNotificationCenter === "true") return;
    if (!toggle) {
      const panel = event.target.closest("[data-notification-panel]");
      if (panel) return;
      closeAllNotificationPanels();
      return;
    }
    const panel =
      root.querySelector("[data-notification-panel]") ||
      toggle.parentElement?.querySelector("[data-notification-panel]");
    if (!panel) return;
    const willShow = !panel.classList.contains("show");
    if (willShow) {
      closeSupportDrawer({ restoreFocus: false });
    }
    document.querySelectorAll("[data-notification-panel]").forEach((node) => {
      if (node !== panel) {
        node.classList.remove("show");
        node.classList.add("hidden");
      }
    });
    panel.classList.toggle("show", willShow);
    panel.classList.toggle("hidden", !willShow);
    if (willShow) {
      const list = panel.querySelector("[data-notification-list]");
      scheduleNotificationListViewportSync(list);
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







function resolveNotificationLink(item = {}) {
  const raw = String(item?.action?.href || "").trim();
  if (!raw || raw.startsWith("//") || raw.includes("\\")) return "";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "";
    const allowedPage = new Set([
      "/case-detail.html",
      "/profile-paralegal.html",
      "/profile-settings.html",
      "/dashboard-attorney.html",
      "/dashboard-paralegal.html",
    ]).has(url.pathname);
    if (!allowedPage) return "";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}

if (!notificationsOptOut) {
  let notificationsBooted = false;
  const bootNotifications = () => {
    if (notificationsBooted) return;
    notificationsBooted = true;
    ensureNotificationStyles();
    scanNotificationCenters();
    if (!centers.length) {
      loadNotifications();
    }
    bindMinimalToggleHandler();
    if (!startNotificationStream()) startNotificationPolling();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        stopNotificationPolling();
        return;
      }
      if (!notificationStreamActive) {
        startNotificationPolling();
        startNotificationStream();
      }
    });
    window.addEventListener("beforeunload", () => {
      stopNotificationStream();
      stopNotificationPolling();
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootNotifications);
  } else {
    bootNotifications();
  }
}

function buildNotificationNode(item = {}, center = null, options = {}) {
  const normalized = normalizeNotification(item);
  const onDismiss = typeof options.onDismiss === "function" ? options.onDismiss : null;
  const wrapper = document.createElement("div");
  wrapper.className = `notif-item ${normalized.isRead ? "read" : "unread"}`;
  wrapper.dataset.id = normalized.id || normalized._id || "";
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
  const link = resolveNotificationLink(normalized);
  const actionLabel = link ? String(normalized?.action?.label || "View Matter") : "";
  if (actionLabel) {
    const action = document.createElement("span");
    action.className = "notif-primary-action";
    action.textContent = actionLabel;
    copy.appendChild(action);
  }

  const actorName = String(
    normalized.actorFirstName ||
      normalized.payload?.actorFirstName ||
      normalized.payload?.fromName ||
      normalized.payload?.actorName ||
      normalized.payload?.paralegalName ||
      ""
  ).trim();
  const avatar = document.createElement("img");
  avatar.className = "notif-avatar";
  avatar.loading = "lazy";
  avatar.alt = actorName ? `${actorName} profile photo` : "Notification profile photo";
  avatar.src = getNotificationAvatar(normalized, actorName);
  avatar.addEventListener(
    "error",
    () => {
      avatar.src = getAvatarFallback();
    },
    { once: true }
  );

  const main = document.createElement("div");
  main.className = "notif-main";
  main.appendChild(avatar);
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
    const ok = await dismissNotification(normalized._id || normalized.id, options);
    if (!center && ok) {
      wrapper.remove();
      if (onDismiss) onDismiss();
    }
  });

  wrapper.appendChild(main);
  wrapper.appendChild(dismiss);
  if (link) {
    wrapper.setAttribute("role", "link");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("aria-label", `${formatNotificationMessage(normalized)}. ${actionLabel}`);
  }

  const activateNotification = async () => {
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
      closeAllNotificationPanels();
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (link === current) return;
      window.location.href = link;
    }
  };
  wrapper.addEventListener("click", activateNotification);
  wrapper.addEventListener("keydown", (event) => {
    if (!link || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    void activateNotification();
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
    listEl.style.removeProperty("--notif-three-card-max-height");
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  const panel = listEl.closest("[data-notification-panel]");
  if (panel) panel.style.display = "block";
  normalized.forEach((item) => {
    try {
      listEl.appendChild(
        buildNotificationNode(item, null, {
          store: normalized,
          onDismiss: () => {
            if (!listEl.children.length && emptyEl) {
              emptyEl.style.display = "block";
              emptyEl.textContent = "You're all caught up.";
            }
            scheduleNotificationListViewportSync(listEl);
          },
        })
      );
    } catch (err) {
      console.warn("[notifications] list item render failed", item?.type, err);
    }
  });
  if (!listEl.children.length) {
    if (emptyEl) {
      emptyEl.style.display = "block";
      emptyEl.textContent = "You're all caught up.";
    }
    listEl.style.removeProperty("--notif-three-card-max-height");
    return;
  }
  scheduleNotificationListViewportSync(listEl);
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
