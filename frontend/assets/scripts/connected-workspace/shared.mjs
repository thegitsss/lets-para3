export const validId = value => /^[a-f0-9]{24}$/i.test(value || "");
export function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") element.textContent = value;
    else if (key === "className") element.className = value;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  element.append(...children);
  return element;
}
export const action = (text, fn, className = "cw-button") => {
  const control = node("button", { type: "button", text, className });
  control.addEventListener("click", fn);
  return control;
};
export function notice(text, error = false) { return node("p", { className: error ? "cw-notice cw-error" : "cw-notice", role: error ? "alert" : "status", text }); }
export function input(label, attributes = {}) {
  const id = "cw-" + crypto.randomUUID(), control = node(attributes.multiline ? "textarea" : "input", { ...attributes, multiline: undefined, id });
  return { control, element: node("label", { className: "cw-field", for: id }, [node("span", { text: label }), control]) };
}
export function matterHref(role, caseId, tab = "files") {
  return role === "paralegal" ? "/paralegal-v2.html#/matter/" + caseId + "?tab=" + tab : "/attorney-v2.html#/matters/" + caseId + "/" + tab;
}
export function showFatal(error) {
  document.querySelector("main").replaceChildren(node("h1", { text: "This workspace could not open" }), notice(error.message || "Please try again.", true), action("Try again", () => location.reload()), node("a", { href: "/login.html", text: "Sign in" }));
}
export async function createClient(roles) {
  let identity = null, disposed = false;
  const controllers = new Set();
  function clear() {
    disposed = true;
    for (const controller of controllers) controller.abort();
    window.dispatchEvent(new Event("lpc-connected-access-lost"));
    document.querySelector("main")?.replaceChildren(node("h1", { text: "Check your account" }), notice("Your account or access changed. Sign in again to continue."), node("a", { href: "/login.html", text: "Sign in" }));
  }
  async function raw(path, options = {}) {
    if (disposed) throw new Error("This workspace is no longer active.");
    if (!path.startsWith("/api/") || /[\\\u0000-\u0020]/.test(path)) throw new Error("Invalid workspace request.");
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 65000);
    controllers.add(controller);
    try {
      const response = await fetch(path, { ...options, credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", ...(identity ? { "X-LPC-Owner-Id": identity.id } : {}), ...options.headers } });
      const data = await response.json().catch(() => null);
      if (response.status === 401) { clear(); throw new Error("Sign in again to continue."); }
      if (!response.ok) throw Object.assign(new Error(data?.error || data?.msg || "This request could not be confirmed. Refresh before trying again."), { status: response.status, code: data?.code });
      if (!data || typeof data !== "object") throw new Error("The workspace returned an unreadable response.");
      return data;
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  async function verify() {
    const result = await raw("/api/auth/me"), user = result.user;
    const currentId = String(user?.id || user?._id || "");
    if (!validId(currentId) || !roles.includes(user?.role) || user.status !== "approved" || user.disabled || user.deleted || identity && currentId !== identity.id) {
      clear(); throw new Error("This account cannot open this workspace.");
    }
    identity ||= { id: currentId, role: user.role };
    return identity;
  }
  await verify();
  for (const link of document.querySelectorAll("[data-attorney-link]")) link.hidden = identity.role !== "attorney";
  if (identity.role === "paralegal") document.querySelector("[data-return]").href = "/paralegal-v2.html#/home";
  window.addEventListener("pagehide", () => { disposed = true; for (const controller of controllers) controller.abort(); window.dispatchEvent(new Event("lpc-connected-access-lost")); });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  window.addEventListener("focus", () => { if (!disposed) void verify().catch(clear); });
  return {
    get identity() { return identity; },
    async read(path) { await verify(); const result = await raw(path); await verify(); return result; },
    async write(path, body = {}, method = "POST") {
      await verify();
      const csrf = await raw("/api/csrf");
      if (!csrf.csrfToken) throw new Error("Refresh your session before continuing.");
      const result = await raw(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken } });
      await verify();
      return result;
    },
  };
}
