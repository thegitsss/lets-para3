// frontend/assets/scripts/views/settings.js
// Settings view aligned to Express/Mongo backend.

import { secureJSON, secureFetch, logout, requireAuth } from "../auth.js";
import { STRIPE_GATE_MESSAGE } from "../utils/stripe-connect.js";

let stylesInjected = false;

export async function loadSettingsView(root, { escapeHTML } = {}) {
  requireAuth();
  ensureStylesOnce();
  applyStoredPrefs();
  root.innerHTML = skeleton();

  try {
    const me = await secureJSON("/api/users/me");
    draw(root, me, escapeHTML || escapeHtml);
    wire(root, me);
    applyStoredPrefs();
  } catch (error) {
    if (String(error?.message || "").includes("401")) {
      window.location.href = "login.html";
      return;
    }
    root.innerHTML = `
      <div class="section">
        <div class="section-title">Settings</div>
        <div class="err">Couldn’t load settings. Please refresh.</div>
      </div>
    `;
  }
}

export const render = loadSettingsView;
export { loadSettingsView };

/* ----------------------------- render ----------------------------- */

function draw(root, me, escapeHTML) {
  const role = me.role || "attorney";
  const status = me.status || "pending";
  const displayName = `${me.firstName || ""} ${me.lastName || ""}`.trim() || "—";

  const payouts =
    role === "paralegal"
      ? `
    <div class="block">
      <div class="block-title">Payouts</div>
      <div class="row wrap" role="group" aria-label="Payout status">
        <div id="stripeStatusRow" class="row" style="display:none; gap:12px; align-items:center; flex-wrap:wrap;">
          <div>Stripe account: <span id="stripeStatusText" class="muted">Checking…</span></div>
          <button class="btn" id="connectStripeBtn" type="button">Connect Stripe Account</button>
        </div>
      </div>
      <div class="tiny muted" id="stripeStatusHint" style="margin-top:6px; display:none;">Auto-pay on completion requires Stripe Connect onboarding.</div>
    </div>
  `
      : "";

  root.innerHTML = `
    <div class="section">
      <div class="section-title">Settings</div>

      <div class="grid two">
        <div class="block">
          <div class="block-title">Account</div>
          <div class="kv"><span>Name</span><span>${escapeHTML(displayName)}</span></div>
          <div class="kv"><span>Email</span><span>${escapeHTML(me.email || "")}</span></div>
          <div class="kv"><span>Role</span><span style="text-transform:capitalize">${escapeHTML(role)}</span></div>
          <div class="kv"><span>Status</span><span class="${
            status === "approved" ? "ok" : "muted"
          }">${escapeHTML(status)}</span></div>
          ${
            role === "attorney"
              ? `<div class="kv"><span>Bar #</span><span>${escapeHTML(me.barNumber || "—")}</span></div>`
              : ""
          }
          ${
            role === "paralegal"
              ? `
            <div class="kv"><span>Resume</span><span>${me.resumeURL ? "Uploaded" : "—"}</span></div>
            <div class="kv"><span>Certificate</span><span>${me.certificateURL ? "Uploaded" : "—"}</span></div>`
              : ""
          }
        </div>

        <div class="block">
          <div class="block-title">Security</div>
          <div class="row wrap">
            <button class="btn danger" id="logoutBtn" type="button" aria-label="Sign out">Sign out</button>
          </div>
          <div class="tiny muted" style="margin-top:6px;">Signs you out of this browser by clearing the secure session cookie.</div>
        </div>

        <div class="block">
          <div class="block-title">Preferences</div>

          <div class="pref">
            <label class="switch" aria-label="Dark mode toggle">
              <input type="checkbox" id="prefDark">
              <span class="slider"></span>
            </label>
            <div>
              <div class="pref-title">Dark mode</div>
              <div class="pref-desc">Use a dark color scheme (client-side only).</div>
            </div>
          </div>

          <div class="pref">
            <label class="switch" aria-label="Compact UI toggle">
              <input type="checkbox" id="prefCompact">
              <span class="slider"></span>
            </label>
            <div>
              <div class="pref-title">Compact UI</div>
              <div class="pref-desc">Reduce paddings for dense screens (client-side only).</div>
            </div>
          </div>
        </div>

        ${payouts}
      </div>
    </div>
  `;
}

/* ----------------------------- events ----------------------------- */

function wire(root, me) {
  const darkEl = root.querySelector("#prefDark");
  const compactEl = root.querySelector("#prefCompact");
  if (darkEl) darkEl.checked = getPref("dark") === true;
  if (compactEl) compactEl.checked = getPref("compact") === true;

  darkEl?.addEventListener("change", (event) => {
    setPref("dark", !!event.target.checked);
    applyStoredPrefs();
  });

  compactEl?.addEventListener("change", (event) => {
    setPref("compact", !!event.target.checked);
    applyStoredPrefs();
  });

  root.querySelector("#logoutBtn")?.addEventListener("click", () => logout("login.html"));

  if (me.role === "paralegal") {
    initStripeConnect(root);
  }
}

function initStripeConnect(root) {
  const row = root.querySelector("#stripeStatusRow");
  const statusText = root.querySelector("#stripeStatusText");
  const hint = root.querySelector("#stripeStatusHint");
  const button = root.querySelector("#connectStripeBtn");
  if (!row || !statusText || !button) return;

  const setState = ({ details_submitted, charges_enabled, payouts_enabled, accountId, bank_name, bank_last4 }) => {
    const connected = !!details_submitted && !!payouts_enabled;
    const bankName = String(bank_name || "").trim();
    const bankLast4 = String(bank_last4 || "").trim();
    const bankBits = [];
    if (bankName) bankBits.push(bankName);
    if (bankLast4) bankBits.push(`**** ${bankLast4}`);
    const bankLabel = bankBits.length ? ` (${bankBits.join(" ")})` : "";
    statusText.textContent = connected ? `Connected${bankLabel}` : "Not connected";
    statusText.classList.toggle("ok", connected);
    statusText.classList.toggle("muted", !connected);
    button.textContent = connected ? "Update Stripe Details" : "Connect Stripe Account";
    button.disabled = !connected;
    if (!connected) {
      button.setAttribute("aria-disabled", "true");
      button.title = STRIPE_GATE_MESSAGE;
    } else {
      button.removeAttribute("aria-disabled");
      button.removeAttribute("title");
    }
    if (hint) {
      hint.style.display = "block";
      hint.textContent = connected
        ? "Stripe Connect onboarding complete."
        : "Auto-pay on completion requires Stripe Connect onboarding.";
    }
    row.style.display = "flex";
    button.dataset.accountId = accountId || "";
  };

  async function refreshStatus() {
    try {
      const res = await secureFetch("/api/payments/connect/status");
      if (!res.ok) throw new Error("Unable to fetch status");
      const data = await res.json();
      setState(data);
    } catch (err) {
      statusText.textContent = "Status unavailable";
      statusText.classList.add("muted");
      row.style.display = "flex";
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.title = STRIPE_GATE_MESSAGE;
    }
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Connecting…";
    try {
      const createRes = await secureFetch("/api/payments/connect/create-account", { method: "POST" });
      if (!createRes.ok) throw new Error("Unable to prepare Stripe account");
      const { accountId } = await createRes.json();
      const linkRes = await secureFetch("/api/payments/connect/onboard-link", {
        method: "POST",
        body: { accountId },
      });
      if (!linkRes.ok) throw new Error("Unable to start onboarding");
      const { url } = await linkRes.json();
      if (!url) throw new Error("Invalid onboarding link");
      window.location.href = url;
    } catch (err) {
      alert(err?.message || "Unable to start Stripe onboarding.");
      button.disabled = false;
      button.textContent = "Connect Stripe Account";
      refreshStatus();
    }
  });

  refreshStatus();
}

/* ---------------------------- prefs (local) ---------------------------- */

const PREF_KEY = "lp:prefs";
function getAllPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
  } catch {
    return {};
  }
}
function setAllPrefs(prefs) {
  localStorage.setItem(PREF_KEY, JSON.stringify(prefs || {}));
}
function getPref(key) {
  return getAllPrefs()[key];
}
function setPref(key, value) {
  const prefs = getAllPrefs();
  prefs[key] = value;
  setAllPrefs(prefs);
}

function applyStoredPrefs() {
  const prefs = getAllPrefs();
  const root = document.documentElement;
  if (prefs.dark) root.classList.add("dark");
  else root.classList.remove("dark");
  const app = document.getElementById("app") || document.body;
  if (prefs.compact) app.classList.add("compact");
  else app.classList.remove("compact");
}

/* ----------------------------- UI utils ---------------------------- */

function ensureStylesOnce() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.id = "settings-styles";
  style.textContent = `
  .grid.two{display:grid;gap:16px}
  @media(min-width:960px){.grid.two{grid-template-columns:1fr 1fr}}
  .block{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:14px}
  .block-title{font-weight:700;margin-bottom:8px}
  .kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed #eef2f7}
  .kv:last-child{border-bottom:0}
  .row{display:flex;gap:8px;align-items:center}
  .row.wrap{flex-wrap:wrap}
  .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .btn.danger{background:#fff5f5;border-color:#fecaca}
  .hint{color:#6b7280}
  .muted{color:#6b7280}
  .ok{color:#065f46}
  .err{color:#b91c1c}
  .tiny{font-size:.8rem}

  .pref{display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px dashed #eef2f7}
  .pref:last-child{border-bottom:0}
  .pref-title{font-weight:600}
  .pref-desc{font-size:.9rem;color:#6b7280}
  .switch{position:relative;display:inline-block;width:48px;height:28px}
  .switch input{opacity:0;width:0;height:0}
  .slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#e5e7eb;transition:.2s;border-radius:999px}
  .slider:before{position:absolute;content:"";height:22px;width:22px;left:3px;top:3px;background:#fff;transition:.2s;border-radius:50%}
  input:checked + .slider{background:#111827}
  input:checked + .slider:before{transform:translateX(20px)}

  :root.dark{color-scheme:dark}
  :root.dark body{background:#0b0d12;color:#e5e7eb}
  body.compact .section,body.compact .block,body.compact .btn{padding-top:10px;padding-bottom:10px}

  .skeleton .line{height:14px;background:#f3f4f6;border-radius:6px;animation:sh 1.2s infinite}
  @keyframes sh{0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}

function skeleton() {
  return `
  <div class="section skeleton">
    <div class="section-title">Settings</div>
    <div class="grid two">
      <div class="block"><div class="line" style="width:80%"></div><div class="line" style="width:60%;margin-top:8px"></div></div>
      <div class="block"><div class="line" style="width:80%"></div><div class="line" style="width:60%;margin-top:8px"></div></div>
    </div>
  </div>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char] || char));
}
