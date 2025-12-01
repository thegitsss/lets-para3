import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();
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
  } catch (err) {
    renderFallback("settingsProfilePhoto", "Profile Photo");
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
  try { await loadProfilePhoto(user); } catch { renderFallback("settingsProfilePhoto", "Profile Photo"); }
  try { await loadResume(user); } catch { renderFallback("settingsResume", "Résumé"); }
  try { await loadBio(user); } catch { renderFallback("settingsBio", "Bio"); }
  try { await loadEducation(user); } catch { renderFallback("settingsEducation", "Education"); }
  try { await loadAwards(user); } catch { renderFallback("settingsAwards", "Awards"); }
  try { await loadSkills(user); } catch { renderFallback("settingsSkills", "Skills"); }
  try { await loadLinkedIn(user); } catch { renderFallback("settingsLinkedIn", "LinkedIn"); }
  try { await loadNotifications(user); } catch { renderFallback("settingsNotifications", "Notifications"); }
  syncCluster(user);

  const saveBtn = document.getElementById("saveSettingsBtn");
  if (saveBtn && !saveBtn.dataset.boundSave) {
    saveBtn.dataset.boundSave = "true";
    saveBtn.addEventListener("click", saveSettings);
  }
}


// ================= PROFILE PHOTO =================

function loadProfilePhoto(user) {
  const section = document.getElementById("settingsProfilePhoto");
  if (!section) return;
  section.innerHTML = `
    <h3>Profile Photo</h3>
    <img id="profilePreview" src="${user.profileImage || "default.jpg"}" class="profile-img" style="object-fit:cover;"/>
    <br><br>

    <input id="profileInput" type="file" accept="image/png, image/jpeg">
    <br><br>
    <button id="uploadProfileBtn" class="primary-btn">Upload Photo</button>
  `;

  document.getElementById("profileInput").addEventListener("change", (evt) => {
    const file = evt.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById("profilePreview").src = e.target.result;
    };
    reader.readAsDataURL(file);

    settingsState.profileImageFile = file;
  });

  document.getElementById("uploadProfileBtn").addEventListener("click", async () => {
    if (!settingsState.profileImageFile) {
      alert("Please choose a photo first.");
      return;
    }

    const fd = new FormData();
    fd.append("file", settingsState.profileImageFile);

    const res = await secureFetch("/api/uploads/profile-photo", {
      method: "POST",
      body: fd
    });

    if (!res.ok) {
      alert("Upload failed.");
      return;
    }

    alert("Photo uploaded!");

    const refreshed = await secureFetch("/api/users/me");
    const updatedUser = await refreshed.json();

    document.querySelectorAll(".globalProfileImage").forEach(img => {
      img.src = updatedUser.profileImage;
    });
  });
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
  const body = {
    bio: settingsState.bio,
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
    alert("Could not save changes.");
    return;
  }

  alert("Settings saved!");
}
