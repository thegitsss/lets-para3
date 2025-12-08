import { secureFetch, persistSession } from "./auth.js";

document.addEventListener("DOMContentLoaded", async () => {
  const cachedUser = getCachedUser();
  if (cachedUser) {
    enforceUnifiedRoleStyling(cachedUser);
  }
  await window.checkSession();
  await loadSettings();
});

let settingsState = {
  profileImageFile: null,
  profileImage: "",
  resumeFile: null,
  bio: "",
  education: [],
  awards: [],
  highlightedSkills: [],
  linkedInURL: "",
  notificationPrefs: {}
};

let currentUser = null;

function getCachedUser() {
  if (typeof window.getStoredUser === "function") {
    const stored = window.getStoredUser();
    if (stored) return stored;
  }
  try {
    const raw = localStorage.getItem("lpc_user");
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function showToast(message, type = "info") {
  if (!message) return;
  if (window.toastUtils?.show) {
    window.toastUtils.show(message, { type });
  } else {
    const banner = document.getElementById("toastBanner");
    if (banner) {
      banner.textContent = message;
      banner.dataset.toastType = type;
      banner.classList.add("show");
      setTimeout(() => banner.classList.remove("show"), 2500);
    } else {
      console.log(`[toast:${type}] ${message}`);
    }
  }
}

function applyUnifiedRoleStyling(user = {}) {
  const role = (user.role || "").trim().toLowerCase();
  const eyebrow = document.querySelector(".unified-header .eyebrow");
  const title = document.querySelector(".unified-header h1");

  if (eyebrow) eyebrow.textContent = "Account";
  if (title) {
    title.textContent = role === "paralegal" ? "Paralegal Account Settings" : "Attorney Account Settings";
  }

  document.querySelectorAll("[data-paralegal-only]").forEach((el) => {
    el.style.display = role === "paralegal" ? "" : "none";
  });

  document.querySelectorAll("[data-attorney-only]").forEach((el) => {
    el.style.display = role === "attorney" ? "" : "none";
  });
}

function enforceUnifiedRoleStyling(user = {}) {
  applyUnifiedRoleStyling(user);
  requestAnimationFrame(() => applyUnifiedRoleStyling(user));
}

function applyAvatar(user) {
  if (!user?.profileImage) return;
  const cacheBusted = `${user.profileImage}${user.profileImage.includes("?") ? "&" : "?"}t=${Date.now()}`;

  const header = document.getElementById("headerAvatar");
  if (header) header.src = cacheBusted;

  const preview = document.getElementById("avatarPreview");
  if (preview) {
    preview.src = cacheBusted;
    preview.style.objectPosition = "center center";
  }

  const cluster = document.getElementById("clusterAvatar");
  if (cluster) cluster.src = cacheBusted;

  document.querySelectorAll(".nav-profile-photo, .globalProfileImage").forEach((el) => {
    el.src = cacheBusted;
  });

  const frame = document.getElementById("avatarFrame");
  const initials = document.getElementById("avatarInitials");
  if (frame) frame.classList.add("has-photo");
  if (initials) initials.style.display = "none";
}

function renderFallback(sectionId, title) {
  const section = document.getElementById(sectionId);
  if (section) section.innerHTML = `<h3>${title}</h3><p>Unable to load.</p>`;
}

function syncCluster(user = {}) {
  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.name || "Paralegal";
  const roleLabel = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : "Paralegal";
  const avatar = user.profileImage || user.avatarURL || settingsState.profileImage || "https://via.placeholder.com/64x64.png?text=PL";
  const avatarEl = document.getElementById("clusterAvatar");
  if (avatarEl) avatarEl.src = avatar;
  document.querySelectorAll(".nav-profile-photo").forEach((el) => {
    el.src = avatar;
  });
  const nameEl = document.getElementById("clusterName");
  if (nameEl) nameEl.textContent = fullName;
  const roleEl = document.getElementById("clusterRole");
  if (roleEl) roleEl.textContent = roleLabel;
  window.hydrateParalegalCluster?.(user);
}

async function loadSettings() {
  let user = {};
  try {
    const res = await secureFetch("/api/users/me");
    user = await res.json();
    currentUser = user;
    enforceUnifiedRoleStyling(user);
    applyAvatar(user);
    hydrateProfileForm(user);

    const firstNameInput = document.getElementById("firstNameInput");
    if (firstNameInput) firstNameInput.value = user.firstName || "";
    const lastNameInput = document.getElementById("lastNameInput");
    if (lastNameInput) lastNameInput.value = user.lastName || "";
    const emailInput = document.getElementById("emailInput");
    if (emailInput) emailInput.value = user.email || "";
    const phoneInput = document.getElementById("phoneInput");
    if (phoneInput) phoneInput.value = user.phoneNumber || user.phone || "";
    const lawFirmInput = document.getElementById("lawFirmInput");
    if (lawFirmInput) lawFirmInput.value = user.lawFirm || "";
  } catch (err) {
    renderFallback("settingsResume", "Résumé");
    renderFallback("settingsBio", "Bio");
    renderFallback("settingsEducation", "Education");
    renderFallback("settingsAwards", "Awards");
    renderFallback("settingsSkills", "Skills");
    renderFallback("settingsLinkedIn", "LinkedIn");
    renderFallback("settingsNotifications", "Notifications");
    return;
  }

  // Store existing data
  settingsState.bio = user.bio || "";
  settingsState.education = user.education || [];
  settingsState.awards = user.awards || [];
  settingsState.highlightedSkills = user.highlightedSkills || [];
  settingsState.linkedInURL = user.linkedInURL || "";
  settingsState.notificationPrefs = user.notificationPrefs || {};
  settingsState.profileImage = user.profileImage || user.avatarURL || "";

  // Build UI
  try { await loadResume(user); } catch { renderFallback("settingsResume", "Résumé"); }
  try { await loadBio(user); } catch { renderFallback("settingsBio", "Bio"); }
  try { await loadEducation(user); } catch { renderFallback("settingsEducation", "Education"); }
  try { await loadAwards(user); } catch { renderFallback("settingsAwards", "Awards"); }
  try { await loadSkills(user); } catch { renderFallback("settingsSkills", "Skills"); }
  try { await loadLinkedIn(user); } catch { renderFallback("settingsLinkedIn", "LinkedIn"); }
  try { await loadNotifications(user); } catch { renderFallback("settingsNotifications", "Notifications"); }
  syncCluster(user);

}

function hydrateProfileForm(user = {}) {
  const firstNameInput = document.getElementById("firstNameInput");
  if (firstNameInput) firstNameInput.value = user.firstName || "";
  const lastNameInput = document.getElementById("lastNameInput");
  if (lastNameInput) lastNameInput.value = user.lastName || "";
  const emailInput = document.getElementById("emailInput");
  if (emailInput) emailInput.value = user.email || "";
  const phoneInput = document.getElementById("phoneInput");
  if (phoneInput) phoneInput.value = user.phoneNumber || "";
  const lawFirmInput = document.getElementById("lawFirmInput");
  if (lawFirmInput) lawFirmInput.value = user.lawFirm || "";
  const bioInput = document.getElementById("bio");
  if (bioInput) bioInput.value = user.bio || "";
}


// ================= RESUME =================

function loadResume(user) {
  const section = document.getElementById("settingsResume");
  if (!section) return;
  section.innerHTML = `
    <h3>Résumé</h3>
    ${user.resumeURL ? `<a href="${user.resumeURL}" target="_blank">View current résumé</a><br><br>` : ""}
    <input id="resumeInput" type="file" accept="application/pdf">
    <br><br>
    <button id="uploadResumeBtn" class="primary-btn">Upload Résumé</button>
  `;

  document.getElementById("uploadResumeBtn").addEventListener("click", async () => {
    const file = document.getElementById("resumeInput").files[0];
    if (!file) {
      alert("Please choose a PDF résumé first.");
      return;
    }

    const fd = new FormData();
    fd.append("file", file);

    const res = await secureFetch("/api/uploads/paralegal-resume", {
      method: "POST",
      body: fd
    });

    if (!res.ok) {
      alert("Resume upload failed.");
      return;
    }

    alert("Résumé uploaded!");
  });
}


// ================= BIO =================

function loadBio(user) {
  const section = document.getElementById("settingsBio");
  if (!section) return;
  section.innerHTML = `
    <h3>Bio</h3>
    <textarea id="bioInput" style="width:100%;">${user.bio || ""}</textarea>
  `;
  const bioInput = document.getElementById("bioInput");
  if (bioInput) {
    bioInput.addEventListener("input", (evt) => {
      settingsState.bio = evt.target.value;
    });
  }
}


// ================= EDUCATION =================

function loadEducation(user) {
  const section = document.getElementById("settingsEducation");
  if (!section) return;
  const items = user.education || [];

  section.innerHTML = `
    <h3>Education</h3>
    <div id="eduList"></div>
    <button id="addEduBtn">Add Education Entry</button>
  `;

  const list = document.getElementById("eduList");
  if (!list) return;

  function renderEdu() {
    list.innerHTML = "";
    settingsState.education.forEach((ed, idx) => {
      list.innerHTML += `
        <div class="edu-entry">
          <input placeholder="Degree" value="${ed.degree || ""}" data-idx="${idx}" data-field="degree">
          <input placeholder="Institution" value="${ed.institution || ""}" data-idx="${idx}" data-field="institution">
          <input placeholder="Year" value="${ed.year || ""}" data-idx="${idx}" data-field="year">
          <input placeholder="Certification" value="${ed.certification || ""}" data-idx="${idx}" data-field="certification">
        </div>
      `;
    });

    list.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", (evt) => {
        const idx = evt.target.dataset.idx;
        const field = evt.target.dataset.field;
        settingsState.education[idx][field] = evt.target.value;
      });
    });
  }

  settingsState.education = items;
  renderEdu();

  const addBtn = document.getElementById("addEduBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      settingsState.education.push({ degree:"", institution:"", year:"", certification:"" });
      renderEdu();
    });
  }
}


// ================= AWARDS =================

function loadAwards(user) {
  const section = document.getElementById("settingsAwards");
  if (!section) return;
  const items = user.awards || [];

  section.innerHTML = `
    <h3>Awards</h3>
    <div id="awardList"></div>
    <button id="addAwardBtn">Add Award</button>
  `;

  const list = document.getElementById("awardList");
  if (!list) return;

  function renderAwards() {
    list.innerHTML = "";
    settingsState.awards.forEach((a, idx) => {
      list.innerHTML += `
        <div class="award-entry">
          <input placeholder="Award title" value="${a}" data-idx="${idx}">
        </div>
      `;
    });

    list.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", (evt) => {
        const idx = evt.target.dataset.idx;
        settingsState.awards[idx] = evt.target.value;
      });
    });
  }

  settingsState.awards = items;
  renderAwards();

  const addBtn = document.getElementById("addAwardBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      settingsState.awards.push("");
      renderAwards();
    });
  }
}


// ================= SKILLS =================

function loadSkills(user) {
  const section = document.getElementById("settingsSkills");
  if (!section) return;
  const items = user.highlightedSkills || [];

  section.innerHTML = `
    <h3>Highlighted Skills (Top 3–5)</h3>
    <div id="skillsList"></div>
    <button id="addSkillBtn">Add Skill</button>
  `;

  const list = document.getElementById("skillsList");
  if (!list) return;

  function renderSkills() {
    list.innerHTML = "";
    settingsState.highlightedSkills.forEach((s, idx) => {
      list.innerHTML += `
        <div class="skill-entry">
          <input placeholder="Skill" value="${s}" data-idx="${idx}">
        </div>
      `;
    });

    list.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", (evt) => {
        const idx = evt.target.dataset.idx;
        settingsState.highlightedSkills[idx] = evt.target.value;
      });
    });
  }

  settingsState.highlightedSkills = items;
  renderSkills();

  const addBtn = document.getElementById("addSkillBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (settingsState.highlightedSkills.length < 5) {
        settingsState.highlightedSkills.push("");
        renderSkills();
      }
    });
  }
}


// ================= LINKEDIN =================

function loadLinkedIn(user) {
  const section = document.getElementById("settingsLinkedIn");
  if (!section) return;
  section.innerHTML = `
    <h3>LinkedIn Profile</h3>
    <input id="linkedInURLInput" type="url" style="width:100%;" value="${user.linkedInURL || ""}">
  `;
  const linkedInInput = document.getElementById("linkedInURLInput");
  if (linkedInInput) {
    linkedInInput.addEventListener("input", (evt) => {
      settingsState.linkedInURL = evt.target.value;
    });
  }
}


// ================= NOTIFICATION PREFS =================

function loadNotifications(user) {
  const prefs = user.notificationPrefs || {};

  const section = document.getElementById("settingsNotifications");
  if (!section) return;
  section.innerHTML = `
    <h3>Notification Preferences</h3>
    <label><input type="checkbox" id="prefInAppMessages"> In-app: Messages</label><br>
    <label><input type="checkbox" id="prefInAppCase"> In-app: Case Updates</label><br>
    <label><input type="checkbox" id="prefEmailMessages"> Email: Messages</label><br>
    <label><input type="checkbox" id="prefEmailCase"> Email: Case Updates</label><br>
  `;

  const inAppMsg = document.getElementById("prefInAppMessages");
  const inAppCase = document.getElementById("prefInAppCase");
  const emailMsg = document.getElementById("prefEmailMessages");
  const emailCase = document.getElementById("prefEmailCase");

  if (inAppMsg) {
    inAppMsg.checked = !!prefs.inAppMessages;
    inAppMsg.addEventListener("change", (e) => { prefs.inAppMessages = e.target.checked; });
  }
  if (inAppCase) {
    inAppCase.checked = !!prefs.inAppCase;
    inAppCase.addEventListener("change", (e) => { prefs.inAppCase = e.target.checked; });
  }
  if (emailMsg) {
    emailMsg.checked = !!prefs.emailMessages;
    emailMsg.addEventListener("change", (e) => { prefs.emailMessages = e.target.checked; });
  }
  if (emailCase) {
    emailCase.checked = !!prefs.emailCase;
    emailCase.addEventListener("change", (e) => { prefs.emailCase = e.target.checked; });
  }

  settingsState.notificationPrefs = prefs;
}


// ================= SAVE SETTINGS =================

async function saveSettings() {
  const firstNameInput = document.getElementById("firstNameInput");
  const lastNameInput = document.getElementById("lastNameInput");
  const emailInput = document.getElementById("emailInput");
  const phoneInput = document.getElementById("phoneInput");
  const lawFirmInput = document.getElementById("lawFirmInput");
  const bioInput = document.getElementById("bioInput");
  const body = {
    firstName: firstNameInput ? firstNameInput.value.trim() : "",
    lastName: lastNameInput ? lastNameInput.value.trim() : "",
    email: emailInput?.value || "",
    phoneNumber: phoneInput?.value || "",
    lawFirm: lawFirmInput?.value || "",
    bio: bioInput?.value ?? settingsState.bio,
    education: settingsState.education,
    awards: settingsState.awards,
    highlightedSkills: settingsState.highlightedSkills,
    linkedInURL: settingsState.linkedInURL,
    notificationPrefs: settingsState.notificationPrefs
  };

  const res = await secureFetch("/api/users/me", {
    method: "PATCH",
    body
  });

  if (!res.ok) {
    showToast("Could not save settings.", "err");
    return;
  }

  const updatedUser = await secureFetch("/api/users/me").then((r) => r.json());
  localStorage.setItem("lpc_user", JSON.stringify(updatedUser));
  currentUser = updatedUser;
  settingsState.bio = updatedUser.bio || "";
  settingsState.education = updatedUser.education || [];
  settingsState.awards = updatedUser.awards || [];
  settingsState.highlightedSkills = updatedUser.highlightedSkills || [];
  settingsState.linkedInURL = updatedUser.linkedInURL || "";
  settingsState.notificationPrefs = updatedUser.notificationPrefs || settingsState.notificationPrefs;
  settingsState.profileImage = updatedUser.profileImage || settingsState.profileImage;

  persistSession({ user: updatedUser });
  window.updateSessionUser?.(updatedUser);

  applyAvatar?.(updatedUser);
  hydrateProfileForm(updatedUser);
  syncCluster?.(updatedUser);
  window.hydrateParalegalCluster?.(updatedUser);
  try {
    window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: updatedUser }));
  } catch (_) {}
  showToast("Settings saved!", "ok");
}

// -----------------------------
// PROFILE PHOTO UPLOAD FLOW
// -----------------------------

let cropper = null;

// DOM Elements
const avatarPreview = document.getElementById("avatarPreview");
const avatarInitials = document.getElementById("avatarInitials");
const avatarFrame = document.getElementById("avatarFrame");
const avatarInput = document.getElementById("avatarInput");

if (avatarInput) {
  avatarInput.addEventListener("change", handleFileSelect);
}

const cropperModal = document.getElementById("cropperModal");
const cropImage = document.getElementById("cropImage");
const cropConfirmBtn = document.getElementById("cropConfirmBtn");
const cropCancelBtn = document.getElementById("cropCancelBtn");

// -----------------------------
// STEP 1: User selects a photo
// -----------------------------
async function handleFileSelect() {
  if (!avatarInput) return;
  const file = avatarInput.files[0];
  if (!file || !avatarPreview || !avatarFrame || !avatarInitials) return;

  const reader = new FileReader();
    reader.onload = (e) => {
      avatarPreview.src = e.target.result;
      avatarPreview.style.objectPosition = "center center";

      avatarInitials.style.display = "none";
      avatarFrame.classList.add("has-photo");

    if (cropper) cropper.destroy();

    cropper = new Cropper(avatarPreview, {
      aspectRatio: 1,
      viewMode: 1,
      autoCropArea: 1,
      background: false,
      center: true,
      dragMode: "move",
      movable: true,
      zoomable: true,
      scalable: false,
      rotatable: false,
      cropBoxMovable: false,
      cropBoxResizable: false,
      guides: false,
      highlight: false,
      modal: false,
      toggleDragModeOnDblclick: false,
      ready() {
        setTimeout(() => {
          cropper.reset();
          cropper.crop();
          centerCropperCanvas(cropper);
        }, 0);
      }
    });

    settingsState.profileImageFile = file;
  };
  reader.readAsDataURL(file);
}

function centerCropperCanvas(instance) {
  if (!instance) return;
  const container = instance.getContainerData?.();
  const canvas = instance.getCanvasData?.();
  if (!container || !canvas) return;

  const frameRect = avatarFrame?.getBoundingClientRect();
  const containerWidth = frameRect?.width || container.width || canvas.width;
  const containerHeight = frameRect?.height || container.height || canvas.height;
  const scaleFactor = Math.max(
    containerWidth / canvas.width,
    containerHeight / canvas.height,
    1
  );
  const scaledWidth = canvas.width * scaleFactor;
  const scaledHeight = canvas.height * scaleFactor;

  const centeredCanvas = {
    ...canvas,
    width: scaledWidth,
    height: scaledHeight,
    left: (containerWidth - scaledWidth) / 2,
    top: (containerHeight - scaledHeight) / 2
  };
  instance.setCanvasData(centeredCanvas);

  const cropBox = instance.getCropBoxData?.();
  if (cropBox) {
    instance.setCropBoxData({
      ...cropBox,
      width: containerWidth,
      height: containerHeight,
      left: 0,
      top: 0
    });
  }
}


// -----------------------------
// STEP 2: Save cropped photo
// -----------------------------
async function saveCroppedPhoto() {
  if (!cropper) return;

  cropConfirmBtn.disabled = true;
  cropConfirmBtn.textContent = "Saving...";

  const canvas = cropper.getCroppedCanvas({
    width: 480,
    height: 480
  });

  if (!canvas) {
    showToast("Could not process image.");
    resetSaveButton();
    return;
  }

  // Immediately reflect preview so the gold frame updates even before upload completes
  const dataUrl = canvas.toDataURL("image/png");
  if (avatarPreview && dataUrl) {
    avatarPreview.src = dataUrl;
    const frame = document.getElementById("avatarFrame");
    const initials = document.getElementById("avatarInitials");
    if (frame) frame.classList.add("has-photo");
    if (initials) initials.style.display = "none";
  }

  canvas.toBlob(async (blob) => {
    if (!blob) {
      showToast("Could not process image.");
      resetSaveButton();
      return;
    }

    const formData = new FormData();
    formData.append("file", blob, "avatar.png");

    try {
      const res = await fetch("/api/uploads/profile-photo", {
        method: "POST",
        body: formData,
        credentials: "include"
      });

      if (!res.ok) throw new Error("Upload failed");

      const payload = await res.json();
      const uploadedUrl = payload?.url || payload?.profileImage || payload?.avatarURL;
      if (uploadedUrl) {
        currentUser = { ...(currentUser || {}), profileImage: uploadedUrl };
        settingsState.profileImage = uploadedUrl;
        persistSession({ user: currentUser });
        window.updateSessionUser?.(currentUser);
        // Update avatar preview + header using shared helper
        applyAvatar(currentUser);
      }

      showToast("Profile photo updated!");
      resetCropperModal();
    } catch (err) {
      console.error(err);
      showToast("Failed to upload image. Try again.");
    }

    resetSaveButton();
  }, "image/png");
}


// -----------------------------
// Helpers
// -----------------------------
function resetSaveButton() {
  cropConfirmBtn.disabled = false;
  cropConfirmBtn.textContent = "Save Photo";
}

function resetCropperModal() {
  if (cropper) {
    cropper.destroy();
    cropper = null;
  }

  if (cropperModal) cropperModal.style.display = "none";
  if (cropImage) cropImage.src = "";
  if (avatarInput) avatarInput.value = ""; // reset so selecting same file again still triggers change
}

document.addEventListener("DOMContentLoaded", () => {
  const frame = document.getElementById("avatarFrame");
  const input = document.getElementById("avatarInput");
  const cropConfirmBtn = document.getElementById("cropConfirmBtn");
  const cropCancelBtn = document.getElementById("cropCancelBtn");

  if (frame && input) {
    frame.style.cursor = "pointer";
    frame.addEventListener("click", () => input.click());
    frame.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        input.click();
      }
    });
  }

  if (cropConfirmBtn) {
    cropConfirmBtn.addEventListener("click", saveCroppedPhoto);
  }

  if (cropCancelBtn) {
    cropCancelBtn.addEventListener("click", resetCropperModal);
  }
});

function saveProfile() {
  saveSettings();
}

const profileSaveBtn = document.getElementById("profileSaveBtn");
if (profileSaveBtn) {
  profileSaveBtn.addEventListener("click", saveProfile);
}

const profileForm = document.getElementById("profileForm");
if (profileForm) {
  profileForm.addEventListener("submit", (e) => e.preventDefault());
}

const viewProfileBtn = document.getElementById("viewProfileBtn");
if (viewProfileBtn) {
  viewProfileBtn.addEventListener("click", () => {
    if (!currentUser) return;
    const role = (currentUser.role || "").trim().toLowerCase();
    const id = currentUser.id || currentUser._id;
    if (!id) return;
    const target = role === "paralegal" ? "profile-paralegal.html" : "profile-attorney.html";
    window.location.href = `${target}?id=${encodeURIComponent(id)}`;
  });
}
