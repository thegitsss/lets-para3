(function primeParalegalV2FirstPaint() {
  "use strict";

  const FONT_SIZES = Object.freeze({ xs: "15px", sm: "16px", md: "17px", lg: "20px", xl: "22px" });

  function safeText(value, maximum = 120) {
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
  }

  function normalizeTheme(value) {
    return /dark$/i.test(String(value || "")) ? "dark" : "light";
  }

  function readCachedIdentity() {
    try {
      const value = JSON.parse(localStorage.getItem("lpc_user") || "null");
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const id = safeText(value.id || value._id, 80);
      const role = safeText(value.role, 30).toLowerCase();
      if (!id && !role) return null;
      return Object.freeze({
        id,
        role,
        firstName: safeText(value.firstName, 80),
        lastName: safeText(value.lastName, 80),
        name: safeText(value.name, 160),
        avatarURL: safeText(value.avatarURL || value.profileImage, 500),
        theme: normalizeTheme(value.preferences?.theme),
        fontSize: safeText(value.preferences?.fontSize, 8).toLowerCase(),
      });
    } catch {
      return null;
    }
  }

  function initialRouteName() {
    const path = String(location.hash || "").replace(/^#\/?/, "").split(/[/?]/)[0].toLowerCase();
    return ["home", "browse", "work", "settings", "help", "profile", "matter"].includes(path)
      ? path
      : "home";
  }

  const identity = readCachedIdentity();
  const theme = identity?.theme || "light";
  document.documentElement.classList.add(`theme-${theme}`);
  document.documentElement.dataset.lpcV2Route = initialRouteName();
  document.documentElement.style.fontSize = FONT_SIZES[identity?.fontSize] || FONT_SIZES.md;

  window.__LPC_V2_BOOT__ = Object.freeze({ identity, theme });
})();
