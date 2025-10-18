// frontend/assets/scripts/views/settings.js
// Settings view aligned to Express/Mongo backend.

export async function render(el) {
  ensureStylesOnce();

  // Apply prefs ASAP to avoid FOUC
  applyStoredPrefs();

  el.innerHTML = skeleton();

  try {
    const me = await j("/api/users/me");
    draw(el, me);
    wire(el, me);
    // Re-apply in case this is the first route paint
    applyStoredPrefs();
  } catch (e) {
    // If we were bounced due to auth, send to login
    if (String(e.message || "").includes("401")) {
      location.href = "login.html";
      return;
    }
    el.innerHTML = `
      <div class="section">
        <div class="section-title">Settings</div>
        <div class="err">Couldn’t load settings. Please refresh.</div>
      </div>`;
  }
}

/* ----------------------------- render ----------------------------- */

function draw(root, me) {
  const h = escapeHtml;
  const role = me.role || "attorney";
  const status = me.status || "pending";

const payouts = role === "paralegal" ? `
  <div class="block">
    <div class="block-title">Payouts</div>
    <div class="row wrap" role="group" aria-label="Payout status">
      <div>Stripe account: ${me.stripeAccountId ? `<span class="ok">Connected</span>` : `<span class="muted">Not connected</span>`}</div>
      ${!me.stripeAccountId ? `<button class="btn" id="connectStripeBtn">Connect Stripe</button>` : ""}
    </div>
    ${!me.stripeAccountId ? `<div class="tiny muted" style="margin-top:6px;">Auto-pay on completion requires Stripe Connect onboarding.</div>` : ""}
  </div>
` : "";

  root.innerHTML = `
    <div class="section">
      <div class="section-title">Settings</div>

      <div class="grid two">
        <div class="block">
          <div class="block-title">Account</div>
          <div class="kv"><span>Name</span><span>${h(me.name || "")}</span></div>
          <div class="kv"><span>Email</span><span>${h(me.email || "")}</span></div>
          <div class="kv"><span>Role</span><span style="text-transform:capitalize">${h(role)}</span></div>
          <div class="kv"><span>Status</span><span class="${status === "approved" ? "ok" : "muted"}">${h(status)}</span></div>
          ${role === "attorney" ? `<div class="kv"><span>Bar #</span><span>${h(me.barNumber || "—")}</span></div>` : ""}
          ${role === "paralegal" ? `
            <div class="kv"><span>Resume</span><span>${me.resumeURL ? "Uploaded" : "—"}</span></div>
            <div class="kv"><span>Certificate</span><span>${me.certificateURL ? "Uploaded" : "—"}</span></div>` : ""}
        </div>

        <div class="block">
          <div class="block-title">Security</div>
          <div class="row wrap">
            <button class="btn danger" id="signOutBtn" aria-label="Sign out">Sign out</button>
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
  // hydrate toggles from stored prefs
  const darkEl = root.querySelector("#prefDark");
  const compactEl = root.querySelector("#prefCompact");
  if (darkEl) darkEl.checked = getPref("dark") === true;
  if (compactEl) compactEl.checked = getPref("compact") === true;

  root.querySelector("#signOutBtn")?.addEventListener("click", async () => {
    try {
      const token = await getCSRF().catch(() => null);
      const headers = token ? { "X-CSRF-Token": token } : {};
      await j("/api/auth/logout", { method: "POST", headers });
    } catch {
      // ignore — we’ll still navigate away
    }
    location.href = "login.html";
  });

  root.querySelector("#prefDark")?.addEventListener("change", (e) => {
    const on = !!e.target.checked;
    setPref("dark", on);
    applyStoredPrefs();
  });

  root.querySelector("#prefCompact")?.addEventListener("change", (e) => {
    const on = !!e.target.checked;
    setPref("compact", on);
    applyStoredPrefs();
  });
}
// Connect Stripe (placeholder)
root.querySelector("#connectStripeBtn")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Preparing…";
  try {
    const token = await getCSRF().catch(() => null);
    const headers = token ? { "X-CSRF-Token": token } : {};
    // Expecting { url: "https://connect.stripe.com/..." }
    const res = await j("/api/payments/connect/onboard", { method: "POST", headers });
    if (res?.url) {
      window.open(res.url, "_blank", "noopener");
    } else {
      alert("Could not start Stripe onboarding.");
    }
  } catch {
    alert("Failed to start onboarding.");
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
});


/* ----------------------------- data ------------------------------- */

async function j(url, opts = {}) {
  const o = { credentials: "include", headers: {}, ...opts };
  if (o.body && typeof o.body === "object" && !(o.body instanceof FormData)) {
    o.headers["Content-Type"] = "application/json";
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(url, o);
  if (!r.ok) throw new Error(`${r.status}`);
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}

let _csrf;
async function getCSRF() {
  if (_csrf) return _csrf;
  const r = await fetch("/api/csrf", { credentials: "include" });
  const j = await r.json();
  _csrf = j.csrfToken;
  return _csrf;
}

/* ---------------------------- prefs (local) ---------------------------- */

const PREF_KEY = "lp:prefs";
function getAllPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; }
}
function setAllPrefs(p) { localStorage.setItem(PREF_KEY, JSON.stringify(p || {})); }
function getPref(k) { return getAllPrefs()[k]; }
function setPref(k, v) { const p = getAllPrefs(); p[k] = v; setAllPrefs(p); }

function applyStoredPrefs() {
  const p = getAllPrefs();
  const root = document.documentElement;
  // dark mode
  if (p.dark) root.classList.add("dark"); else root.classList.remove("dark");
  // compact density
  const app = document.getElementById("app") || document.body;
  if (p.compact) app.classList.add("compact"); else app.classList.remove("compact");
}

/* ----------------------------- UI utils ---------------------------- */

function ensureStylesOnce() {
  if (document.getElementById("settings-styles")) return;
  const s = document.createElement("style");
  s.id = "settings-styles";
  s.textContent = `
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

  /* prefs switches */
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

  /* optional global hooks for prefs */
  :root.dark{color-scheme:dark}
  :root.dark body{background:#0b0d12;color:#e5e7eb}
  body.compact .section, body.compact .block, body.compact .btn{padding-top:10px;padding-bottom:10px}

  /* tiny skeleton lines */
  .skeleton .line{height:14px;background:#f3f4f6;border-radius:6px;animation:sh 1.2s infinite}
  @keyframes sh{0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}
  `;
  document.head.appendChild(s);
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c] || c));
}
