// frontend/assets/scripts/views/documents.js
// Case documents: list, upload (S3 presign), attach to case, and download via signed URL.
// Designed to work even if some backend endpoints are missing by probing and gracefully degrading.

const API_CASE      = (id) => `/api/cases/${encodeURIComponent(id)}`;
const API_PRESIGN   = "/api/uploads/presign";

// We will *probe* these optional endpoints at runtime:
const CANDIDATE_ATTACH_ENDPOINTS = [
  // Preferred: attach via cases route
  (caseId) => ({ url: `/api/cases/${encodeURIComponent(caseId)}/files`, method: "POST", shape: "cases-files" }),
  // Legacy: generic uploads attach
  (_caseId) => ({ url: `/api/uploads/attach`, method: "POST", shape: "uploads-attach" }),
];

const CANDIDATE_SIGNGET_ENDPOINTS = [
  (caseId, key) => `/api/uploads/signed-get?caseId=${encodeURIComponent(caseId)}&key=${encodeURIComponent(key)}`,
  (caseId, key) => `/api/cases/${encodeURIComponent(caseId)}/files/signed-get?key=${encodeURIComponent(key)}`
];

const CANDIDATE_DELETE_ENDPOINTS = [
  (caseId) => ({ url: `/api/cases/${encodeURIComponent(caseId)}/files`, method: "DELETE", shape: "cases-files" }),
  (_caseId) => ({ url: `/api/uploads/attach`, method: "DELETE", shape: "uploads-attach" }),
];

let CSRF = null;
async function getCSRF() {
  if (CSRF) return CSRF;
  const r = await fetch("/api/csrf", { credentials: "include" });
  const j = await r.json().catch(() => ({}));
  CSRF = j.csrfToken;
  return CSRF;
}

function ensureStylesOnce() {
  if (document.getElementById("pc-docs-styles")) return;
  const s = document.createElement("style");
  s.id = "pc-docs-styles";
  s.textContent = `
  .docs-wrap{display:grid;gap:16px}
  .docs-toolbar,.docs-form{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
  .docs-toolbar input,.docs-form input,.docs-form select,.docs-form button{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px}
  .docs-form button{background:#111827;color:#fff;border-color:#111827;cursor:pointer}
  .docs-list{display:grid;gap:8px}
  .doc-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff}
  .doc-name{font-weight:600;word-break:break-all}
  .muted{color:#6b7280}
  .btn{padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .danger{border-color:#ef4444;color:#ef4444}
  .chip{font-size:12px;border:1px solid #e5e7eb;border-radius:999px;padding:2px 8px;background:#f9fafb}
  .row-meta{display:flex;gap:8px;flex-wrap:wrap;color:#6b7280}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .drop{border:2px dashed #d1d5db;border-radius:12px;padding:14px;display:flex;gap:10px;align-items:center;justify-content:space-between;background:#fafafa}
  .drop.drag{background:#eef2ff;border-color:#6366f1}
  .queue{display:grid;gap:8px}
  .q-item{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;border:1px dashed #d1d5db;border-radius:10px;padding:8px;background:#fff}
  .progress{height:6px;background:#e5e7eb;border-radius:999px;overflow:hidden}
  .progress > span{display:block;height:100%;background:#111827;width:0%}
  .toast{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;border-radius:8px;padding:10px 14px;font-size:14px;box-shadow:0 10px 20px rgba(0,0,0,.15);z-index:9999}
  `;
  document.head.appendChild(s);
}

function extFromName(name) {
  const i = String(name).lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
function formatBytes(n=0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024**2) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024**3) return `${(n/1024**2).toFixed(1)} MB`;
  return `${(n/1024**3).toFixed(1)} GB`;
}

// --- tiny toast ---
let toastT;
function toast(msg) {
  clearTimeout(toastT);
  let el = document.getElementById("pc-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "pc-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  toastT = setTimeout(() => (el.style.display = "none"), 2500);
}

// ---------- API helpers ----------
async function fetchCase(caseId) {
  const r = await fetch(API_CASE(caseId), { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load case");
  return r.json(); // expect { files: [...] }
}

async function presign({ contentType, ext, folder }) {
  const r = await fetch(API_PRESIGN, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType, ext, folder })
  });
  if (!r.ok) throw new Error("Failed to presign");
  return r.json(); // { url, key }
}

// We probe which attach endpoint works the first time we need it.
let attachProbe = null;
async function attachToCase({ caseId, key, original }) {
  if (!attachProbe) {
    attachProbe = (async () => {
      for (const make of CANDIDATE_ATTACH_ENDPOINTS) {
        const cand = make(caseId);
        try {
          // Probe with OPTIONS or a harmless POST that we immediately expect 4xx/2xx?
          // We'll do a HEAD-ish probe via a small POST to see if endpoint exists:
          const res = await fetch(cand.url, {
            method: cand.method,
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": await getCSRF() },
            body: JSON.stringify({ __probe: true })
          });
          if (res.status === 400 || res.status === 200 || res.status === 422) {
            return cand; // exists
          }
        } catch {}
      }
      return null;
    })();
  }
  const endpoint = await attachProbe;
  // If we couldn't discover, still *attempt* both in order.
  const tries = endpoint ? [endpoint] : CANDIDATE_ATTACH_ENDPOINTS.map(f => f(caseId));

  for (const cand of tries) {
    try {
      const body =
        cand.shape === "cases-files"
          ? { key, original } // POST /api/cases/:id/files
          : { caseId, key, original }; // POST /api/uploads/attach
      const r = await fetch(cand.url, {
        method: cand.method,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": await getCSRF() },
        body: JSON.stringify(body)
      });
      if (r.ok) return true;
    } catch {}
  }
  throw new Error("Attach endpoint not available");
}

async function signedGet({ caseId, key }) {
  // Try candidates in order; return first that works
  for (const make of CANDIDATE_SIGNGET_ENDPOINTS) {
    const url = make(caseId, key);
    try {
      const r = await fetch(url, { credentials: "include" });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j && j.url) return j.url;
      }
    } catch {}
  }
  throw new Error("Signed download not available");
}

async function deleteFile({ caseId, key }) {
  // Try multiple delete shapes
  for (const make of CANDIDATE_DELETE_ENDPOINTS) {
    const cand = make(caseId);
    try {
      const body =
        cand.shape === "cases-files"
          ? { key }
          : { caseId, key };
      const r = await fetch(cand.url, {
        method: cand.method,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": await getCSRF() },
        body: JSON.stringify(body)
      });
      if (r.ok) return true;
    } catch {}
  }
  // If nothing worked, signal failure
  throw new Error("Delete endpoint not available");
}

// ------------- View -------------
export async function render(el) {
  ensureStylesOnce();

  el.innerHTML = `
    <div class="section docs-wrap">
      <div class="section-title">Documents</div>

      <div class="docs-toolbar">
        <input type="text" name="caseId" placeholder="Enter Case ID (24 chars)">
        <button class="btn" data-act="load">Load</button>
        <input type="search" name="q" placeholder="Filter by name/type…" style="margin-left:auto;min-width:220px">
      </div>

      <div class="drop" aria-label="Upload area">
        <div>
          <div style="font-weight:600">Upload files</div>
          <div class="muted">Drag & drop PDF/PNG/JPEG here, or choose…</div>
        </div>
        <div>
          <input type="file" id="filepick" multiple accept=".pdf,.png,.jpg,.jpeg" style="display:none">
          <button class="btn" data-act="pick">Choose Files</button>
        </div>
      </div>

      <div class="queue" aria-live="polite"></div>

      <div class="docs-list" aria-live="polite"></div>
    </div>
  `;

  const toolbar = el.querySelector(".docs-toolbar");
  const listEl = el.querySelector(".docs-list");
  const dropEl = el.querySelector(".drop");
  const queueEl = el.querySelector(".queue");
  const filePick = el.querySelector("#filepick");

  const caseInput = toolbar.querySelector('input[name="caseId"]');
  const qInput = toolbar.querySelector('input[name="q"]');

  const allowed = new Set(["application/pdf", "image/png", "image/jpeg"]);

  let currentCaseId = "";
  let allFiles = []; // as returned by case.files
  let downloadingEnabled = true; // we’ll flip to false if signed-get not available

  toolbar.querySelector('[data-act="load"]').addEventListener("click", loadCase);
  toolbar.querySelector('[name="q"]').addEventListener("input", () => drawFiles(allFiles, qInput.value));

  el.querySelector('[data-act="pick"]').addEventListener("click", () => filePick.click());
  filePick.addEventListener("change", () => handleFiles(filePick.files));

  // Drag&drop
  dropEl.addEventListener("dragover", (e) => {
    e.preventDefault(); dropEl.classList.add("drag");
  });
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("drag"));
  dropEl.addEventListener("drop", (e) => {
    e.preventDefault(); dropEl.classList.remove("drag");
    const files = e.dataTransfer?.files;
    if (files && files.length) handleFiles(files);
  });

  async function loadCase() {
    const id = (caseInput.value || "").trim();
    if (!id) {
      listEl.innerHTML = `<div class="muted">Enter a Case ID to view files.</div>`;
      return;
    }
    currentCaseId = id;
    try {
      const c = await fetchCase(id);
      allFiles = Array.isArray(c.files) ? c.files : [];
      if (!allFiles.length) {
        listEl.innerHTML = `<div class="muted">No files yet.</div>`;
      } else {
        drawFiles(allFiles, qInput.value);
      }
    } catch (e) {
      allFiles = [];
      listEl.innerHTML = `<div class="muted">Could not load case or you lack access.</div>`;
    }
  }

  function drawFiles(files, query = "") {
    const q = String(query || "").trim().toLowerCase();
    const list = q
      ? files.filter(f => (f.original || f.filename || "").toLowerCase().includes(q) ||
                          (extFromName(f.original || f.filename || "")).includes(q))
      : files.slice();

    listEl.innerHTML = "";
    if (!list.length) {
      listEl.innerHTML = `<div class="muted">No matching files.</div>`;
      return;
    }

    for (const f of list) {
      const row = document.createElement("div");
      row.className = "doc-row";

      const left = document.createElement("div");
      left.style.minWidth = 0;

      const name = document.createElement("div");
      name.className = "doc-name";
      name.textContent = f.original || f.filename || f.key || "(unnamed)";
      left.appendChild(name);

      const meta = document.createElement("div");
      meta.className = "row-meta";

      const ext = extFromName(f.original || f.filename || "");
      const typeChip = document.createElement("span");
      typeChip.className = "chip";
      typeChip.textContent = ext ? ext.toUpperCase() : (f.mime || "FILE");
      meta.appendChild(typeChip);

      if (typeof f.size === "number") {
        const sizeChip = document.createElement("span");
        sizeChip.className = "chip";
        sizeChip.textContent = formatBytes(f.size);
        meta.appendChild(sizeChip);
      }

      if (f.createdAt) {
        const when = new Date(f.createdAt);
        const timeChip = document.createElement("span");
        timeChip.className = "chip";
        timeChip.textContent = when.toLocaleString();
        meta.appendChild(timeChip);
      }

      left.appendChild(meta);

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "btn";
      downloadBtn.textContent = "Download";
      downloadBtn.addEventListener("click", async () => {
        if (!currentCaseId) return;
        const key = f.key || f.filename; // support either field name
        if (!key) return;
        try {
          const url = await signedGet({ caseId: currentCaseId, key });
          window.open(url, "_blank", "noopener");
        } catch {
          downloadingEnabled = false;
          toast("Download not available (no signed-get endpoint).");
        }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "btn danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (!confirm("Delete this file from the case?")) return;
        const key = f.key || f.filename;
        if (!key) return;

        const prev = allFiles.slice();
        // optimistic
        allFiles = allFiles.filter(x => (x.key || x.filename) !== key);
        drawFiles(allFiles, qInput.value);

        try {
          await deleteFile({ caseId: currentCaseId, key });
          toast("File deleted");
        } catch {
          allFiles = prev;
          drawFiles(allFiles, qInput.value);
          toast("Delete failed (no endpoint?)");
        }
      });

      row.appendChild(left);
      row.appendChild(downloadBtn);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }

  async function handleFiles(fileList) {
    if (!currentCaseId) {
      toast("Load a Case ID first.");
      return;
    }
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files) {
      if (!allowed.has(file.type)) {
        toast(`Type not allowed: ${file.name}`);
        continue;
      }
      await uploadOne(file).catch((e) => {
        console.error(e);
        toast(`Failed: ${file.name}`);
      });
    }
    // refresh list at the end
    await loadCase();
  }

  function makeQueueItem(label) {
    const row = document.createElement("div");
    row.className = "q-item";
    const left = document.createElement("div");
    left.textContent = label;
    const prog = document.createElement("div");
    prog.className = "progress";
    const bar = document.createElement("span");
    prog.appendChild(bar);
    row.appendChild(left);
    row.appendChild(prog);
    queueEl.appendChild(row);
    return {
      set(pct) { bar.style.width = `${Math.max(0, Math.min(100, pct))}%`; },
      done() { row.remove(); }
    };
  }

  async function uploadOne(file) {
    const ext = extFromName(file.name) || (file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : "jpg");
    const folder = "case-files";
    const qi = makeQueueItem(`${file.name} — ${formatBytes(file.size)}`);

    // 1) presign
    const { url, key } = await presign({ contentType: file.type, ext, folder });

    // 2) PUT to S3 with progress (fetch has no progress; use XHR for progress)
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) qi.set((e.loaded / e.total) * 100);
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("S3 upload failed")));
      xhr.onerror = () => reject(new Error("S3 upload error"));
      xhr.send(file);
    });

    // 3) attach to case (store { key, original })
    try {
      await attachToCase({ caseId: currentCaseId, key, original: file.name });
    } catch (e) {
      console.error(e);
      toast("Uploaded to storage, but attach endpoint is missing.");
    }

    qi.done();
  }

  // initial empty state
  listEl.innerHTML = `<div class="muted">Enter a Case ID to view files.</div>`;
}
