(() => {
  "use strict";

  const scriptUrl = document.currentScript?.src || window.location.href;
  const assistantModuleUrl = new URL("utils/support-drawer.js", scriptUrl).href;

  async function initializeAuthenticatedHelp() {
    if (typeof window.checkSession !== "function") return;
    try {
      const session = await window.checkSession(undefined, { redirectOnFail: false });
      const role = String(session?.role || session?.user?.role || "").toLowerCase();
      const status = String(session?.status || session?.user?.status || "").toLowerCase();
      if (status !== "approved" || !["attorney", "paralegal", "admin"].includes(role)) return;
      const assistant = await import(assistantModuleUrl);
      assistant.scanSupportLaunchers?.();
    } catch {
      // Public visitors keep the same Help content without authenticated tools.
      return;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAuthenticatedHelp, { once: true });
  } else {
    void initializeAuthenticatedHelp();
  }
})();
