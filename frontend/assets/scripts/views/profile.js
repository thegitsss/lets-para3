// frontend/assets/scripts/views/profile.js
// Backend-aligned profile editor (Express/Mongo + S3 presign). No Supabase / localStorage.

import { j } from "../helpers.js";

export async function render(el) {
  ensureStylesOnce();
  el.innerHTML = skeleton();

  try {
    const me = await j("/api/users/me");
    draw(el, me);
    wire(el, me);
  } catch (e) {
    el.innerHTML = `
      <div class="section">
        <div class="section-title">My Profile</div>
        <div class="err">Couldn’t load your profile. Please refresh.</div>
      </div>`;
  }
}

/* -------------------------- render + wire -------------------------- */

function draw(root, me) {
  const h = escapeHtml;
  const role = me.role || "attorney";

  const resumeRow = role === "paralegal" ? `
    <div class="field col-span-2">
      <label>Resume (PDF)</label>
      <div class="row">
        <input type="file" id="resumeInput" accept="application/pdf">
        <button type="button" class="btn secondary" id="uploadResume">Upload</button>
        ${me.resumeURL ? `<span class="hint">Uploaded (private)</span>` : `<span class="hint">No resume uploaded</span>`}
      </div>
      ${me.resumeURL ? `<div class="tiny">Stored key: <code>${h(me.resumeURL)}</code></div>` : ""}
    </div>` : "";

  const certRow = role === "paralegal" ? `
    <div class="field col-span-2">
      <label>Certificate (PDF)</label>
      <div class="row">
        <input type="file" id="certInput" accept="application/pdf">
        <button type="button" class="btn secondary" id="uploadCert">Upload</button>
        ${me.certificateURL ? `<span class="hint">Uploaded (private)</span>` : `<span class="hint">No certificate uploaded</span>`}
      </div>
      ${me.certificateURL ? `<div class="tiny">Stored key: <code>${h(me.certificateURL)}</code></div>` : ""}
    </div>` : "";

  const barRow = role === "attorney" ? `
    <div class="field">
      <label>Bar Number</label>
      <input id="pfBar" value="${h(me.barNumber || "")}" placeholder="e.g., CA 123456">
    </div>` : "";

  root.innerHTML = `
    <div class="section">
      <div class="section-title">My Profile</div>

      <div class="profile-wrap">
        <div class="profile-card">
          <div class="avatar" aria-hidden="true">${initials(me.name)}</div>
          <div style="margin-top:1rem;">
            <div><strong>${h(me.name || "")}</strong></div>
            <div class="hint">${h(me.email || "")}</div>
            <div class="hint" style="text-transform:capitalize;">${h(role)}</div>
          </div>
        </div>

        <div class="profile-card">
          <form id="profileForm" class="profile-grid">
            <div class="field col-span-2">
              <label>Bio</label>
              <textarea id="pfBio" maxlength="4000" placeholder="Short professional bio (shown on your profile)">${h(me.bio || "")}</textarea>
            </div>

            <div class="field">
              <label>Available for work</label>
              <label class="switch">
                <input type="checkbox" id="pfAvail" ${isAvailable(me.availability) ? "checked" : ""}>
                <span class="slider"></span>
              </label>
            </div>

            ${barRow}
            ${resumeRow}
            ${certRow}

            <div class="profile-actions col-span-2">
              <span id="saveStatus" class="hint"></span>
              <button type="button" class="btn secondary" id="resetProfile">Reset</button>
              <button type="submit" class="btn" id="saveProfile">Save Profile</button>
            </div>
          </form>
        </div>
      </div>

      <div class="tiny muted" style="margin-top:8px;">
        Files are uploaded privately to secure storage. A temporary download link will be available in a future update.
      </div>
    </div>
  `;
}

function wire(root, me) {
  const form = root.querySelector("#profileForm");
  const bioEl = root.querySelector("#pfBio");
  const availEl = root.querySelector("#pfAvail");
  const barEl = root.querySelector("#pfBar");
  const saveStatus = root.querySelector("#saveStatus");

  // Reset (reload from server)
  root.querySelector("#resetProfile")?.addEventListener("click", async () => {
    await render(root);
  });

  // Save profile
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const payload = {
      bio: (bioEl.value || "").trim(),
      availability: availEl.checked ? "Available Now" : "Unavailable",
    };
    // Paralegals: resumeURL / certificateURL are ONLY patched by upload handlers (avoid accidental clearing).
    if (me.role === "attorney") {
      payload.barNumber = (barEl?.value || "").trim();
    }

    try {
      saveStatus.textContent = "Saving…";
      await patchMe(payload);
      saveStatus.textContent = "Saved";
      saveStatus.classList.add("ok");
      setTimeout(() => { saveStatus.textContent = ""; saveStatus.classList.remove("ok"); }, 1400);
    } catch {
      saveStatus.textContent = "Save failed";
      saveStatus.classList.add("err");
      setTimeout(() => { saveStatus.textContent = ""; saveStatus.classList.remove("err"); }, 2000);
    }
  });

  // Uploads (paralegal)
  root.querySelector("#uploadResume")?.addEventListener("click", async () => {
    const input = root.querySelector("#resumeInput");
    const file = input?.files?.[0];
    if (!file) return alert("Select a PDF first.");
    if (file.type !== "application/pdf") return alert("Please select a PDF file.");
    if (file.size > 10 * 1024 * 1024) return alert("File is larger than 10 MB.");
    try {
      const key = await presignedUpload(file, "resumes");
      me.resumeURL = key;                   // store S3 key on user
      await patchMe({ resumeURL: key });    // persist
      input.value = "";
      await render(root);                   // refresh UI
    } catch (e) {
      alert(e?.message || "Resume upload failed.");
    }
  });

  root.querySelector("#uploadCert")?.addEventListener("click", async () => {
    const input = root.querySelector("#certInput");
    const file = input?.files?.[0];
    if (!file) return alert("Select a PDF first.");
    if (file.type !== "application/pdf") return alert("Please select a PDF file.");
    if (file.size > 10 * 1024 * 1024) return alert("File is larger than 10 MB.");
    try {
      const key = await presignedUpload(file, "certificates");
      me.certificateURL = key;
      await patchMe({ certificateURL: key });
      input.value = "";
      await render(root);
    } catch (e) {
      alert(e?.message || "Certificate upload failed.");
    }
  });
}

/* -------------------------- data helpers -------------------------- */

async function patchMe(fields) {
  await j("/api/users/me", { method: "PATCH", body: fields });
}

/**
 * Upload a file via your /api/uploads/presign → PUT signed URL flow.
 * Returns the S3 object key (string) to save on the user profile.
 */
async function presignedUpload(file, folder) {
  if (!(file && file.type)) throw new Error("file missing");
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();

  // 1) Ask backend for a signed PUT URL (private ACL)
  let url, key;
  try {
    ({ url, key } = await j("/api/uploads/presign", {
      method: "POST",
      body: { contentType: file.type, ext, folder },
    }));
  } catch {
    throw new Error("Could not get an upload link. Please try again.");
  }

  if (!url || !key) throw new Error("Could not get an upload link. Please try again.");

  // 2) Upload directly to S3 with the signed URL
  const put = await fetch(url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
  if (!put.ok) throw new Error("Upload to storage failed. Please retry within 60 seconds.");

  // 3) Return the private object key (store on user)
  return key;
}

function isAvailable(value) {
  if (typeof value === "string") return /available|open/i.test(value);
  return !!value;
}

/* -------------------------- UI helpers --------------------------- */

function ensureStylesOnce() {
  if (document.getElementById("prof-styles")) return;
  const s = document.createElement("style");
  s.id = "prof-styles";
  s.textContent = `
  .profile-wrap{display:grid;gap:16px}
  @media(min-width:960px){.profile-wrap{grid-template-columns:280px 1fr}}
  .profile-card{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:14px}
  .profile-grid{display:grid;gap:12px;grid-template-columns:1fr 1fr}
  .col-span-2{grid-column:1 / -1}
  .field label{display:block;font-weight:600;margin-bottom:6px}
  .field input[type="text"], .field input[type="url"], .field input[type="number"], .field textarea{
    width:100%;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;background:#fff
  }
  textarea{min-height:120px;resize:vertical}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .btn.secondary{background:#f8fafc}
  .hint{color:#6b7280}
  .tiny{font-size:.8rem}
  .muted{color:#6b7280}
  .err{color:#b91c1c}
  .ok{color:#065f46}
  .avatar{
    width:120px;height:120px;border-radius:50%;background:#111827;color:#fff;
    display:flex;align-items:center;justify-content:center;font-weight:700;font-size:36px
  }
  /* Toggle switch */
  .switch{position:relative;display:inline-block;width:48px;height:28px}
  .switch input{opacity:0;width:0;height:0}
  .slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#e5e7eb;transition:.2s;border-radius:999px}
  .slider:before{position:absolute;content:"";height:22px;width:22px;left:3px;top:3px;background:#fff;transition:.2s;border-radius:50%}
  input:checked + .slider{background:#111827}
  input:checked + .slider:before{transform:translateX(20px)}
  /* Skeleton */
  .skeleton .line{height:14px;background:#f3f4f6;border-radius:6px;animation:sh 1.2s infinite}
  @keyframes sh{0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}
  `;
  document.head.appendChild(s);
}

function skeleton() {
  return `
  <div class="section skeleton">
    <div class="section-title">My Profile</div>
    <div class="profile-wrap">
      <div class="profile-card">
        <div class="line" style="width:120px;height:120px;border-radius:60px"></div>
        <div class="line" style="width:80%;margin-top:10px"></div>
        <div class="line" style="width:60%;margin-top:6px"></div>
      </div>
      <div class="profile-card">
        <div class="line" style="width:90%"></div>
        <div class="line" style="width:90%;margin-top:8px"></div>
        <div class="line" style="width:90%;margin-top:8px"></div>
      </div>
    </div>
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c] || c));
}

function initials(name = "") {
  const parts = String(name).trim().split(/\s+/).slice(0,2);
  return parts.map(p => p[0]?.toUpperCase() || "").join("") || "U";
}
