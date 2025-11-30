import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();
  await loadInvitationsList();
});

async function loadInvitationsList() {
  const section = document.getElementById("invitationList");
  section.innerHTML = "<h3>Invitations</h3>";

  const res = await secureFetch("/api/cases/invited-to");
  const { items = [] } = await res.json();

  if (!items.length) {
    section.innerHTML += "<p>No invitations yet.</p>";
    return;
  }

  items.forEach(inv => {
    section.innerHTML += `
      <div class="invite-card">
        <strong>${inv.title}</strong><br>
        <span>Attorney: ${inv.attorneyName}</span><br>
        <button class="acceptBtn" data-id="${inv._id}">Accept</button>
        <button class="declineBtn" data-id="${inv._id}">Decline</button>
      </div>
    `;
  });

  document.querySelectorAll(".acceptBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await secureFetch(`/api/cases/${btn.dataset.id}/invite/accept`, { method: "POST" });
      await loadInvitationsList();
    });
  });

  document.querySelectorAll(".declineBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await secureFetch(`/api/cases/${btn.dataset.id}/invite/decline`, { method: "POST" });
      await loadInvitationsList();
    });
  });
}
