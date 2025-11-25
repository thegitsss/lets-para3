(() => {
  const API_BASE = "/api";
  const toastHelper = window.toastUtils;
  const toastTarget = "toastBanner";
  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  const els = {};
  let currentUser = null;
  let pendingAvatarURL = "";
  let uploadingAvatar = false;
  let notificationPanelOpen = false;

  document.addEventListener("DOMContentLoaded", () => {
    init();
  });

  async function init() {
    try {
      if (window.checkSession) {
        await window.checkSession("attorney");
      }
    } catch (err) {
      console.warn("[settings] session invalid", err);
      return;
    }

    cacheElements();
    bindNavigation();
    bindProfileForm();
    bindPasswordForm();
    bindPreferencesForm();
    bindDangerZone();
    bindNotifications();

    loadUser();
    loadNotifications();
  }

  function cacheElements() {
    els.profileForm = document.getElementById("profileForm");
    els.passwordForm = document.getElementById("passwordForm");
    els.preferencesForm = document.getElementById("preferencesForm");
    els.avatarInput = document.getElementById("avatarInput");
    els.triggerAvatarUpload = document.getElementById("triggerAvatarUpload");
    els.avatarFrame = document.getElementById("avatarFrame");
    els.avatarPreview = document.getElementById("avatarPreview");
    els.avatarInitials = document.getElementById("avatarInitials");
    els.uploadStatus = document.getElementById("uploadStatus");
    els.profileSaveBtn = document.getElementById("profileSaveBtn");
    els.passwordSaveBtn = document.getElementById("passwordSaveBtn");
    els.preferencesSaveBtn = document.getElementById("preferencesSaveBtn");

    els.firstName = document.getElementById("firstName");
    els.lastName = document.getElementById("lastName");
    els.email = document.getElementById("email");
    els.phone = document.getElementById("phone");
    els.lawFirm = document.getElementById("lawFirm");
    els.bio = document.getElementById("bio");

    els.prefEmail = document.getElementById("prefEmail");
    els.prefCase = document.getElementById("prefCaseUpdates");
    els.prefMessages = document.getElementById("prefMessages");
    els.prefTasks = document.getElementById("prefTasks");

    els.deleteBtn = document.getElementById("deleteAccountBtn");
    els.deleteModal = document.getElementById("deleteModal");
    els.cancelDelete = document.getElementById("cancelDeleteBtn");
    els.confirmDelete = document.getElementById("confirmDeleteBtn");

    els.notificationToggle = document.getElementById("notificationToggle");
    els.notificationPanel = document.getElementById("notificationsPanel");
    els.notificationBadge = document.getElementById("notificationBadge");
    els.notificationList = document.getElementById("notificationList");

    els.headerAvatar = document.getElementById("headerAvatar");
    els.headerName = document.getElementById("headerName");
    els.headerRole = document.getElementById("headerRole");
  }

  function bindNavigation() {
    const navButtons = Array.from(document.querySelectorAll(".settings-nav button"));
    const panels = Array.from(document.querySelectorAll(".settings-panel"));
    if (!navButtons.length || !panels.length) return;

    navButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.target;
        if (!targetId) return;
        navButtons.forEach((node) => node.classList.remove("active"));
        btn.classList.add("active");
        panels.forEach((panel) => {
          panel.classList.toggle("active", panel.id === targetId);
        });
      });
    });
  }

  function bindProfileForm() {
    if (els.triggerAvatarUpload && els.avatarInput) {
      els.triggerAvatarUpload.addEventListener("click", () => els.avatarInput.click());
      els.avatarInput.addEventListener("change", (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) {
          handleAvatarUpload(file);
        }
        event.target.value = "";
      });
    }

    els.profileForm &&
      els.profileForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!els.profileSaveBtn) return;
        const payload = buildProfilePayload();
        setButtonBusy(els.profileSaveBtn, true, "Saving…");
        try {
          const updated = await patchMe(payload);
          currentUser = updated;
          pendingAvatarURL = "";
          hydrateProfileForm(updated);
          showToast("Profile updated.");
        } catch (err) {
          console.error(err);
          showToast(err.message || "Unable to save profile", "err");
        } finally {
          setButtonBusy(els.profileSaveBtn, false);
        }
      });
  }

  function bindPasswordForm() {
    if (!els.passwordForm) return;
    els.passwordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!els.passwordSaveBtn) return;
      const currentPassword = (document.getElementById("currentPassword")?.value || "").trim();
      const newPassword = (document.getElementById("newPassword")?.value || "").trim();
      const confirmPassword = (document.getElementById("confirmPassword")?.value || "").trim();

      if (!currentPassword || !newPassword) {
        showToast("Enter your current and new password.", "err");
        return;
      }
      if (newPassword.length < 8) {
        showToast("New password must be at least 8 characters.", "err");
        return;
      }
      if (newPassword !== confirmPassword) {
        showToast("Passwords do not match.", "err");
        return;
      }

      setButtonBusy(els.passwordSaveBtn, true, "Updating…");
      try {
        await requestPasswordChange(currentPassword, newPassword);
        els.passwordForm.reset();
        showToast("Password updated.");
      } catch (err) {
        console.error(err);
        showToast(err.message || "Unable to change password", "err");
      } finally {
        setButtonBusy(els.passwordSaveBtn, false);
      }
    });
  }

  function bindPreferencesForm() {
    if (!els.preferencesForm) return;
    els.preferencesForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!els.preferencesSaveBtn) return;
      const payload = buildPreferencesPayload();
      setButtonBusy(els.preferencesSaveBtn, true, "Saving…");
      try {
        const updated = await patchMe(payload);
        currentUser = updated;
        hydratePreferences(updated);
        showToast("Preferences saved.");
      } catch (err) {
        console.error(err);
        showToast(err.message || "Unable to save preferences", "err");
      } finally {
        setButtonBusy(els.preferencesSaveBtn, false);
      }
    });
  }

  function bindDangerZone() {
    if (els.deleteBtn) {
      els.deleteBtn.addEventListener("click", () => toggleDeleteModal(true));
    }
    els.cancelDelete && els.cancelDelete.addEventListener("click", () => toggleDeleteModal(false));
    els.deleteModal &&
      els.deleteModal.addEventListener("click", (event) => {
        if (event.target === els.deleteModal) {
          toggleDeleteModal(false);
        }
      });
    els.confirmDelete &&
      els.confirmDelete.addEventListener("click", async () => {
        setButtonBusy(els.confirmDelete, true, "Deleting…");
        try {
          await deleteAccount();
          showToast("Account deleted.");
          window.clearStoredSession && window.clearStoredSession();
          window.location.href = "login.html";
        } catch (err) {
          console.error(err);
          showToast(err.message || "Unable to delete account", "err");
        } finally {
          setButtonBusy(els.confirmDelete, false);
          toggleDeleteModal(false);
        }
      });
  }

  function bindNotifications() {
    if (els.notificationToggle) {
      els.notificationToggle.addEventListener("click", () => toggleNotifications());
    }
    document.addEventListener("click", (event) => {
      if (!notificationPanelOpen) return;
      const clickInsidePanel = els.notificationPanel?.contains(event.target);
      const clickOnToggle = els.notificationToggle?.contains(event.target);
      if (!clickInsidePanel && !clickOnToggle) {
        toggleNotifications(false);
      }
    });
  }

  function toggleNotifications(forceState) {
    const newState = typeof forceState === "boolean" ? forceState : !notificationPanelOpen;
    notificationPanelOpen = newState;
    if (els.notificationPanel) {
      els.notificationPanel.classList.toggle("show", notificationPanelOpen);
    }
  }

  async function loadUser() {
    try {
      const res = await authorizedFetch("/users/me");
      const data = await res.json();
      currentUser = data;
      pendingAvatarURL = "";
      hydrateProfileForm(data);
      hydratePreferences(data);
    } catch (err) {
      console.error(err);
      showToast(err.message || "Unable to load profile", "err");
    }
  }

  async function loadNotifications() {
    try {
      const res = await authorizedFetch("/users/me/notifications");
      const payload = await res.json();
      renderNotifications(payload?.items || []);
      updateNotificationBadge(payload?.unread || 0);
    } catch (err) {
      console.warn("[settings] notifications unavailable", err);
      updateNotificationBadge(0);
    }
  }

  function renderNotifications(items) {
    if (!els.notificationList) return;
    if (!items.length) {
      els.notificationList.innerHTML = `<p class="notification-item">You're all caught up.</p>`;
      return;
    }
    els.notificationList.innerHTML = "";
    items.forEach((item) => {
      const entry = document.createElement("p");
      entry.className = "notification-item";
      const title = document.createElement("strong");
      title.textContent = `${item.title || "Notification"}: `;
      entry.appendChild(title);
      entry.appendChild(document.createTextNode(item.body || ""));
      const meta = document.createElement("span");
      meta.style.display = "block";
      meta.style.fontSize = "0.82rem";
      meta.style.color = "var(--muted)";
      meta.textContent = formatRelative(item.createdAt);
      entry.appendChild(meta);
      els.notificationList.appendChild(entry);
    });
  }

  function hydrateProfileForm(user) {
    if (!user) return;
    setValue(els.firstName, user.firstName || "");
    setValue(els.lastName, user.lastName || "");
    setValue(els.email, user.email || "");
    const phoneValue = user.phone || user.contactPhone || user.phoneNumber || "";
    setValue(els.phone, phoneValue);
    const firmValue = user.lawFirm || user.firm || user.company || "";
    setValue(els.lawFirm, firmValue);
    setValue(els.bio, user.bio || "");
    setAvatarPreview(user.avatarURL);
    hydrateHeader(user);
  }

  function hydratePreferences(user) {
    if (!user) return;
    const notifications = user.notifications || {};
    const emailPref = user.emailPref || {};
    if (els.prefEmail) els.prefEmail.checked = emailPref.product !== false;
    if (els.prefCase) els.prefCase.checked = notifications.caseUpdates !== false;
    if (els.prefMessages) els.prefMessages.checked = notifications.messages !== false;
    if (els.prefTasks) els.prefTasks.checked = notifications.system !== false;
  }

  function hydrateHeader(user) {
    const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Attorney";
    const roleLabel = (user.role || "Attorney").replace(/\b\w/g, (c) => c.toUpperCase());
    if (els.headerName) els.headerName.textContent = fullName;
    if (els.headerRole) els.headerRole.textContent = roleLabel;
    const initials = getInitials(fullName);
    const avatarSource = user.avatarURL || buildInitialAvatar(initials);
    if (els.headerAvatar) {
      els.headerAvatar.src = avatarSource;
      els.headerAvatar.alt = `${fullName} avatar`;
    }
  }

  function setAvatarPreview(url, initials) {
    if (!els.avatarFrame) return;
    if (url) {
      els.avatarFrame.classList.add("has-photo");
      if (els.avatarPreview) {
        els.avatarPreview.src = url;
        els.avatarPreview.alt = "Profile photo";
      }
      if (els.avatarInitials) {
        els.avatarInitials.textContent = "";
      }
    } else {
      els.avatarFrame.classList.remove("has-photo");
      if (els.avatarPreview) {
        els.avatarPreview.removeAttribute("src");
      }
      if (els.avatarInitials) {
        els.avatarInitials.textContent = initials || getInitials();
      }
    }
  }

  function buildProfilePayload() {
    const payload = {};
    payload.firstName = (els.firstName?.value || "").trim();
    payload.lastName = (els.lastName?.value || "").trim();
    payload.email = (els.email?.value || "").trim();
    payload.phone = (els.phone?.value || "").trim();
    payload.lawFirm = (els.lawFirm?.value || "").trim();
    payload.bio = (els.bio?.value || "").trim();
    const avatarURL = pendingAvatarURL || currentUser?.avatarURL || "";
    if (avatarURL) payload.avatarURL = avatarURL;
    return payload;
  }

  function buildPreferencesPayload() {
    const payload = { notifications: {}, emailPref: {} };
    if (els.prefEmail) {
      payload.emailPref.product = !!els.prefEmail.checked;
      payload.emailPref.marketing = !!els.prefEmail.checked;
    }
    if (els.prefCase) payload.notifications.caseUpdates = !!els.prefCase.checked;
    if (els.prefMessages) payload.notifications.messages = !!els.prefMessages.checked;
    if (els.prefTasks) payload.notifications.system = !!els.prefTasks.checked;
    return payload;
  }

  async function patchMe(body) {
    const res = await authorizedFetch("/users/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error || data?.msg || "Unable to update profile";
      throw new Error(message);
    }
    return data;
  }

  async function requestPasswordChange(currentPassword, newPassword) {
    const res = await authorizedFetch("/users/me/password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const message = data?.error || data?.msg || "Unable to update password";
      throw new Error(message);
    }
    return data;
  }

  async function deleteAccount() {
    const res = await authorizedFetch("/users/me", { method: "DELETE" });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const message = data?.error || data?.msg || "Unable to delete account";
      throw new Error(message);
    }
    return data;
  }

  async function handleAvatarUpload(file) {
    if (uploadingAvatar) return;
    if (!file) return;
    if (!/image\/(png|jpe?g)/i.test(file.type)) {
      showToast("Only JPEG or PNG files are allowed.", "err");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast("Photo must be under 5 MB.", "err");
      return;
    }

    uploadingAvatar = true;
    setUploadStatus("Uploading…");
    const tempUrl = URL.createObjectURL(file);
    const initials = getInitials(`${currentUser?.firstName || ""} ${currentUser?.lastName || ""}`);
    setAvatarPreview(tempUrl, initials);

    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      const res = await authorizedFetch("/uploads/profile", {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = data?.error || data?.msg || "Upload failed";
        throw new Error(message);
      }
      const url = data?.url || data?.secureUrl || data?.avatarURL || data?.location;
      if (!url) {
        throw new Error("Upload did not return a file URL");
      }
      pendingAvatarURL = url;
      setAvatarPreview(url, initials);
      setUploadStatus("Photo uploaded. Click Save to apply.", "success");
      showToast("Photo uploaded.");
    } catch (err) {
      console.error(err);
      setUploadStatus(err.message || "Upload failed", "error");
      showToast(err.message || "Unable to upload photo", "err");
      const fallbackInitials = getInitials(`${currentUser?.firstName || ""} ${currentUser?.lastName || ""}`);
      if (currentUser?.avatarURL) {
        setAvatarPreview(currentUser.avatarURL, fallbackInitials);
      } else {
        setAvatarPreview(null, fallbackInitials);
      }
    } finally {
      uploadingAvatar = false;
      URL.revokeObjectURL(tempUrl);
    }
  }

  function setUploadStatus(message, type) {
    if (!els.uploadStatus) return;
    els.uploadStatus.textContent = message || "";
    els.uploadStatus.style.color =
      type === "error" ? "#c0392b" : type === "success" ? "#1d976c" : "var(--muted)";
  }

  function toggleDeleteModal(show) {
    if (!els.deleteModal) return;
    els.deleteModal.classList.toggle("show", !!show);
  }

  function setButtonBusy(button, busy, busyLabel) {
    if (!button) return;
    if (!button.dataset.defaultText) {
      button.dataset.defaultText = button.textContent || "";
    }
    button.disabled = busy;
    if (busy && busyLabel) {
      button.textContent = busyLabel;
    } else {
      button.textContent = button.dataset.defaultText;
    }
  }

  function updateNotificationBadge(count) {
    if (els.notificationBadge) {
      els.notificationBadge.textContent = count > 9 ? "9+" : String(count);
      els.notificationBadge.classList.toggle("show", count > 0);
    }
  }

  function formatRelative(value) {
    if (!value) return "Just now";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Just now";
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Moments ago";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  function getInitials(name = "") {
    const parts = name
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (!parts.length && currentUser) {
      parts.push(currentUser.firstName || "", currentUser.lastName || "");
    }
    const initials = parts
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join("");
    return initials || "A";
  }

  function buildInitialAvatar(initials) {
    const text = (initials || "A").slice(0, 2).toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><circle cx='40' cy='40' r='36' fill='#d4c6a4' stroke='#ffffff' stroke-width='4'/><text x='50%' y='55%' text-anchor='middle' font-family='Sarabun, Arial' font-size='28' fill='#1a1a1a' font-weight='600'>${text}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  function showToast(message, type = "ok") {
    if (!message) return;
    if (toastHelper?.show) {
      toastHelper.show(message, { targetId: toastTarget, type });
    } else {
      alert(message);
    }
  }

  function setValue(el, value) {
    if (!el) return;
    el.value = value;
  }

  let csrfToken = "";

  async function ensureCsrfToken(force = false) {
    if (force) csrfToken = "";
    if (csrfToken) return csrfToken;
    try {
      const res = await fetch("/api/csrf", { credentials: "include" });
      if (!res.ok) return "";
      const data = await res.json().catch(() => ({}));
      csrfToken = data?.csrfToken || "";
      return csrfToken;
    } catch {
      return "";
    }
  }

  async function authorizedFetch(path, options = {}) {
    const opts = { ...options };
    const method = String(opts.method || "GET").toUpperCase();
    const headers = { ...(opts.headers || {}) };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const token = await ensureCsrfToken();
      if (token) headers["X-CSRF-Token"] = token;
    }
    opts.headers = headers;
    opts.credentials = "include";
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error("Unauthorized");
    }
    return res;
  }

  function handleUnauthorized() {
    window.clearStoredSession && window.clearStoredSession();
    window.location.href = "login.html";
  }

})();
