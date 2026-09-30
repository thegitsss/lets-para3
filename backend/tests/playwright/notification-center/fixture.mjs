import { createNotificationCenter } from "/assets/scripts/utils/notification-center.mjs";

const element = id => document.getElementById(id);
const calls = [], navigations = [], sync = [], changes = [];
let probe;
async function apiRequest(path, options = {}) {
  calls.push({ path, method: options.method || "GET", body: options.body || null });
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json" }, credentials: "same-origin" });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message || "Synthetic API failure");
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}
const center = createNotificationCenter({
  refinePresentation: new URL(location.href).searchParams.get("refined") === "1",
  api: { get: (path, options) => apiRequest(path, options), request: apiRequest },
  panel: element("panel"), content: element("content"), actions: element("actions"), badge: element("badge"), trigger: element("trigger"),
  destinationFor: item => item.action?.href ? { href: item.action.href } : null,
  navigate: destination => { navigations.push(destination.href); history.pushState({}, "", destination.href); },
  showToast: message => { element("toast").textContent = message; },
  onChange: value => changes.push(value),
});
function changeAccount(id) {
  document.cookie = `mock_owner=${id}; path=/`;
  probe?.close();
  probe = new BroadcastChannel(`lpc-v2-notifications-sync:${id}`);
  probe.addEventListener("message", event => sync.push(event.data));
  center.start({ id });
}
function leave() {
  center.cancelNavigation?.();
  history.pushState({}, "", "#/another-matter");
}
element("leave").addEventListener("click", leave);
element("trigger").addEventListener("click", () => center.open());
window.harness = { center, calls, navigations, sync, changes, changeAccount, leave };
changeAccount(new URL(location.href).searchParams.get("owner") || "111111111111111111111111");
