import { secureFetch } from "./auth.js";
import { confirmAction } from "./utils/dialogs.js";
import { createPasskeyEnrollment, runPasskeyRequest } from "./utils/passkey-ceremony.js";

const panel = document.getElementById("passkeysSection");
if (panel) {
  const list = panel.querySelector("[data-passkey-list]");
  const password = panel.querySelector("[data-passkey-password]");
  const name = panel.querySelector("[data-passkey-name]");
  const add = panel.querySelector("[data-passkey-add]");
  const status = panel.querySelector("[data-passkey-status]");
  const cancel = panel.querySelector("[data-passkey-cancel]");
  const browser = window.SimpleWebAuthnBrowser;
  const supported = Boolean(browser?.browserSupportsWebAuthn?.());
  let busy = false;

  async function request(url, options = {}) {
    return runPasskeyRequest(async signal => {
      const response = await secureFetch(url, { ...options, signal, suppressToast: true });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Unable to manage passkeys. Please try again.");
      return data;
    }, { mutating: url.endsWith("/passkeys/register") || options.method === "DELETE" });
  }

  async function load() {
    const data = await request("/api/account/passkeys");
    list.replaceChildren();
    for (const key of data.passkeys || []) {
      const row = document.createElement("div");
      row.className = "two-factor-actions";
      const label = document.createElement("strong");
      label.textContent = key.name || "Passkey";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-outline";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${key.name || "passkey"}`);
      remove.addEventListener("click", async () => {
        if (busy) return;
        if (!password.value) { status.textContent = "Enter your current password to remove a passkey."; password.focus(); return; }
        if (!await confirmAction("This passkey will no longer sign in to your account.", { title: "Remove this passkey?", confirmLabel: "Remove passkey" })) return;
        busy = true; remove.disabled = true;
        try {
          await request(`/api/account/passkeys/${encodeURIComponent(key.id)}`, { method: "DELETE", body: { currentPassword: password.value } });
          password.value = ""; status.textContent = "Passkey removed."; await load();
        } catch (error) { if (error.kind === "uncertain") await load().catch(() => {}); status.textContent = error.message; }
        finally { busy = false; remove.disabled = false; }
      });
      row.append(label, remove); list.append(row);
    }
    if (!list.children.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "No passkeys added."; list.append(empty); }
  }

  function enrollment() {
    return createPasskeyEnrollment({
      begin: currentPassword => request("/api/account/passkeys/registration-options", { method: "POST", body: { currentPassword } }),
      save: body => request("/api/account/passkeys/register", { method: "POST", body }),
      start: optionsJSON => browser.startRegistration({ optionsJSON }),
      cancelNative: () => browser.WebAuthnAbortService?.cancelCeremony(),
      onPhase: phase => {
        busy = ["preparing", "device", "saving"].includes(phase);
        add.disabled = busy || !supported;
        password.disabled = phase !== "password"; name.disabled = busy;
        cancel.hidden = ["password", "saved", "closed"].includes(phase); cancel.classList.toggle("hidden", cancel.hidden); cancel.disabled = phase === "saving";
        list.querySelectorAll("button").forEach(button => { button.disabled = phase !== "password"; });
        add.textContent = ["ready", "device", "saving"].includes(phase) ? "Create passkey" : "Add a passkey";
        if (phase === "preparing") status.textContent = "Checking your password…";
        if (phase === "ready") { password.value = ""; status.textContent = "Ready. Select Create passkey to open your browser’s prompt."; add.focus(); }
        if (phase === "device") { status.textContent = "Complete your browser’s passkey prompt. You can cancel and try again."; cancel.focus(); }
        if (phase === "saving") status.textContent = "Saving your passkey…";
      },
    });
  }
  let flow = enrollment();
  function reset() { flow = enrollment(); busy = false; password.value = ""; password.disabled = false; name.disabled = false; add.disabled = !supported; add.textContent = "Add a passkey"; cancel.hidden = true; cancel.classList.add("hidden"); list.querySelectorAll("button").forEach(button => { button.disabled = false; }); }
  add.disabled = !supported;
  if (!supported) status.textContent = "This browser or device does not support passkeys.";
  cancel.addEventListener("click", () => { if (flow.cancel()) { reset(); status.textContent = "Passkey setup canceled."; } });
  add.addEventListener("click", async () => {
    if (busy || !supported) return;
    if (flow.phase === "password" && !password.value) { status.textContent = "Enter your current password to add a passkey."; password.focus(); return; }
    const activeFlow = flow;
    try {
      if (flow.phase === "password") await flow.prepare(password.value);
      else { await flow.create(name.value); if (activeFlow !== flow || flow.phase !== "saved") return; reset(); name.value = ""; status.textContent = "Passkey added."; await load(); }
    } catch (error) {
      if (activeFlow !== flow || flow.phase === "closed") return;
      if (error.kind === "uncertain") await load().catch(() => {});
      status.textContent = error.name === "NotAllowedError" || error.name === "AbortError"
        ? "Passkey setup was canceled. You can try again."
        : error.message || "Unable to add a passkey. Please try again.";
    }
  });
  void load().catch(error => { status.textContent = error.message; });
}
