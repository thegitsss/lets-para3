import { LpcApiError } from "./api-client.mjs";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const POLL_INTERVAL_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;
const SECURITY_RECHECK_DELAYS_MS = Object.freeze([1_000, 3_000, 8_000, 15_000]);
const MAX_AUTOMATIC_SECURITY_CHECKS = 5;
export const ACCEPTED_FILE_TYPES = [
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".txt", ".csv", ".png", ".jpg", ".jpeg", ".gif",
].join(",");

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach((child) => {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}

function filesFrom(result) {
  return Array.isArray(result?.files) ? result.files : [];
}

function fileStateFingerprint(result) {
  return JSON.stringify(filesFrom(result).map((file) => ({
    id: fileId(file),
    status: String(file?.status || ""),
    version: Number(file?.version || 0),
    revisionRequestedAt: String(file?.revisionRequestedAt || ""),
    revisionOfFileId: String(file?.revisionOfFileId || ""),
    revisionRequestAt: String(file?.revisionRequestAt || ""),
    revisionResolution: file?.revisionResolution || null,
    approvedAt: String(file?.approvedAt || ""),
    securityStatus: String(file?.securityStatus || ""),
  })));
}

function fileId(file) {
  return String(file?.id || file?._id || "");
}

function fileName(file) {
  return String(file?.originalName || file?.original || file?.filename || "Matter file");
}

export function filePreviewable(file) {
  const mimeType = String(file?.mimeType || file?.mime || "").toLowerCase();
  return ["application/pdf", "image/png", "image/jpeg", "image/gif", "text/plain", "text/csv"].includes(mimeType);
}

export function fileHref(matterId, id, { preview = false } = {}) {
  const path = `/api/uploads/case/${encodeURIComponent(matterId)}/${encodeURIComponent(id)}/download`;
  return preview ? `${path}?preview=true` : path;
}

function bytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return "Size unavailable";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function dateLabel(value) {
  if (!value) return "Date unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Date unavailable";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function titleCase(value, fallback = "Shared") {
  const text = String(value || "").trim().replace(/_/g, " ");
  return text ? text.replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
}

function createClientUploadId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function submissionPresentation(file, { historical = false } = {}) {
  const status = String(file?.status || "pending_review").trim().toLowerCase();
  const uploadedByParalegal = String(file?.uploadedByRole || "").trim().toLowerCase() === "paralegal";
  if (!uploadedByParalegal) {
    return {
      status: historical ? "historical" : "shared",
      submitted: false,
      label: "",
      detail: Number(file?.version) > 1 ? `Version ${file.version}` : "",
    };
  }
  if (status === "approved") {
    return {
      status,
      submitted: true,
      label: "Approved",
      detail: file?.approvedAt ? dateLabel(file.approvedAt) : "",
    };
  }
  if (status === "attorney_revision" && file.revisionResolution) {
    return { status: "revision_resolved", submitted: true, label: "Revision resolved", detail: "The attorney approved the revised file." };
  }
  if (status === "attorney_revision") {
    return {
      status,
      submitted: true,
      label: "Revisions requested",
      detail: file?.revisionRequestedAt ? `Requested ${dateLabel(file.revisionRequestedAt)}` : "Updated work requested",
    };
  }
  return {
    status: "pending_review",
    submitted: true,
    label: "Submitted for review",
    detail: "",
  };
}

function securityPresentation(file, { historical = false } = {}) {
  if (historical) return { status: "historical", label: "Archived file", detail: "Read-only matter file", ready: false };
  const status = String(file?.securityStatus || "").trim().toLowerCase();
  if (status === "clean" || status === "not_required") {
    return { status, label: "Available", detail: "Security check complete", ready: true };
  }
  if (status === "blocked") {
    return { status, label: "Security check failed", detail: "Did not pass the security check", ready: false };
  }
  if (status === "error") {
    return { status, label: "Security check unavailable", detail: "Security check could not complete", ready: false };
  }
  return { status: "pending", label: "Security check in progress", detail: "Check again shortly", ready: false };
}

function setStatus(state, message, kind = "") {
  const status = state.panel.querySelector("[data-v2-file-status]");
  if (!status) return;
  status.textContent = String(message || "");
  if (kind) status.dataset.kind = kind;
  else delete status.dataset.kind;
}

function setUploadState(state, uploading) {
  state.uploading = uploading;
  updateSelectedFilesPresentation(state);
  const form = state.panel.querySelector("[data-v2-file-form]");
  const input = form?.querySelector("[data-v2-file-input]");
  const picker = form?.querySelector("[data-v2-file-picker]");
  const cancel = form?.querySelector("[data-v2-file-cancel]");
  const progress = form?.querySelector("[data-v2-file-progress-wrap]");
  if (form) form.setAttribute("aria-busy", String(uploading));
  if (input) input.disabled = uploading;
  if (picker) picker.setAttribute("aria-disabled", String(uploading));
  if (cancel) cancel.hidden = !uploading;
  if (progress) progress.hidden = !uploading;
}

function setUploadProgress(state, value) {
  const progress = state.panel.querySelector("[data-v2-file-progress]");
  const copy = state.panel.querySelector("[data-v2-file-progress-copy]");
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  if (progress) progress.value = safe;
  if (copy) copy.textContent = safe ? `${safe}% uploaded` : "Preparing upload";
}

function setRetryVisible(state, visible) {
  const retry = state.panel.querySelector("[data-v2-file-retry]");
  if (retry) retry.hidden = !visible;
  const submit = state.panel.querySelector("[data-v2-file-form] button[type='submit']");
  if (submit) submit.hidden = visible;
}

function selectedFilesLabel(entries = []) {
  if (!entries.length) return "";
  if (entries.length === 1) return "1 file selected";
  const failed = entries.filter((entry) => entry.status === "failed").length;
  return `${entries.length} files selected${failed ? ` · ${failed} ready to retry` : ""}`;
}

function rememberSelection(state) {
  if (state.selectedFiles.length) state.drafts.set(state.matterId, state.selectedFiles);
  else state.drafts.delete(state.matterId);
}

function selectionError(file) {
  if (file.size > MAX_FILE_BYTES) return "Larger than 20 MB. Remove this file before submitting.";
  const extension = `.${String(file.name).split(".").pop().toLowerCase()}`;
  return ACCEPTED_FILE_TYPES.split(",").includes(extension) ? "" : "Unsupported file type. Choose a PDF, Office, text, CSV, or image file.";
}

function addSelectedFiles(state, fileList) {
  const input = state.panel.querySelector("[data-v2-file-input]");
  const selected = state.panel.querySelector("[data-v2-file-selected]");
  const submit = state.panel.querySelector("[data-v2-file-form] button[type='submit']");
  const incoming = Array.from(fileList || []).filter((file) => file instanceof File);
  const existing = new Set(state.selectedFiles.map((entry) => `${entry.file.name}:${entry.file.size}:${entry.file.lastModified}:${entry.revisionOfFileId || ""}`));
  incoming.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}:${state.pendingRevision?.id || ""}`;
    if (existing.has(key)) return;
    existing.add(key);
    state.selectedFiles.push({
      file,
      clientUploadId: createClientUploadId(),
      revisionOfFileId: state.pendingRevision?.id || "",
      revisionOfVersion: state.pendingRevision?.version || null,
      revisionRequestAt: state.pendingRevision?.requestedAt || "",
      revisionName: state.pendingRevision?.name || "",
      status: "pending",
      progress: 0,
      error: selectionError(file),
      controller: null,
    });
  });
  state.pendingRevision = null;
  if (input) input.multiple = true;
  rememberSelection(state);
  if (input) input.value = "";
  if (selected) selected.textContent = selectedFilesLabel(state.selectedFiles);
  if (submit) {
    submit.disabled = state.uploading || !state.selectedFiles.length;
    submit.textContent = state.selectedFiles.length > 1 ? "Submit files" : "Submit file";
  }
  if (incoming.length) {
    setStatus(state, "");
    setRetryVisible(state, false);
  }
  updateSelectedFilesPresentation(state);
}

function updateSelectedFilesPresentation(state) {
  const selected = state.panel.querySelector("[data-v2-file-selected]");
  const submit = state.panel.querySelector("[data-v2-file-form] button[type='submit']");
  if (selected) {
    selected.textContent = selectedFilesLabel(state.selectedFiles);
    selected.hidden = !state.selectedFiles.length;
  }
  if (submit) {
    submit.disabled = state.uploading || !state.selectedFiles.length || state.selectedFiles.some((entry) => selectionError(entry.file));
    submit.textContent = state.uploading ? "Submitting…" : state.selectedFiles.length > 1 ? "Submit files" : "Submit file";
  }
  const list = state.panel.querySelector("[data-v2-file-selection-list]");
  if (list) {
    list.replaceChildren(...state.selectedFiles.map((entry) => {
      const remove = node("button", { type: "button", disabled: state.uploading, "aria-label": `Remove ${entry.file.name}`, text: "Remove" });
      remove.addEventListener("click", () => {
        if (state.uploading) return;
        state.selectedFiles = state.selectedFiles.filter((candidate) => candidate !== entry);
        setStatus(state, "");
        setRetryVisible(state, false);
        updateSelectedFilesPresentation(state);
      });
      return node("li", {}, [node("span", { text: entry.file.name }), node("small", { text: selectionError(entry.file) || entry.error || (entry.revisionOfFileId ? `Revision of ${entry.revisionName} · version ${entry.revisionOfVersion}. Ready to submit.` : "Ready to submit") }), remove]);
    }));
  }
  const clear = state.panel.querySelector("[data-v2-file-clear]");
  if (clear) { clear.hidden = !state.selectedFiles.length; clear.disabled = state.uploading; }
  rememberSelection(state);
  positionUploadForm(state);
}

// The existing form follows a single selected revision. Mixed/general uploads
// stay in the shared composer; entries retain their own authoritative linkage.
function positionUploadForm(state) {
  const form = state.panel.querySelector("[data-v2-file-form]");
  const slot = state.panel.querySelector("[data-v2-file-compose-slot]");
  if (!form || !slot) return;
  const sourceId = state.selectedFiles[0]?.revisionOfFileId;
  const source = sourceId && filesFrom(state.result).find(file => fileId(file) === sourceId);
  const singleRequest = source && !source.revisionResolution && state.selectedFiles.every(entry =>
    entry.revisionOfFileId === sourceId && entry.revisionRequestAt === String(source.revisionRequestedAt || ""));
  const target = singleRequest ? state.panel.querySelector(`[data-file-id="${CSS.escape(sourceId)}"]`) : null;
  const destination = target || slot;
  const focused = form.contains(document.activeElement) ? document.activeElement : null;
  if (form.parentElement !== destination) destination.append(form);
  if (target) form.setAttribute("data-v2-revision-composer", sourceId);
  else form.removeAttribute("data-v2-revision-composer");
  const picker = form.querySelector("[data-v2-file-picker]");
  if (picker) picker.textContent = target ? "Add other files" : "Choose files";
  if (focused?.isConnected) focused.focus({ preventScroll: true });
}

function renderFiles(state) {
  const content = state.panel.querySelector("[data-v2-file-content]");
  const count = state.panel.querySelector("[data-v2-file-count]");
  if (!content) return;
  const form = state.panel.querySelector("[data-v2-file-form]");
  const focused = form?.contains(document.activeElement) ? document.activeElement : null;
  // Preserve the form and selected File objects before replacing a refreshed row.
  const slot = state.panel.querySelector("[data-v2-file-compose-slot]");
  if (form && slot && content.contains(form)) slot.append(form);
  if (state.result?.unavailable) {
    if (count) count.textContent = "Unavailable";
    content.replaceChildren(node("div", { className: "v2-matter-locked" }, [
      node("strong", { text: "Files are unavailable" }),
      node("p", { text: state.result.message || "Files are not available for this matter right now." }),
    ]));
    positionUploadForm(state);
    return;
  }

  const files = filesFrom(state.result);
  if (count) count.textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
  if (!files.length) {
    content.replaceChildren(node("p", { className: "v2-matter-empty", text: "No files have been shared in this matter." }));
    positionUploadForm(state);
    return;
  }

  content.replaceChildren(node("div", { className: "v2-matter-file-list" }, files.map((file) => {
    const id = fileId(file);
    const highlighted = Boolean(id && id === state.highlightedFileId);
    const security = securityPresentation(file, { historical: state.historical });
    const submission = submissionPresentation(file, { historical: state.historical });
    const action = security.ready
      ? node("div", { className: "v2-matter-file-actions" }, [
          filePreviewable(file) ? node("a", {
            className: "v2-matter-file-action is-secondary",
            href: fileHref(state.matterId, id, { preview: true }),
            target: "_blank",
            rel: "noopener",
            text: "Open",
          }) : null,
          node("button", {
            className: "v2-matter-file-action",
            type: "button",
            "data-v2-file-download": id,
            text: "Download",
          }),
        ])
      : ["pending", "error"].includes(security.status) && !state.historical
        ? node("button", {
            className: "v2-matter-file-action is-secondary",
            type: "button",
            "data-v2-file-security": id,
            text: "Check status",
          })
        : null;
    const responses = files.filter((candidate) => String(candidate.revisionOfFileId || "") === id
      && String(candidate.revisionRequestAt || "") === String(file.revisionRequestedAt || ""));
    const source = files.find((candidate) => fileId(candidate) === String(file.revisionOfFileId || ""));
    const approvedVersion = files.find((candidate) => fileId(candidate) === file.revisionResolution?.approvedFileId);
    const revisionRequest = file.status === "attorney_revision" ? node("aside", {
      className: "v2-matter-revision-request",
      "data-v2-revision-request": id,
    }, [
      node("div", {}, [
        node("strong", { text: file.revisionResolution ? "Revision resolved" : "Revisions requested" }),
        node("p", { text: String(file.revisionNotes || "").trim() || "The matter attorney requested an updated file." }),
        node("small", { text: file.revisionResolution ? "Original kept for reference." : `Version ${file.version || 1}${file.revisionRequestedAt ? ` · Requested ${dateLabel(file.revisionRequestedAt)}` : ""}` }),
        approvedVersion ? node("p", { text: `Approved revision: ${fileName(approvedVersion)}, version ${approvedVersion.version || 1}.` }) : null,
        ...responses.map((response) => node("p", { text: `Response submitted: ${fileName(response)} · version ${response.version || 1} · ${submissionPresentation(response, { historical: state.historical }).status === "pending_review" ? "Awaiting attorney approval" : submissionPresentation(response, { historical: state.historical }).label}.` })),
      ]),
      state.writable && !file.revisionResolution ? node("button", {
        className: "v2-matter-file-action is-secondary",
        type: "button",
        "data-v2-file-revise": id,
        text: "Choose revised file",
      }) : null,
    ]) : null;
    return node("article", {
      className: `v2-matter-file${highlighted ? " is-highlighted" : ""}`,
      ...(id ? { "data-file-id": id } : {}),
      ...(highlighted ? { tabindex: "-1" } : {}),
    }, [
      node("div", { className: "v2-matter-file-copy" }, [
        node("strong", { text: fileName(file) }),
        node("p", {
          text: [
            bytes(file.size),
            dateLabel(file.uploadedAt || file.createdAt),
            file.uploadedByRole ? titleCase(file.uploadedByRole) : "",
            Number(file.version) > 1 ? `Version ${file.version}` : "",
          ].filter(Boolean).join(" · "),
        }),
      ]),
      node("div", { className: "v2-matter-file-state", "data-v2-submission-status": submission.status }, [
        !security.ready ? node("span", { className: `is-${security.status}`, text: security.label }) : null,
        submission.label && !revisionRequest ? node("span", { className: `v2-matter-submission-state is-${submission.status}`, text: submission.label }) : null,
        submission.submitted && submission.detail && !revisionRequest ? node("small", { text: submission.detail }) : null,
        action,
      ]),
      file.revisionOfFileId ? node("p", { className: "v2-matter-file-revision-link", text: `Revision of ${source ? fileName(source) : "requested file"}, version ${file.revisionOfVersion || 1}${file.revisionRequestAt ? ` · requested ${dateLabel(file.revisionRequestAt)}` : ""}` }) : null,
      revisionRequest,
    ]);
  })));
  positionUploadForm(state);
  if (focused?.isConnected) focused.focus({ preventScroll: true });
}

function confirmSubmission(state, trigger, { isCurrent, onConfirm } = {}) {
  if (state.uploading || !isCurrent?.() || !state.writable) return;
  const input = state.panel.querySelector("[data-v2-file-input]");
  const entries = state.selectedFiles;
  if (!entries.length) {
    setStatus(state, "Choose a file before submitting.", "error");
    input?.focus();
    return;
  }
  const invalid = entries.find((entry) => selectionError(entry.file));
  if (invalid) {
    setStatus(state, `${invalid.file.name}: ${selectionError(invalid.file)}`, "error");
    input?.focus();
    return;
  }
  const existing = document.querySelector("[data-v2-file-confirmation]");
  if (existing) return;
  const titleId = `v2-file-confirm-${state.matterId}`;
  const cancel = node("button", { className: "v2-matter-dialog-secondary", type: "button", text: "Cancel" });
  const plural = entries.length > 1;
  const confirm = node("button", { className: "v2-matter-dialog-primary", type: "button", text: plural ? "Submit files" : "Submit file" });
  const dialog = node("dialog", {
    className: "v2-matter-dialog v2-matter-file-confirmation",
    "aria-labelledby": titleId,
    "data-v2-route-dialog": "",
    "data-v2-file-confirmation": "",
  }, [
    node("div", { className: "v2-matter-dialog-body" }, [
      node("p", { className: "v2-matter-kicker", text: "Matter submission" }),
      node("h2", { id: titleId, text: plural ? `Submit ${entries.length} files?` : "Submit this file?" }),
      node("p", { text: plural
        ? "These files will be sent to the attorney for review."
        : `This will share ${entries[0].file.name} with the matter attorney in this workspace for review.` }),
    ]),
    node("footer", {}, [cancel, confirm]),
  ]);
  cancel.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", () => {
    dialog.close("confirm");
    onConfirm?.();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (dialog.returnValue !== "confirm") trigger?.focus({ preventScroll: true });
  }, { once: true });
  document.querySelector("[data-v2-dialog-host]")?.append(dialog);
  dialog.showModal();
  cancel.focus();
}

export function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function createMatterFilesController({
  api,
  onSessionLost,
  onAccessLost,
  onChanged,
  onMatterChanged,
} = {}) {
  const panelStates = new WeakMap();
  let current = null;
  let generation = 0;
  let refreshController = null;
  const uploadControllers = new Set();
  const drafts = new Map();
  let eventSource = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let refreshTimer = null;
  let channel = null;
  let globalChannel = null;

  function stopRealtime() {
    eventSource?.close();
    eventSource = null;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (pollTimer) window.clearInterval(pollTimer);
    if (refreshTimer) window.clearTimeout(refreshTimer);
    reconnectTimer = null;
    pollTimer = null;
    refreshTimer = null;
    channel?.close?.();
    channel = null;
    globalChannel?.close?.();
    globalChannel = null;
  }

  function leave() {
    generation += 1;
    refreshController?.abort();
    uploadControllers.forEach((controller) => controller.abort());
    uploadControllers.clear();
    refreshController = null;
    if (current) {
      current.securityTimers.forEach((timer) => window.clearTimeout(timer));
      current.securityTimers.clear();
    }
    stopRealtime();
    current = null;
  }

  function lockPanel(state, message) {
    state.writable = false;
    state.result = { unavailable: true, message: message || "File access is no longer available for this matter." };
    state.panel.querySelector("[data-v2-file-form]")?.remove();
    renderFiles(state);
    setStatus(state, state.result.message, "error");
  }

  function handleAccessError(state, error, { matterResource = true } = {}) {
    if (error instanceof LpcApiError && error.status === 401) {
      onSessionLost?.();
      return true;
    }
    if (error instanceof LpcApiError && error.status === 403) {
      lockPanel(state, error.message);
      stopRealtime();
      onAccessLost?.(state.matterId);
      onMatterChanged?.();
      return true;
    }
    if (matterResource && error instanceof LpcApiError && error.status === 404) {
      lockPanel(state, error.message);
      stopRealtime();
      onAccessLost?.(state.matterId);
      onMatterChanged?.();
      return true;
    }
    return false;
  }

  async function refresh(state, { announce = false } = {}) {
    if (state !== current || state.historical) return;
    const requestGeneration = generation;
    refreshController?.abort();
    refreshController = new AbortController();
    if (announce) setStatus(state, "Updating files…");
    try {
      const result = await api.get(`/api/uploads/case/${encodeURIComponent(state.matterId)}?presentation=matter`, {
        signal: refreshController.signal,
      });
      if (state !== current || requestGeneration !== generation) return;
      const changed = fileStateFingerprint(state.result) !== fileStateFingerprint(result);
      state.result = result;
      if (changed) renderFiles(state);
      schedulePendingSecurityChecks(state);
      if (announce) setStatus(state, "");
      if (changed) onChanged?.({ reason: "refresh", matterId: state.matterId });
      if (changed) {
        try { globalChannel?.postMessage({ matterId: state.matterId, at: Date.now() }); } catch {}
      }
    } catch (error) {
      if (error?.name === "AbortError" || state !== current || requestGeneration !== generation) return;
      if (!handleAccessError(state, error)) {
        setStatus(state, error?.message || "Files could not be updated right now.", "error");
      }
    }
  }

  function scheduleRefresh() {
    if (!current || refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refresh(current);
    }, 100);
  }

  function startPolling() {
    if (pollTimer || !current) return;
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") scheduleRefresh();
    }, POLL_INTERVAL_MS);
  }

  function startStream(state) {
    if (state !== current) return;
    if (typeof EventSource !== "function") {
      startPolling();
      return;
    }
    const source = new EventSource(`/api/cases/${encodeURIComponent(state.matterId)}/stream`);
    eventSource = source;
    source.addEventListener("open", () => {
      scheduleRefresh();
    });
    source.addEventListener("documents", scheduleRefresh);
    source.addEventListener("case", () => onMatterChanged?.());
    source.addEventListener("error", () => {
      if (eventSource !== source) return;
      source.close();
      eventSource = null;
      startPolling();
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (state === current) startStream(state);
      }, RECONNECT_DELAY_MS);
    });
  }

  function publishSync(state) {
    try { channel?.postMessage({ matterId: state.matterId, at: Date.now() }); } catch {}
    try { globalChannel?.postMessage({ matterId: state.matterId, at: Date.now() }); } catch {}
  }

  async function uploadEntry(state, entry) {
    const controller = new AbortController();
    entry.controller = controller;
    entry.status = "uploading";
    entry.progress = 0;
    entry.error = "";
    uploadControllers.add(controller);
    const formData = new FormData();
    formData.append("file", entry.file);
    formData.append("caseId", state.matterId);
    formData.append("clientUploadId", entry.clientUploadId);
    if (entry.revisionOfFileId) {
      formData.append("revisionOfFileId", entry.revisionOfFileId);
      formData.append("revisionRequestAt", entry.revisionRequestAt);
    }
    try {
      const uploaded = await api.upload(`/api/uploads/case/${encodeURIComponent(state.matterId)}?presentation=matter`, formData, {
        signal: controller.signal,
        onProgress(value) {
          entry.progress = value;
          if (state === current) {
            const active = state.selectedFiles.filter((item) => item.status === "uploading");
            const aggregate = active.length
              ? active.reduce((total, item) => total + item.progress, 0) / active.length
              : value;
            setUploadProgress(state, aggregate);
          }
        },
      });
      entry.status = "uploaded";
      entry.uploaded = uploaded?.file || null;
      return true;
    } catch (error) {
      if (error?.name === "AbortError") {
        entry.status = "pending";
        entry.progress = 0;
        return false;
      }
      entry.status = "failed";
      entry.progress = 0;
      entry.error = error?.message || "The file could not be submitted.";
      if (state === current) handleAccessError(state, error);
      return false;
    } finally {
      entry.controller = null;
      uploadControllers.delete(controller);
    }
  }

  async function upload(state) {
    const input = state.panel.querySelector("[data-v2-file-input]");
    const entries = state.selectedFiles.filter((entry) => ["pending", "failed"].includes(entry.status));
    if (!entries.length) {
      setStatus(state, "Choose a file before submitting.", "error");
      input?.focus();
      return;
    }
    const invalid = entries.find((entry) => selectionError(entry.file));
    if (invalid) {
      setStatus(state, `${invalid.file.name}: ${selectionError(invalid.file)}`, "error");
      input?.focus();
      return;
    }
    if (state.uploading || state !== current || !state.writable) return;

    state.cancelRequested = false;
    setUploadState(state, true);
    setRetryVisible(state, false);
    setUploadProgress(state, 0);
    setStatus(state, entries.length > 1 ? `Submitting ${entries.length} files…` : "Submitting file…");
    let cursor = 0;
    const outcomes = new Array(entries.length).fill(false);
    const workers = Array.from({ length: Math.min(3, entries.length) }, async () => {
      while (state === current && !state.cancelRequested) {
        const index = cursor;
        cursor += 1;
        if (index >= entries.length) return;
        outcomes[index] = await uploadEntry(state, entries[index]);
      }
    });
    try {
      await Promise.all(workers);
      if (state !== current) return;
      const uploadedEntries = entries.filter((entry) => entry.status === "uploaded");
      const failedEntries = entries.filter((entry) => entry.status === "failed");
      state.selectedFiles = state.selectedFiles.filter((entry) => entry.status !== "uploaded");
      updateSelectedFilesPresentation(state);
      if (uploadedEntries.length) {
        await refresh(state);
        if (state !== current) return;
        publishSync(state);
        onChanged?.({ reason: "uploaded", matterId: state.matterId });
      }
      if (state.cancelRequested) {
        setStatus(state, "Stopped waiting for upload. Unfinished files remain selected.", "error");
        setRetryVisible(state, state.selectedFiles.length > 0);
      } else if (failedEntries.length) {
        const names = failedEntries.slice(0, 2).map((entry) => entry.file.name).join(", ");
        setStatus(state, `${names}${failedEntries.length > 2 ? ` and ${failedEntries.length - 2} more` : ""} could not be submitted. Retry the unfinished files.`, "error");
        setRetryVisible(state, true);
      } else if (uploadedEntries.length) {
        const waiting = uploadedEntries.some((entry) => !securityPresentation(entry.uploaded).ready);
        setStatus(state, uploadedEntries.length > 1
          ? `${uploadedEntries.length} files received.${waiting ? " They will be available after their security checks." : " They are ready to download."}`
          : waiting
            ? "Submission received. The file will be available after its security check."
            : "Submission received. The file is ready to download.", "success");
      }
    } finally {
      if (state === current) setUploadState(state, false);
    }
  }

  function schedulePendingSecurityChecks(state) {
    if (state !== current || state.historical || state.result?.unavailable) return;
    const pending = filesFrom(state.result)
      .filter((file) => securityPresentation(file).status === "pending" && fileId(file))
      .slice(-MAX_AUTOMATIC_SECURITY_CHECKS);
    pending.forEach((file) => {
      const id = fileId(file);
      if (state.securityTimers.has(id)) return;
      const attempt = state.securityAttempts.get(id) || 0;
      if (attempt >= SECURITY_RECHECK_DELAYS_MS.length) return;
      const timer = window.setTimeout(() => {
        state.securityTimers.delete(id);
        if (state !== current) return;
        state.securityAttempts.set(id, attempt + 1);
        void checkSecurity(state, id, { announce: false, automatic: true });
      }, SECURITY_RECHECK_DELAYS_MS[attempt]);
      state.securityTimers.set(id, timer);
    });
  }

  async function checkSecurity(state, id, { announce = true, automatic = false } = {}) {
    if (!id || state !== current) return;
    if (announce) setStatus(state, "Checking file status…");
    try {
      const result = await api.get(`/api/uploads/case/${encodeURIComponent(state.matterId)}/${encodeURIComponent(id)}/security-status`);
      if (state !== current) return;
      const securityStatus = String(result?.securityStatus || "pending").toLowerCase();
      state.result = {
        ...(state.result || {}),
        files: filesFrom(state.result).map((file) => fileId(file) === id
          ? { ...file, securityStatus, securityScanResult: result?.securityScanResult || file.securityScanResult }
          : file),
      };
      renderFiles(state);
      if (result?.ready) {
        setStatus(state, "The file is ready to download.", "success");
      } else if (securityStatus === "blocked") {
        setStatus(state, "This file is unavailable because it did not pass the security check.", "error");
      } else if (securityStatus === "error") {
        setStatus(state, "The security check could not complete. Try again later.", "error");
      } else if (announce) {
        setStatus(state, "The file is still being checked.");
      }
      if (automatic && securityStatus === "pending") schedulePendingSecurityChecks(state);
      if (securityStatus !== "pending") {
        state.securityAttempts.delete(id);
        onChanged?.({ reason: "security", matterId: state.matterId, fileId: id });
      }
    } catch (error) {
      if (state !== current) return;
      if (!handleAccessError(state, error, { matterResource: false })) {
        if (error instanceof LpcApiError && error.status === 404) await refresh(state);
        if (announce) setStatus(state, error?.message || "The file status could not be checked.", "error");
        if (automatic) schedulePendingSecurityChecks(state);
      }
    }
  }

  async function download(state, id) {
    if (!id || state !== current || state.downloadingId) return;
    const file = filesFrom(state.result).find((entry) => fileId(entry) === id);
    if (!file) {
      setStatus(state, "This file is no longer available.", "error");
      await refresh(state);
      return;
    }
    state.downloadingId = id;
    const button = state.panel.querySelector(`[data-v2-file-download="${CSS.escape(id)}"]`);
    if (button) {
      button.disabled = true;
      button.textContent = "Preparing…";
    }
    setStatus(state, "Preparing download…");
    try {
      const blob = await api.blob(`/api/uploads/case/${encodeURIComponent(state.matterId)}/${encodeURIComponent(id)}/download`, {
        headers: { Accept: "application/octet-stream" },
      });
      if (state !== current) return;
      triggerDownload(blob, fileName(file));
      setStatus(state, "Download ready.", "success");
    } catch (error) {
      if (state !== current) return;
      if (!handleAccessError(state, error, { matterResource: false })) {
        if (error instanceof LpcApiError && [404, 422, 423, 503].includes(error.status)) await refresh(state);
        setStatus(state, error?.message || "The file could not be downloaded.", "error");
      }
    } finally {
      if (state === current) {
        state.downloadingId = "";
        const currentButton = state.panel.querySelector(`[data-v2-file-download="${CSS.escape(id)}"]`);
        if (currentButton) {
          currentButton.disabled = false;
          currentButton.textContent = "Download";
        }
      }
    }
  }

  function panel({ matterId, filesResult, highlightedFileId = "", writable = false, historical = false } = {}) {
    const content = node("div", { className: "v2-matter-file-content", "data-v2-file-content": "" });
    const status = node("p", {
      className: "v2-matter-file-status",
      "data-v2-file-status": "",
      role: "status",
      "aria-live": "polite",
    });
    const inputId = `v2-matter-file-input-${String(matterId || "matter")}`;
    const form = writable ? node("form", {
      className: "v2-matter-file-form",
      "data-v2-file-form": "",
      "aria-label": "Submit a matter file",
    }, [
      node("div", { className: "v2-matter-file-picker-row" }, [
        node("input", {
          className: "v2-visually-hidden",
          id: inputId,
          type: "file",
          accept: ACCEPTED_FILE_TYPES,
          multiple: "",
          "data-v2-file-input": "",
        }),
        node("label", { className: "v2-matter-file-picker", for: inputId, "data-v2-file-picker": "", text: "Choose files" }),
        node("span", { className: "v2-matter-file-selected", "data-v2-file-selected": "", hidden: true }),
        node("div", { className: "v2-matter-file-controls" }, [
          node("button", { type: "submit", disabled: "", text: "Submit file" }),
          node("button", { type: "button", hidden: true, "data-v2-file-cancel": "", text: "Cancel upload" }),
          node("button", { type: "button", hidden: true, "data-v2-file-retry": "", text: "Try upload again" }),
        ]),
      ]),
      node("div", { className: "v2-matter-file-progress", hidden: true, "data-v2-file-progress-wrap": "" }, [
        node("progress", { max: "100", value: "0", "data-v2-file-progress": "", "aria-label": "File upload progress" }),
        node("span", { "data-v2-file-progress-copy": "", text: "Preparing upload" }),
      ]),
      node("ul", { "data-v2-file-selection-list": "", "aria-label": "Selected files" }),
      node("button", { type: "button", hidden: true, "data-v2-file-clear": "", text: "Clear selected files" }),
      node("p", { className: "v2-matter-file-help", text: "PDF, Office, text, CSV or images · 20 MB per file" }),
    ]) : null;
    const section = node("section", {
      className: "v2-matter-panel v2-matter-files",
      "aria-labelledby": "v2-matter-files-title",
      "data-v2-file-panel": "",
    }, [
      node("h2", { id: "v2-matter-files-title", className: "v2-visually-hidden", text: "Files & submissions" }),
      node("div", { className: "v2-matter-panel-heading v2-matter-file-summary" }, [
        node("span", { className: "v2-matter-panel-note", "data-v2-file-count": "" }),
      ]),
      content,
      writable ? node("div", { className: "v2-matter-file-compose-slot", "data-v2-file-compose-slot": "" }, [form]) : null,
      status,
    ]);

    const state = {
      panel: section,
      matterId: String(matterId || ""),
      highlightedFileId: String(highlightedFileId || ""),
      writable: Boolean(writable),
      historical: Boolean(historical),
      result: filesResult,
      uploading: false,
      selectedFiles: drafts.get(String(matterId || "")) || [],
      drafts,
      cancelRequested: false,
      downloadingId: "",
      securityAttempts: new Map(),
      securityTimers: new Map(),
    };
    panelStates.set(section, state);
    renderFiles(state);
    const input = section.querySelector("[data-v2-file-input]");
    updateSelectedFilesPresentation(state);
    input?.addEventListener("change", () => addSelectedFiles(state, input.files));
    input?.addEventListener("cancel", () => { state.pendingRevision = null; input.multiple = true; });
    section.querySelector("[data-v2-file-picker]")?.addEventListener("click", () => { state.pendingRevision = null; input.multiple = true; });
    section.querySelector("[data-v2-file-clear]")?.addEventListener("click", () => {
      if (state.uploading) return;
      state.selectedFiles = [];
      setStatus(state, "");
      setRetryVisible(state, false);
      updateSelectedFilesPresentation(state);
    });
    section.querySelector("[data-v2-file-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      confirmSubmission(
        state,
        event.submitter || state.panel.querySelector("[data-v2-file-form] button[type='submit']"),
        { isCurrent: () => state === current, onConfirm: () => void upload(state) }
      );
    });
    section.querySelector("[data-v2-file-cancel]")?.addEventListener("click", () => {
      if (!state.uploading) return;
      state.cancelRequested = true;
      uploadControllers.forEach((controller) => controller.abort());
    });
    section.querySelector("[data-v2-file-retry]")?.addEventListener("click", () => {
      if (!state.uploading && state.selectedFiles.length) void upload(state);
    });
    form?.addEventListener("dragover", (event) => {
      if (!state.writable || state.uploading) return;
      event.preventDefault();
      form.classList.add("is-dragging");
    });
    form?.addEventListener("dragleave", () => form.classList.remove("is-dragging"));
    form?.addEventListener("drop", (event) => {
      form.classList.remove("is-dragging");
      if (!state.writable || state.uploading) return;
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files?.length || !input) return;
      addSelectedFiles(state, files);
    });
    section.addEventListener("click", (event) => {
      const downloadButton = event.target.closest("[data-v2-file-download]");
      if (downloadButton) {
        void download(state, downloadButton.dataset.v2FileDownload);
        return;
      }
      const securityButton = event.target.closest("[data-v2-file-security]");
      if (securityButton) {
        void checkSecurity(state, securityButton.dataset.v2FileSecurity);
        return;
      }
      const reviseButton = event.target.closest("[data-v2-file-revise]");
      if (reviseButton) {
        if (!state.writable || state.uploading) return;
        const source = filesFrom(state.result).find((file) => fileId(file) === reviseButton.dataset.v2FileRevise);
        if (!source || source.revisionResolution) return;
        state.pendingRevision = { id: fileId(source), version: source.version || 1, requestedAt: source.revisionRequestedAt || "", name: fileName(source) };
        const input = state.panel.querySelector("[data-v2-file-input]");
        if (input) { input.multiple = false; input.click(); }
      }
    });
    return section;
  }

  function afterMount(root) {
    const section = root?.querySelector?.("[data-v2-file-panel]");
    const state = section ? panelStates.get(section) : null;
    if (!state) return;
    current = state;
    generation += 1;
    const highlighted = state.highlightedFileId
      ? section.querySelector(`[data-file-id="${CSS.escape(state.highlightedFileId)}"]`)
      : null;
    if (highlighted) window.requestAnimationFrame(() => highlighted.focus({ preventScroll: false }));
    if (state.historical || state.result?.unavailable) return;
    if (typeof BroadcastChannel === "function") {
      try {
        channel = new BroadcastChannel(`lpc-v2-matter-files:${state.matterId}`);
        channel.addEventListener("message", scheduleRefresh);
        globalChannel = new BroadcastChannel("lpc-v2-files");
      } catch {
        channel = null;
        globalChannel = null;
      }
    }
    // Keep a quiet authoritative fallback while SSE is connected. It only
    // updates the DOM when the file fingerprint actually changes.
    startPolling();
    startStream(state);
    schedulePendingSecurityChecks(state);
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible" && current && !current.historical) scheduleRefresh();
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("online", () => {
    if (!current) return;
    scheduleRefresh();
    if (!eventSource) startStream(current);
  });

  return Object.freeze({
    panel,
    afterMount,
    leave,
    refresh: () => current ? refresh(current, { announce: true }) : Promise.resolve(),
    hasDrafts: () => drafts.size > 0,
    clearDrafts() {
      uploadControllers.forEach((controller) => controller.abort());
      uploadControllers.clear();
      drafts.clear();
    },
  });
}
