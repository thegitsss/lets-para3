import { secureFetch } from "./auth.js";

const state = {
  user: null,
  cropper: null,
  bioTimer: null,
  uploading: false,
};

document.addEventListener("DOMContentLoaded", () => {
  const panel = document.querySelector("[data-attorney-settings]");
  if (!panel) return;
  initSettingsPanel(panel);
});

async function initSettingsPanel(panel) {
  togglePanelLoading(panel, true);
  try {
    const me = await fetchCurrentUser();
    state.user = me;
    hydratePanel(panel, me);
    bindAvatarControls(panel);
    bindBioField(panel);
    bindNotificationToggles(panel);
  } catch (err) {
    console.warn("[attorney-settings] init failed", err);
    panel.innerHTML =
      '<p style="color:#c0392b;font-size:0.95rem;">Unable to load settings right now. Please refresh.</p>';
  } finally {
    togglePanelLoading(panel, false);
  }
}

function togglePanelLoading(panel, isLoading) {
  if (!panel) return;
  panel.style.opacity = isLoading ? "0.6" : "1";
}

async function fetchCurrentUser() {
  const res = await secureFetch("/api/users/me", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Failed to load profile");
  return res.json();
}

function hydratePanel(panel, user) {
  const avatarUrl = user.profileImage || user.avatarURL || "";
  const preview = panel.querySelector("#attorneyAvatarPreview");
  const initials = panel.querySelector("#attorneyAvatarInitials");
  if (avatarUrl && preview) {
    preview.src = avatarUrl;
    preview.hidden = false;
    initials?.classList.add("hidden");
  } else if (initials) {
    initials.textContent = buildInitials(`${user.firstName || ""} ${user.lastName || ""}`.trim());
  }

  const bioInput = panel.querySelector("#attorneyBioInput");
  if (bioInput) {
    bioInput.value = user.bio || "";
    updateBioCount(bioInput);
  }

  const emailToggle = panel.querySelector("#attorneyPrefEmail");
  if (emailToggle) emailToggle.checked = user.notificationPrefs?.email !== false;
  const msgToggle = panel.querySelector("#attorneyPrefMessages");
  if (msgToggle) msgToggle.checked = user.notificationPrefs?.emailMessages !== false;
  const invitesToggle = panel.querySelector("#attorneyPrefInvites");
  if (invitesToggle) invitesToggle.checked = user.notificationPrefs?.emailCase !== false;
}

function bindAvatarControls(panel) {
  const input = panel.querySelector("#attorneyAvatarInput");
  const uploadBtn = panel.querySelector("#attorneyAvatarUploadBtn");
  const saveBtn = panel.querySelector("#attorneyAvatarSaveBtn");
  const preview = panel.querySelector("#attorneyAvatarPreview");
  const initials = panel.querySelector("#attorneyAvatarInitials");
  if (!input || !uploadBtn || !saveBtn || !preview) return;

  uploadBtn.addEventListener("click", () => input.click());
  input.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      preview.src = reader.result;
      preview.hidden = false;
      initials?.classList.add("hidden");
      if (state.cropper) state.cropper.destroy();
      if (window.Cropper) {
        state.cropper = new window.Cropper(preview, {
          aspectRatio: 1,
          viewMode: 2,
          dragMode: "move",
          background: false,
        });
      } else {
        console.warn("Cropper library missing");
      }
      saveBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  });

  saveBtn.addEventListener("click", () => saveCroppedAvatar(saveBtn));
}

async function saveCroppedAvatar(saveBtn) {
  if (!state.cropper || state.uploading) return;
  state.uploading = true;
  const original = saveBtn.textContent;
  saveBtn.textContent = "Saving…";
  try {
    const canvas = state.cropper.getCroppedCanvas({
      width: 600,
      height: 600,
      imageSmoothingQuality: "high",
    });
    if (!canvas) throw new Error("Unable to crop image");
    const base64 = canvas.toDataURL("image/jpeg", 0.9);
    const res = await secureFetch("/api/users/profile-photo", {
      method: "POST",
      body: { image: base64 },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.url) throw new Error(payload?.error || "Upload failed");
    updateGlobalAvatar(payload.url);
    showToast("Profile photo updated", "success");
    state.user.profileImage = payload.url;
  } catch (err) {
    console.warn("[attorney-settings] photo upload failed", err);
    showToast("Unable to save photo", "err");
  } finally {
    state.uploading = false;
    saveBtn.textContent = original || "Save Photo";
    saveBtn.disabled = true;
  }
}

function updateGlobalAvatar(url) {
  document.querySelectorAll("[data-avatar]").forEach((node) => {
    node.src = url;
  });
  const headerAvatar = document.getElementById("headerAvatar");
  if (headerAvatar) headerAvatar.src = url;
  const preview = document.getElementById("attorneyAvatarPreview");
  if (preview) {
    preview.src = url;
    preview.hidden = false;
  }
  const initials = document.getElementById("attorneyAvatarInitials");
  initials?.classList.add("hidden");
}

function bindBioField(panel) {
  const input = panel.querySelector("#attorneyBioInput");
  if (!input) return;
  input.addEventListener("input", () => {
    updateBioCount(input);
    clearTimeout(state.bioTimer);
    state.bioTimer = setTimeout(() => persistBio(input.value), 700);
  });
}

function updateBioCount(input) {
  const counter = document.getElementById("attorneyBioCount");
  if (!counter || !input) return;
  counter.textContent = String(input.value.length);
}

async function persistBio(value) {
  try {
    const res = await secureFetch("/api/users/me", {
      method: "PATCH",
      body: { bio: value },
    });
    if (!res.ok) throw new Error("Failed to save bio");
    showToast("Bio saved", "success");
  } catch (err) {
    console.warn("[attorney-settings] bio save failed", err);
    showToast("Unable to save bio", "err");
  }
}

function bindNotificationToggles(panel) {
  bindPrefToggle(panel.querySelector("#attorneyPrefEmail"), "email");
  bindPrefToggle(panel.querySelector("#attorneyPrefMessages"), "emailMessages");
  bindPrefToggle(panel.querySelector("#attorneyPrefInvites"), "emailCase");
}

function bindPrefToggle(input, key) {
  if (!input) return;
  input.addEventListener("change", async () => {
    const next = input.checked;
    try {
      await saveNotificationPref(key, next);
      showToast("Notification preference updated", "success");
    } catch (err) {
      console.warn("[attorney-settings] pref save failed", err);
      input.checked = !next;
      showToast("Unable to update preference", "err");
    }
  });
}

async function saveNotificationPref(key, value) {
  const res = await secureFetch("/api/users/me/notification-prefs", {
    method: "PATCH",
    body: { [key]: !!value },
  });
  if (!res.ok) throw new Error("Pref update failed");
}

function buildInitials(name = "") {
  const trimmed = name.trim();
  if (!trimmed) return "A";
  return trimmed
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);
}

function showToast(message, type = "info") {
  window.toastUtils?.show?.(message, {
    targetId: "toastBanner",
    type: type === "error" ? "err" : type,
  });
}
