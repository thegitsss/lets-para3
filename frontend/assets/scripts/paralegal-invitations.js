import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();
  await loadInvitationsList();
});

async function loadInvitationsList() {
  const section = document.getElementById("invitationList");
  if (!section) return;
  section.innerHTML = "";

  const res = await secureFetch("/api/cases/invited-to");
  if (!res.ok) {
    let message = "Unable to load invitations.";
    try {
      const data = await res.json().catch(() => ({}));
      message = data?.error || data?.msg || message;
    } catch {}
    section.innerHTML = `<p class="pending-empty">${escapeHTML(message)}</p>`;
    return;
  }
  const { items = [] } = await res.json().catch(() => ({}));

  if (!items.length) {
    section.innerHTML = "<p class=\"pending-empty\">No invitations yet.</p>";
    return;
  }

  items.forEach(inv => {
    const attorneyName = inv.attorney?.name ||
      [inv.attorney?.firstName, inv.attorney?.lastName].filter(Boolean).join(" ").trim() ||
      inv.attorneyNameSnapshot ||
      "Unknown";
    section.innerHTML += `
      <div class="invite-card">
        <div class="invite-main">
          <div class="invite-title">${escapeHTML(inv.title || "Untitled case")}</div>
          <div class="invite-meta">Attorney: ${escapeHTML(attorneyName)}</div>
        </div>
        <div class="invite-actions">
          <button class="btn primary acceptBtn" data-id="${inv._id}">Accept</button>
          <button class="btn secondary declineBtn" data-id="${inv._id}">Decline</button>
        </div>
      </div>
    `;
  });

  document.querySelectorAll(".acceptBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const toast = window.toastUtils;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Accepting…";
      try {
        const res = await secureFetch(`/api/cases/${btn.dataset.id}/invite/accept`, {
          method: "POST",
          noRedirect: true,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message = data?.error || "Unable to accept invitation.";
          if (res.status === 403 && /stripe/i.test(message)) {
            toast?.show?.(message, { targetId: "toastBanner", type: "error" });
            return;
          }
          throw new Error(message);
        }
        toast?.show?.("Case accepted.", { targetId: "toastBanner", type: "success" });
        if (typeof window.refreshNotificationCenters === "function") {
          window.refreshNotificationCenters();
        }
        await loadInvitationsList();
      } catch (err) {
        toast?.show?.(err.message || "Unable to accept invitation.", {
          targetId: "toastBanner",
          type: "error",
        });
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  document.querySelectorAll(".declineBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const toast = window.toastUtils;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Declining…";
      try {
        const res = await secureFetch(`/api/cases/${btn.dataset.id}/invite/decline`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Unable to decline invitation.");
        }
        toast?.show?.("Invitation declined.", { targetId: "toastBanner", type: "success" });
        if (typeof window.refreshNotificationCenters === "function") {
          window.refreshNotificationCenters();
        }
        await loadInvitationsList();
      } catch (err) {
        toast?.show?.(err.message || "Unable to decline invitation.", {
          targetId: "toastBanner",
          type: "error",
        });
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}
