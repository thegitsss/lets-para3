function storedRole() {
  try {
    const user = window.getStoredUser?.() || JSON.parse(localStorage.getItem("lpc_user") || "null");
    return String(user?.role || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

async function resolveRole() {
  const cached = storedRole();
  if (cached) return cached;
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return "";
    const payload = await response.json();
    return String(payload?.user?.role || payload?.role || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

const role = await resolveRole();
if (role === "attorney") {
  [
    ["../styles/profile-settings-attorney-account.css?v=20260820-14", "lpcAttorneyAccountStyles"],
    ["../styles/profile-settings-focused.css?v=20260902-2", "lpcAttorneyFocusedStyles"],
  ].forEach(([href, id]) => {
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL(href, import.meta.url).href;
    document.head.appendChild(link);
  });
  await import("./attorney-tabs.js");
}
