// Shared notification center for headers
import { secureFetch } from "../auth.js";
import { closeSupportDrawer, scanSupportLaunchers } from "./support-drawer.js";
import { confirmAction } from "./dialogs.js";

const MAX_VISIBLE_NOTIFICATION_CARDS = 3;
const NOTIFICATION_POLL_INTERVAL_MS = 10000;
const NOTIF_FADE_ENHANCE_KEY = "notifFadeEnhanced";
const NOTIF_FADE_ITEM_KEY = "notifFadeItemBound";
let lastKnownUnread = null;
let notificationCountSequence = 0;
let notificationMutationVersion = 0;
let viewportResizeBound = false;
let notificationEventSource = null;
let notificationStreamActive = false;
let notificationRefreshTimer = null;
let notificationReconnectTimer = null;
let notificationPollTimer = null;
let lastNotificationEventAt = 0;
let notificationPageActive = true;
const notificationReads = new Set();

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

function currentUnreadCount() {
  return lastKnownUnread;
}

async function readAuthoritativeUnread(signal) {
  const sequence = ++notificationCountSequence;
  const version = notificationMutationVersion;
  try {
    const response = await secureFetch("/api/notifications/unread-count", {
      method: "GET", credentials: "include", noRedirect: true, signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Number.isSafeInteger(payload?.count) || payload.count < 0) throw new Error("Invalid unread count");
    if (signal?.aborted || version !== notificationMutationVersion) throw new DOMException("Canceled", "AbortError");
    if (sequence === notificationCountSequence) syncNotificationBadges(payload.count);
    return currentUnreadCount();
  } catch (error) {
    if (!signal?.aborted && version === notificationMutationVersion && sequence === notificationCountSequence) {
      syncNotificationBadges(null);
    }
    throw error;
  }
}

function notificationFeedback(message = "") {
  document.querySelectorAll("[data-notification-panel]").forEach(panel => {
    let feedback = panel.querySelector("[data-notification-feedback]");
    if (!feedback) {
      feedback = document.createElement("p");
      feedback.dataset.notificationFeedback = "";
      feedback.className = "notif-feedback";
      feedback.setAttribute("role", "status");
      panel.appendChild(feedback);
    }
    feedback.textContent = message;
    feedback.hidden = !message;
  });
}

async function writeNotification(path, method) {
  notificationMutationVersion += 1;
  notificationReads.forEach(controller => controller.abort());
  notificationFeedback();
  try {
    const response = await secureFetch(path, { method, credentials: "include" });
    if (!response.ok || (await response.json())?.success !== true) throw new Error("Unconfirmed notification update");
    // A confirmed write remains confirmed if the subsequent count is unavailable.
    try { await readAuthoritativeUnread(); }
    catch (error) { console.warn("[notifications] unread count unavailable after update", error); }
  } catch (error) {
    notificationFeedback("That update could not be confirmed. Please try again.");
    scheduleNotificationRefresh();
    throw error;
  }
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
  if (!notificationPageActive) return;
  const controller = new AbortController();
  notificationReads.add(controller);
  bindNotificationViewportResize();
  try {
    const [res] = await Promise.all([
      secureFetch("/api/notifications", { credentials: "include", signal: controller.signal, noRedirect: true }),
      readAuthoritativeUnread(controller.signal),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (controller.signal.aborted || !notificationPageActive) return;
    if (!Array.isArray(payload)) throw new Error("Invalid notification list");
    const items = payload.map(normalizeNotification);

    const lists = document.querySelectorAll("[data-notification-list]");
    lists.forEach((listEl) => {
      const emptyEl = listEl.parentElement?.querySelector("[data-notification-empty]") || null;
      renderNotificationList(listEl, emptyEl, items);
    });
    syncAllNotificationListViewports();

    const unreadCount = currentUnreadCount();
    lastKnownUnread = unreadCount;
    syncNotificationBadges(unreadCount);
    emitNotificationRefresh({
      source: "list",
      unread: unreadCount,
      totalUnread: unreadCount,
      types: summarizeNotificationTypes(items),
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    controller.abort();
    document.querySelectorAll("[data-notification-list]").forEach(list => {
      list.replaceChildren();
      const empty = list.parentElement?.querySelector("[data-notification-empty]");
      if (empty) { empty.style.display = "block"; empty.textContent = "Notifications unavailable."; }
    });
    console.warn("[notifications] loadNotifications failed", err);
  } finally {
    notificationReads.delete(controller);
  }
}





async function markNotificationRead(id) {
  if (!id) return false;
  try {
    await writeNotification(`/api/notifications/${encodeURIComponent(id)}/read`, "POST");
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
  return currentUnreadCount();
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
  if (!notificationPageActive) return;
  centers.forEach((center) => {
    if (center.loading) return;
    center.loaded = false;
    fetchNotifications(center);
  });
}

function scheduleNotificationRefresh() {
  if (!notificationPageActive || notificationRefreshTimer) return;
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
  if (!notificationPageActive || notificationPollTimer || document.hidden) return;
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
  if (!notificationPageActive || notificationEventSource || typeof EventSource === "undefined") return false;
  const source = new EventSource("/api/notifications/stream");
  notificationEventSource = source;

  const onError = () => {
    if (notificationEventSource !== source || !notificationPageActive) return;
    notificationStreamActive = false;
    stopNotificationStream();
    if (!document.hidden) {
      startNotificationPolling();
      notificationReconnectTimer = window.setTimeout(startNotificationStream, 5000);
    }
  };

  source.addEventListener("open", () => {
    if (notificationEventSource !== source || !notificationPageActive) return;
    notificationStreamActive = true;
    stopNotificationPolling();
  });
  source.addEventListener("error", onError);
  source.addEventListener("notifications", () => {
    if (notificationEventSource === source) scheduleNotificationRefresh();
  });
  source.addEventListener("ping", () => {});

  return true;
}

function stopNotificationActivity() {
  notificationPageActive = false;
  if (notificationRefreshTimer) window.clearTimeout(notificationRefreshTimer);
  notificationRefreshTimer = null;
  stopNotificationStream();
  stopNotificationPolling();
  for (const controller of notificationReads) controller.abort();
  notificationReads.clear();
}

function resumeNotificationActivity() {
  if (notificationPageActive || document.hidden) return;
  notificationPageActive = true;
  scheduleNotificationRefresh();
  if (!startNotificationStream()) startNotificationPolling();
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
  if (clearBtn) clearBtn.classList.add("notif-clear");
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
  resumeNotificationActivity();
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
  if (!notificationPageActive || center.loading) return;
  center.loading = true;
  const controller = new AbortController();
  notificationReads.add(controller);
  try {
    const [res] = await Promise.all([
      secureFetch("/api/notifications", {
        method: "GET", headers: { Accept: "application/json" },
        credentials: "include", noRedirect: true, signal: controller.signal,
      }),
      readAuthoritativeUnread(controller.signal),
    ]);
    if (controller.signal.aborted || !notificationPageActive) return;
    if (res.status === 401 || res.status === 403) {
      lastKnownUnread = 0;
      syncNotificationBadges(0);
      renderEmpty(center, "Sign in to view notifications.");
      center.loaded = true;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (controller.signal.aborted || !notificationPageActive) return;
    if (!Array.isArray(payload)) throw new Error("Invalid notification list");
    const items = payload;
    const normalized = items.map(normalizeNotification);
    center.notifications = normalized;
    center.unread = currentUnreadCount();
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
      if (!controller.signal.aborted && notificationPageActive) showPanel(center);
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    controller.abort();
    console.warn("[notifications] load failed", err);
    renderEmpty(center, "Notifications unavailable.");
  } finally {
    notificationReads.delete(controller);
    center.loading = false;
    if (!controller.signal.aborted && notificationPageActive && center.panel?.dataset?.pendingShow === "true") {
      center.panel.dataset.pendingShow = "";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!controller.signal.aborted && notificationPageActive) showPanel(center);
      }));
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
  center.unread = currentUnreadCount();
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
    center.unread = currentUnreadCount();
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
  updateBadge(center, currentUnreadCount());
  syncNotificationBadges(totalUnread());
}

function updateBadge(center, count) {
  if (!center.badge) return;
  const known = Number.isSafeInteger(count) && count >= 0;
  center.badge.textContent = known ? String(count) : "!";
  center.badge.classList.toggle("show", !known || count > 0);
  center.toggle.setAttribute("aria-label", known
    ? count > 0 ? `View notifications, ${count} unread` : "View notifications"
    : "View notifications, unread count unavailable");
}

async function markNotificationsRead(center) {
  const hasUnread = currentUnreadCount() > 0;
  if (!hasUnread) return;
  try {
    await writeNotification("/api/notifications/read-all", "POST");
    centers.forEach((c) => {
      c.notifications = (c.notifications || []).map((item) => ({ ...item, read: true, isRead: true }));
      c.unread = currentUnreadCount();
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
  // Safari does not focus a button on pointer activation. Give the dialog an
  // explicit return target for both pointer and keyboard users.
  center.clearBtn?.focus();
  const confirmed = await confirmAction("This removes every notification from your notification center.", {
    title: "Clear all notifications?",
    confirmLabel: "Clear all",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await writeNotification("/api/notifications", "DELETE");
    const restoreToggleFocus = document.activeElement === center.clearBtn;
    centers.forEach((c) => {
      c.notifications = [];
      c.unread = currentUnreadCount();
      renderEmpty(c, "You're all caught up.");
    });
    syncNotificationBadges(totalUnread());
    if (restoreToggleFocus) center.toggle?.focus();
  } catch (err) {
    console.warn("[notifications] clear all failed", err);
  }
}

async function dismissNotification(id, options = {}) {
  if (!id) return false;
  const store = Array.isArray(options.store) ? options.store : null;
  try {
    await writeNotification(`/api/notifications/${encodeURIComponent(id)}`, "DELETE");
  } catch (err) {
    console.warn("[notifications] dismiss failed", err);
    return false;
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
      c.unread = currentUnreadCount();
      updateBadge(c, c.unread);
      renderNotifications(c);
    }
  });
  if (!centers.length) {
    if (store) {
      syncNotificationBadges(currentUnreadCount());
    } else {
      syncNotificationBadges(lastKnownUnread);
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
    if (target?.closest?.("[data-notification-panel], [data-notification-toggle], .notification-dropdown, .lpc-dialog")) {
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
    if (event.key === "Escape" && !event.defaultPrevented && !event.target?.closest?.(".lpc-dialog")) {
      closeAllNotificationPanels();
    }
  });
}

function bindMinimalToggleHandler() {
  document.addEventListener("click", (event) => {
    // A confirmation dialog owns its interaction; keep its originating panel
    // available for returned focus and any failed-write feedback.
    if (event.target?.closest?.(".lpc-dialog")) return;
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
      root?.querySelector("[data-notification-panel]") ||
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
    window.addEventListener("beforeunload", stopNotificationActivity);
    window.addEventListener("pagehide", stopNotificationActivity);
    window.addEventListener("pageshow", resumeNotificationActivity);
    // A canceled departure leaves this same document active. Resume when the
    // user returns to it, as well as after a browser back/forward restoration.
    for (const type of ["focus", "pointerdown", "keydown"]) {
      window.addEventListener(type, event => { if (event.isTrusted) resumeNotificationActivity(); });
    }
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

  const main = document.createElement(link ? "a" : "div");
  main.className = "notif-main";
  if (link) {
    main.href = link;
    main.setAttribute("aria-label", `${formatNotificationMessage(normalized)}. ${actionLabel}`);
  }
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
              c.unread = currentUnreadCount();
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
            syncNotificationBadges(currentUnreadCount());
          }
        } else {
          syncNotificationBadges(lastKnownUnread);
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
  main.addEventListener("click", (event) => {
    // Keep the destination and dismissal as separate controls. Native modified
    // link clicks retain the browser's open-in-new-tab behavior.
    if (link && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
    if (link) event.preventDefault();
    void activateNotification();
  });

  return wrapper;
}

function renderNotificationList(listEl, emptyEl, items = []) {
  if (!listEl) return;
  listEl.innerHTML = "";
  const normalized = (Array.isArray(items) ? items : []).map(normalizeNotification);
  syncNotificationBadges(currentUnreadCount());
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
  lastKnownUnread = Number.isSafeInteger(unreadCount) && unreadCount >= 0 ? unreadCount : null;
  const label = lastKnownUnread === null ? "!" : lastKnownUnread > 0 ? String(lastKnownUnread) : "";
  centers.forEach(center => {
    center.unread = lastKnownUnread;
    updateBadge(center, lastKnownUnread);
    if (center.markBtn) center.markBtn.hidden = !(lastKnownUnread > 0);
  });
  document.querySelectorAll("[data-notification-toggle]").forEach((toggle) => {
    toggle.setAttribute("aria-label", lastKnownUnread === null
      ? "View notifications, unread count unavailable"
      : lastKnownUnread > 0 ? `View notifications, ${lastKnownUnread} unread` : "View notifications");
    const badge = toggle.querySelector("[data-notification-badge]");
    if (badge) {
      badge.textContent = lastKnownUnread === null ? "!" : String(lastKnownUnread);
      badge.classList.toggle("show", lastKnownUnread === null || lastKnownUnread > 0);
    }
    if (label) {
      toggle.dataset.count = label;
    } else {
      delete toggle.dataset.count;
    }
  });
}
