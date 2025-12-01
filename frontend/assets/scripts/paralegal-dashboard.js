import { secureFetch, logout } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

function getProfileImageUrl(user) {
  return user.profileImage || user.avatarURL || "assets/images/default-avatar.png";
}

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();

  await loadParalegalProfileCard();
  await loadParalegalInvitations();
  await loadParalegalApplications();
  await loadParalegalAssignedCases();

  initSidebarNavigation();
});

// ------------- SIDEBAR NAV -------------
function initSidebarNavigation() {
  document.querySelectorAll(".sideNavItem").forEach(item => {
    item.addEventListener("click", () => {
      const target = item.dataset.target;
      const section = document.getElementById(target);
      if (section) {
        section.scrollIntoView({ behavior: "smooth" });
      }
    });
  });
}

// ------------- PROFILE CARD -------------
async function loadParalegalProfileCard() {
  const res = await secureFetch("/api/users/me");
  const user = await res.json();

  const card = document.getElementById("paraProfileCard");
  if (!card) return;
  card.innerHTML = `
    <h3>My Profile</h3>
    <img src="${getProfileImageUrl(user)}" class="profile-img">
    <p><strong>${user.firstName || ""} ${user.lastName || ""}</strong></p>
    ${user.bio ? `<p>${user.bio}</p>` : ""}
    ${user.resumeURL ? `<a href="${user.resumeURL}" target="_blank">View Résumé</a>` : ""}
  `;
}

// ------------- INVITATIONS -------------
async function loadParalegalInvitations() {
  const section = document.getElementById("paraInvitations");
  if (!section) return;
  section.innerHTML = "<h3>Invitations</h3>";

  const res = await secureFetch("/api/cases/invited-to");
  if (!res.ok) {
    section.innerHTML += "<p>No invitations yet.</p>";
    return;
  }
  const { items = [] } = await res.json();

  if (!items.length) {
    section.innerHTML += "<p>No invitations yet.</p>";
    return;
  }

  items.forEach(inv => {
    section.innerHTML += `
      <div class="invite-card">
        <strong>${inv.title}</strong><br>
        <button class="acceptInviteBtn" data-id="${inv._id}">Accept</button>
        <button class="declineInviteBtn" data-id="${inv._id}">Decline</button>
      </div>
    `;
  });

  document.querySelectorAll(".acceptInviteBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await secureFetch(`/api/cases/${btn.dataset.id}/invite/accept`, { method: "POST" });
      await loadParalegalInvitations();
      await loadParalegalAssignedCases();
    });
  });

  document.querySelectorAll(".declineInviteBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await secureFetch(`/api/cases/${btn.dataset.id}/invite/decline`, { method: "POST" });
      await loadParalegalInvitations();
    });
  });
}

// ------------- APPLICATIONS -------------
async function loadParalegalApplications() {
  const section = document.getElementById("paraApplications");
  if (!section) return;
  section.innerHTML = "<h3>My Applications</h3>";

  const res = await secureFetch("/api/applications/my");
  const { items = [] } = await res.json();

  if (!items.length) {
    section.innerHTML += "<p>You have not applied to any jobs.</p>";
    return;
  }

  items.forEach(app => {
    section.innerHTML += `
      <div class="application-card">
        <strong>${app.caseTitle || "Case"}</strong> — ${app.status}
      </div>
    `;
  });
}

// ------------- ASSIGNED CASES -------------
async function loadParalegalAssignedCases() {
  const section = document.getElementById("paraAssignedCases");
  if (!section) return;
  section.innerHTML = "<h3>Assigned Cases</h3>";

  const res = await secureFetch("/api/cases/my-assigned");
  const { items = [] } = await res.json();

  if (!items.length) {
    section.innerHTML += "<p>No assigned cases.</p>";
    return;
  }

  items.forEach(c => {
    section.innerHTML += `
      <div class="assigned-case-card">
        <strong>${c.title}</strong><br>
        <a href="case-detail.html?caseId=${c._id}">Open Case</a>
      </div>
    `;
  });
}
