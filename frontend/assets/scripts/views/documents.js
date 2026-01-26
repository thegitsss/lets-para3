// frontend/assets/scripts/views/documents.js
// Case documents: list, upload, and download via CaseFile endpoints.

const API_CASE = (id) => `/api/cases/${encodeURIComponent(id)}`;
const API_CASE_FILES = (id) => `/api/uploads/case/${encodeURIComponent(id)}`;
const API_CASE_FILE_DOWNLOAD = (caseId, fileId) =>
  `/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(fileId)}/download`;
const FIELD_FALLBACK = "—";
const FUNDED_WORKSPACE_STATUSES = new Set([
  "funded_in_progress",
  "in progress",
  "in_progress",
  "active",
  "awaiting_documents",
  "reviewing",
]);

let CSRF = null;
async function getCSRF() {
  if (CSRF) return CSRF;
  const r = await fetch("/api/csrf", { credentials: "include" });
  const j = await r.json().catch(() => ({}));
  CSRF = j.csrfToken;
  return CSRF;
}

async function ensureDocsSession(expectedRole) {
  if (typeof window.refreshSession !== "function") return true;
  const session = await window.refreshSession(expectedRole);
  if (!session) {
    try {
      window.location.href = "login.html";
    } catch {}
    return false;
  }
  return true;
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
  .chip{font-size:12px;border:1px solid #e5e7eb;border-radius:999px;padding:2px 8px;background:#f9fafb}
  .row-meta{display:flex;gap:8px;flex-wrap:wrap;color:#6b7280}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .drop{border:2px dashed #d1d5db;border-radius:12px;padding:14px;display:flex;gap:10px;align-items:center;justify-content:space-between;background:#fafafa}
  .drop.locked{opacity:.6;cursor:not-allowed}
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
function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function sanitizeDocText(value) {
  const text = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return text || FIELD_FALLBACK;
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
async function fetchCaseMeta(caseId) {
  const r = await fetch(API_CASE(caseId), { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load case");
  return r.json();
}

async function fetchCaseFiles(caseId) {
  const r = await fetch(API_CASE_FILES(caseId), { credentials: "include" });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = payload?.msg || payload?.error || payload?.message || "Failed to load files";
    throw new Error(message);
  }
  return Array.isArray(payload.files) ? payload.files : [];
}

async function uploadCaseFile({ caseId, file, onProgress } = {}) {
  const active = await ensureDocsSession();
  if (!active) throw new Error("Session expired");
  const token = await getCSRF();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API_CASE_FILES(caseId));
    xhr.withCredentials = true;
    if (token) xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      if (typeof onProgress === "function") {
        onProgress((event.loaded / event.total) * 100);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let errorMessage = `Upload failed (${xhr.status}).`;
      try {
        const parsed = JSON.parse(xhr.responseText || "{}");
        errorMessage = parsed?.msg || parsed?.error || parsed?.message || errorMessage;
      } catch {}
      reject(new Error(errorMessage));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
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
  const pickBtn = el.querySelector('[data-act="pick"]');
  const pickDefaultText = pickBtn?.textContent || "Choose Files";

  const caseInput = toolbar.querySelector('input[name="caseId"]');
  const qInput = toolbar.querySelector('input[name="q"]');

  const allowed = new Set(["application/pdf", "image/png", "image/jpeg"]);

  let currentCaseId = "";
  let currentCaseReadOnly = false;
  let currentCaseWorkspaceLocked = false;
  let currentCaseLockReason = "";
  let allFiles = [];
  const canDelete = (() => {
    try {
      const raw = localStorage.getItem("lpc_user");
      if (!raw) return false;
      const user = JSON.parse(raw);
      const role = String(user?.role || "").toLowerCase();
      return role === "attorney" || role === "admin";
    } catch {
      return false;
    }
  })();

  toolbar.querySelector('[data-act="load"]').addEventListener("click", loadCase);
  toolbar.querySelector('[name="q"]').addEventListener("input", () => drawFiles(allFiles, qInput.value));

  el.querySelector('[data-act="pick"]').addEventListener("click", () => filePick.click());
  filePick.addEventListener("change", () => handleFiles(filePick.files));

  // Drag&drop
  dropEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropEl.classList.add("drag");
  });
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("drag"));
  dropEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("drag");
    const files = e.dataTransfer?.files;
    if (files && files.length) handleFiles(files);
  });

  function applyLockedState() {
    const locked = currentCaseReadOnly || currentCaseWorkspaceLocked;
    if (pickBtn) {
      pickBtn.disabled = locked;
      pickBtn.textContent = locked ? "Uploads locked" : pickDefaultText;
    }
    dropEl.classList.toggle("locked", locked);
    const note = dropEl.querySelector(".muted");
    if (note) {
      note.textContent = locked
        ? currentCaseLockReason || "Uploads are locked for this case."
        : "Drag & drop PDF/PNG/JPEG here, or choose…";
    }
  }

  async function loadCase() {
    const id = (caseInput.value || "").trim();
    if (!id) {
      listEl.innerHTML = `<div class="muted">Enter a Case ID to view files.</div>`;
      return;
    }
    currentCaseId = id;
    try {
      const caseData = await fetchCaseMeta(id);
      currentCaseReadOnly = !!caseData.readOnly;
      currentCaseWorkspaceLocked = !canUseWorkspace(caseData);
      currentCaseLockReason = currentCaseReadOnly
        ? "This case is read-only. Uploads are disabled."
        : "Uploads unlock once the case is funded and in progress.";
      applyLockedState();

      allFiles = await fetchCaseFiles(id);
      if (!allFiles.length) {
        listEl.innerHTML = `<div class="muted">No files yet.</div>`;
      } else {
        drawFiles(allFiles, qInput.value);
      }
    } catch (e) {
      allFiles = [];
      currentCaseReadOnly = false;
      currentCaseWorkspaceLocked = false;
      currentCaseLockReason = "";
      applyLockedState();
      listEl.innerHTML = `<div class="muted">${sanitizeDocText(e?.message || "Could not load case or you lack access.")}</div>`;
    }
  }

  function drawFiles(files, query = "") {
    const q = String(query || "").trim().toLowerCase();
    const list = q
      ? files.filter((f) => (f.originalName || "").toLowerCase().includes(q) || extFromName(f.originalName || "").includes(q))
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
      name.textContent = sanitizeDocText(f.originalName || f.storageKey || FIELD_FALLBACK);
      left.appendChild(name);

      const meta = document.createElement("div");
      meta.className = "row-meta";

      const ext = extFromName(f.originalName || "");
      const typeChip = document.createElement("span");
      typeChip.className = "chip";
      typeChip.textContent = ext ? ext.toUpperCase() : (f.mimeType || "FILE");
      meta.appendChild(typeChip);

      if (typeof f.size === "number") {
        const sizeChip = document.createElement("span");
        sizeChip.className = "chip";
        sizeChip.textContent = formatBytes(f.size);
        meta.appendChild(sizeChip);
      }

      const when = f.createdAt ? new Date(f.createdAt).toLocaleString() : FIELD_FALLBACK;
      const timeChip = document.createElement("span");
      timeChip.className = "chip";
      timeChip.textContent = when;
      meta.appendChild(timeChip);

      left.appendChild(meta);

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "btn";
      downloadBtn.textContent = "Download";
      downloadBtn.addEventListener("click", () => {
        if (!currentCaseId) return;
        const fileId = f.id || f._id;
        if (!fileId) {
          toast("Download unavailable for this file.");
          return;
        }
        const url = API_CASE_FILE_DOWNLOAD(currentCaseId, fileId);
        window.open(url, "_blank", "noopener");
      });

      row.appendChild(left);
      row.appendChild(downloadBtn);
      if (canDelete && !currentCaseReadOnly && !currentCaseWorkspaceLocked) {
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn danger";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => {
          const fileId = f.id || f._id;
          if (!fileId || !currentCaseId) return;
          if (!confirm("Delete this file from the case?")) return;
          const prev = allFiles.slice();
          allFiles = allFiles.filter((entry) => String(entry.id || entry._id) !== String(fileId));
          drawFiles(allFiles, qInput.value);
          try {
            await deleteCaseFile({ caseId: currentCaseId, fileId });
            toast("File deleted");
          } catch (err) {
            allFiles = prev;
            drawFiles(allFiles, qInput.value);
            toast(err?.message || "Delete failed.");
          }
        });
        row.appendChild(deleteBtn);
      }
      listEl.appendChild(row);
    }
  }

  async function handleFiles(fileList) {
    if (!currentCaseId) {
      toast("Load a Case ID first.");
      return;
    }
    if (currentCaseReadOnly || currentCaseWorkspaceLocked) {
      toast(currentCaseLockReason || "Uploads are locked for this case.");
      return;
    }
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (pickBtn) {
      pickBtn.disabled = true;
      pickBtn.textContent = "Uploading…";
    }
    try {
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
      await loadCase();
    } finally {
      if (pickBtn) {
        pickBtn.disabled = false;
        pickBtn.textContent = pickDefaultText;
      }
    }
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
      set(pct) {
        bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      },
      done() {
        row.remove();
      },
    };
  }

  async function uploadOne(file) {
    const qi = makeQueueItem(`${file.name} — ${formatBytes(file.size)}`);
    await uploadCaseFile({
      caseId: currentCaseId,
      file,
      onProgress: (pct) => qi.set(pct),
    });
    qi.done();
  }

  async function deleteCaseFile({ caseId, fileId } = {}) {
    const active = await ensureDocsSession();
    if (!active) throw new Error("Session expired");
    const token = await getCSRF();
    const res = await fetch(
      `/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        credentials: "include",
        headers: token ? { "X-CSRF-Token": token } : undefined,
      }
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.msg || payload?.error || "Delete failed");
    }
    return payload;
  }

  // initial empty state
  listEl.innerHTML = `<div class="muted">Enter a Case ID to view files.</div>`;
}

function normalizeCaseStatus(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "in_progress") return "in progress";
  return lower;
}

function canUseWorkspace(caseData) {
  const status = normalizeCaseStatus(caseData?.status);
  const hasParalegal = !!(caseData?.paralegal || caseData?.paralegalId);
  const escrowFunded =
    !!caseData?.escrowIntentId && String(caseData?.escrowStatus || "").toLowerCase() === "funded";
  return hasParalegal && escrowFunded && FUNDED_WORKSPACE_STATUSES.has(status);
}
