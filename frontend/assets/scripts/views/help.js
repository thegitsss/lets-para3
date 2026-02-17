// frontend/assets/scripts/views/help.js
// Rich Help page: FAQs, health check, diagnostics copy/email/download, cache reset.

const SUPPORT_EMAIL = "help@lets-paraconnect.com";

function ensureStylesOnce() {
  if (document.getElementById("pc-help-styles")) return;
  const s = document.createElement("style");
  s.id = "pc-help-styles";
  s.textContent = `
  .help-wrap{display:grid;gap:16px}
  .grid{display:grid;gap:12px}
  .card{border:1px solid #e5e7eb;border-radius:12px;padding:14px;background:#fff}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .btn.primary{background:#111827;color:#fff;border-color:#111827}
  .muted{color:#6b7280}
  details{border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff}
  details>summary{cursor:pointer;font-weight:600;list-style:none}
  details>summary::-webkit-details-marker{display:none}
  code, pre{font-family:ui-monospace, SFMono-Regular, Menlo, monospace;background:#f3f4f6;border-radius:6px;padding:2px 4px}
  .two-col{display:grid;grid-template-columns:1fr;gap:12px}
  @media (min-width: 900px){ .two-col{grid-template-columns:1fr 1fr} }
  .badge{display:inline-flex;align-items:center;gap:6px;border:1px solid #e5e7eb;border-radius:999px;padding:2px 8px;background:#f9fafb;font-size:12px}
  .badges{display:flex;flex-wrap:wrap;gap:8px}
  `;
  document.head.appendChild(s);
}

function browserDiagnostics() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    page: location.href,
    userAgent: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    timeZone: tz,
    localTime: new Date().toString(),
    screen: { w: window.screen?.width, h: window.screen?.height, dpr: window.devicePixelRatio },
  };
}

async function runHealthCheck() {
  const diag = { ...browserDiagnostics(), checks: {} };

  // Helper to safely fetch JSON/text
  async function safeFetch(url, opts) {
    try {
      const r = await fetch(url, { credentials: "include", ...opts });
      const ct = r.headers.get("content-type") || "";
      const payload = ct.includes("application/json") ? await r.json().catch(()=>null) : await r.text().catch(()=>null);
      return { ok: r.ok, status: r.status, payload };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 1) /ping (optional)
  diag.checks.ping = await safeFetch("/ping");

  // 2) /api/csrf
  diag.checks.csrf = await safeFetch("/api/csrf");

  // 3) /api/users/me (profile)
  diag.checks.usersMe = await safeFetch("/api/users/me");

  // 4) /api/auth/me (token echo, if present)
  diag.checks.authMe = await safeFetch("/api/auth/me");

  // Derived hints
  const hints = [];
  if (!diag.checks.csrf.ok) {
    hints.push("CSRF endpoint not reachable; ensure cookies allowed and server CSRF route enabled.");
  } else if (!diag.checks.csrf.payload?.csrfToken) {
    hints.push("CSRF returned without token; try reloading or clearing cookies.");
  }
  if (!diag.checks.usersMe.ok && (diag.checks.usersMe.status === 401 || diag.checks.usersMe.status === 403)) {
    hints.push("Not authenticated or session expired; sign in again.");
  }
  if (diag.checks.authMe?.ok && diag.checks.authMe.payload?.user) {
    // ok
  } else if (diag.checks.authMe?.status === 200 && diag.checks.authMe?.payload?.user === null) {
    hints.push("Access token not detected; confirm Authorization header or access cookie is set.");
  }

  diag.hints = hints;
  return diag;
}

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

export async function render(el) {
  ensureStylesOnce();

  el.innerHTML = `
    <div class="section help-wrap">
      <div class="section-title">Help</div>

      <div class="two-col">
        <div class="card">
          <div class="row" style="justify-content:space-between;">
            <div>
              <div style="font-weight:700;">Contact support</div>
              <div class="muted">We reply within 1 business day.</div>
            </div>
            <div class="row">
              <a class="btn primary" href="mailto:${SUPPORT_EMAIL}?subject=ParaConnect%20Support%20Request">Email Support</a>
            </div>
          </div>

          <div class="badges" style="margin-top:10px">
            <span class="badge" id="b-online" title="Browser online/offline">🌐 Online: ${navigator.onLine ? "Yes" : "No"}</span>
            <span class="badge" title="Your timezone">🕒 TZ: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown"}</span>
          </div>

          <div style="margin-top:10px;" class="row" role="group" aria-label="Help actions">
            <button class="btn" data-act="health">Run quick health check</button>
            <button class="btn" data-act="copy">Copy diagnostics</button>
            <button class="btn" data-act="download">Download diagnostics</button>
            <button class="btn" data-act="email">Email with diagnostics</button>
            <button class="btn" data-act="cache">Reset local cache</button>
          </div>
          <pre id="diag" class="muted" style="margin-top:10px;max-height:280px;overflow:auto;" aria-live="polite">(No diagnostics yet)</pre>
        </div>

        <div class="card grid">
          <div style="font-weight:700;">Common issues</div>

          <details>
            <summary>“CSRF token invalid / missing” when saving</summary>
            <div class="muted" style="margin-top:8px;">
              1) Load <code>/api/csrf</code> once after login (the app does this automatically).<br>
              2) Ensure your browser allows cookies for this site.<br>
              3) If you switched devices or logged in again, refresh and try the action again.
            </div>
          </details>

          <details>
            <summary>“Unauthorized / Forbidden” on API requests</summary>
            <div class="muted" style="margin-top:8px;">
              You may be logged out or lack access to that case. Try reloading, then re-login. If the issue persists, include diagnostics below when emailing support.
            </div>
          </details>

          <details>
            <summary>File upload failed</summary>
            <div class="muted" style="margin-top:8px;">
              We allow PDF / PNG / JPEG up to your plan’s limit. Uploads go directly to secure storage via a short-lived link—try again within 60 seconds of opening the upload dialog.
            </div>
          </details>

          <details>
            <summary>Payments or release issues</summary>
            <div class="muted" style="margin-top:8px;">
              If a case was marked complete but payout hasn’t appeared, include the Case ID in your email. We’ll confirm the funds and transfer status.
            </div>
          </details>

          <details>
            <summary>Zoom link not showing in a case</summary>
            <div class="muted" style="margin-top:8px;">
              The attorney (or admin) can set the Zoom/meeting link under the case’s settings. Ask them to update it or share it directly.
            </div>
          </details>
        </div>
      </div>

      <div class="card grid">
        <div style="font-weight:700;">Keyboard & tips</div>
        <ul class="muted" style="margin:0 0 0 18px;">
          <li><b>Cmd/Ctrl + Enter</b> often submits forms (messages, comments).</li>
          <li>Click a date in <b>Calendar</b> to prefill the “Add” form.</li>
          <li><b>Checklist</b>: check the box to mark a task complete; use “Edit” to change due dates.</li>
          <li><b>Documents</b>: after upload, use “Download” to get a signed URL that expires shortly for security.</li>
        </ul>
      </div>

      <div class="card grid">
        <div style="font-weight:700;">Policies</div>
        <div class="muted">
          By using the platform, you agree to our Terms and Privacy Policy.
        </div>
        <div class="row">
          <a class="btn" href="/terms.html">Terms of Service</a>
          <a class="btn" href="/privacy.html">Privacy Policy</a>
        </div>
      </div>
    </div>
  `;

  const diagEl = el.querySelector("#diag");
  const onlineBadge = el.querySelector("#b-online");

  // keep the online badge live
  window.addEventListener("online", () => (onlineBadge.textContent = "🌐 Online: Yes"));
  window.addEventListener("offline", () => (onlineBadge.textContent = "🌐 Online: No"));

  // Button handlers
  el.querySelector('[data-act="health"]').addEventListener("click", async () => {
    diagEl.textContent = "Running checks…";
    const result = await runHealthCheck();
    diagEl.textContent = pretty(result);
  });

  el.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    const current = diagEl.textContent === "(No diagnostics yet)" ? pretty(browserDiagnostics()) : diagEl.textContent;
    try {
      await navigator.clipboard.writeText(current);
      alert("Diagnostics copied to clipboard.");
    } catch {
      alert("Copy failed—select and copy the text manually.");
    }
  });

  el.querySelector('[data-act="download"]').addEventListener("click", () => {
    const current = diagEl.textContent === "(No diagnostics yet)" ? pretty(browserDiagnostics()) : diagEl.textContent;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`paraconnect-diagnostics-${stamp}.txt`, current);
  });

  el.querySelector('[data-act="email"]').addEventListener("click", async () => {
    const current = diagEl.textContent === "(No diagnostics yet)" ? pretty(browserDiagnostics()) : diagEl.textContent;
    const subject = encodeURIComponent("ParaConnect Support Request");
    const body = encodeURIComponent(
`Hi ParaConnect Support,

I need help with: <describe the issue>

Diagnostics:
${current}

Thanks!`
    );
    location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
  });

  el.querySelector('[data-act="cache"]').addEventListener("click", () => {
    if (!confirm("This will clear local data for this site (e.g., cached UI state). Continue?")) return;
    try {
      localStorage.clear();
      sessionStorage.clear();
      alert("Local cache cleared. Reloading…");
      location.reload();
    } catch {
      alert("Could not clear cache automatically.");
    }
  });
}
