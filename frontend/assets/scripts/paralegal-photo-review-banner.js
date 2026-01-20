(function () {
  const BANNER_ID = "photoReviewPendingBanner";
  const STYLE_ID = "photoReviewPendingStyles";
  const MESSAGE = "Awaiting profile photo approval by admin.";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID} {
        margin: 0 0 1rem;
        padding: 0.6rem 0.9rem;
        border-radius: 12px;
        border: 1px solid rgba(180, 151, 90, 0.35);
        background: rgba(180, 151, 90, 0.12);
        color: #5c4e3a;
        font-size: 0.9rem;
        font-weight: 200;
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      #${BANNER_ID} strong {
        font-weight: 600;
      }
    `;
    document.head.appendChild(style);
  }

  function resolvePending(user = {}) {
    const status = String(user.profilePhotoStatus || "").trim().toLowerCase();
    if (status === "pending_review") return true;
    return !!user.pendingProfileImage;
  }

  function getUserFromStorage() {
    try {
      const raw = localStorage.getItem("lpc_user");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function ensureBanner() {
    if (document.getElementById(BANNER_ID)) return;
    const main = document.querySelector("main");
    if (!main) return;

    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    banner.innerHTML = `<strong>Notice:</strong> ${MESSAGE}`;

    const anchor =
      main.querySelector(".topbar") ||
      main.querySelector(".page-header") ||
      main.querySelector("header") ||
      main.firstElementChild;

    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(banner, anchor.nextSibling);
    } else {
      main.prepend(banner);
    }
  }

  function removeBanner() {
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.remove();
  }

  function applyBanner(user) {
    if (!user || String(user.role || "").toLowerCase() !== "paralegal") {
      removeBanner();
      return;
    }
    if (resolvePending(user)) {
      ensureStyles();
      ensureBanner();
    } else {
      removeBanner();
    }
  }

  async function refreshBanner() {
    const storedUser = getUserFromStorage();
    if (storedUser) applyBanner(storedUser);

    try {
      const res = await fetch("/api/users/me", { credentials: "include" });
      if (!res.ok) return;
      const user = await res.json().catch(() => null);
      if (user) applyBanner(user);
    } catch (_) {}
  }

  document.addEventListener("DOMContentLoaded", () => {
    refreshBanner();
  });

  window.addEventListener("lpc:user-updated", (event) => {
    const user = event?.detail;
    if (user) applyBanner(user);
  });
})();
