(() => {
  "use strict";

  const fetchCurrentUser = async () => {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      return response.ok ? payload?.user || null : null;
    } catch {
      return null;
    }
  };

  const dashboardFor = (user) => {
    if (String(user?.status || "").toLowerCase() !== "approved") return "";
    if (user?.legalAcceptanceRequired === true) return "legal-acceptance.html";
    const role = String(user?.role || "").toLowerCase();
    if (role === "attorney") return "dashboard-attorney.html";
    if (role === "paralegal") return "dashboard-paralegal.html";
    if (role === "admin") return "admin-dashboard.html";
    if (role === "director") return "director-portal.html";
    return "";
  };

  let authSyncId = 0;
  const syncAuth = async () => {
    const syncId = ++authSyncId;
    const user = await fetchCurrentUser();
    if (syncId !== authSyncId) return;
    const dashboard = dashboardFor(user);
    const signedIn = Boolean(dashboard);

    document.querySelectorAll("[data-utility-auth]").forEach((link) => {
      link.href = dashboard || "login.html";
      link.textContent = dashboard ? "Dashboard" : "Sign In";
    });
    document.querySelectorAll("[data-utility-signup]").forEach((link) => {
      link.hidden = signedIn;
    });
    document.querySelectorAll("[data-utility-logout]").forEach((button) => {
      button.hidden = !signedIn;
    });
    document.querySelectorAll("[data-utility-guest]").forEach((element) => {
      element.hidden = signedIn;
    });
    document.querySelectorAll("[data-utility-member]").forEach((element) => {
      element.hidden = !signedIn;
    });
    document.querySelectorAll("[data-utility-dashboard]").forEach((link) => {
      link.href = dashboard || "login.html";
    });

    if (signedIn) {
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        user.name ||
        "LPC Member";
      const role = String(user.role || "member");
      const roleLabel = `${role.charAt(0).toUpperCase()}${role.slice(1)} Workspace`;
      const avatar =
        user.pendingProfileImage ||
        user.profileImage ||
        user.avatarURL ||
        "assets/avatar-placeholder.svg";
      document.querySelectorAll("[data-utility-name]").forEach((element) => {
        element.textContent = name;
      });
      document.querySelectorAll("[data-utility-role]").forEach((element) => {
        element.textContent = roleLabel;
      });
      document.querySelectorAll("[data-utility-avatar]").forEach((image) => {
        image.src = avatar;
        image.alt = `${name} profile`;
      });
    }
  };

  const initialize = () => {
    void syncAuth();

    document.querySelectorAll("[data-utility-header]").forEach((header) => {
      const button = header.querySelector("[data-utility-menu-toggle]");
      const menu = header.querySelector("[data-utility-menu]");
      button?.addEventListener("click", () => {
        const open = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!open));
        menu.hidden = open;
      });

      const accountButton = header.querySelector("[data-utility-account-toggle]");
      const accountMenu = header.querySelector("[data-utility-account-menu]");
      accountButton?.addEventListener("click", () => {
        const open = accountButton.getAttribute("aria-expanded") === "true";
        accountButton.setAttribute("aria-expanded", String(!open));
        accountMenu.hidden = open;
      });
      document.addEventListener("click", (event) => {
        if (!accountButton || !accountMenu || header.contains(event.target)) return;
        accountButton.setAttribute("aria-expanded", "false");
        accountMenu.hidden = true;
      });
    });

    document.querySelectorAll("[data-utility-logout]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const auth = await import("./auth.js");
          const loggedOut = await auth.logout("login.html");
          if (!loggedOut) throw new Error("Logout was not confirmed by the server.");
        } catch {
          button.disabled = false;
          button.textContent = "Try Log Out Again";
        }
      });
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void syncAuth();
  });
  window.addEventListener("storage", () => void syncAuth());
  window.LPCUtilityHeader = Object.freeze({ syncAuth });
})();
