import { createWorkspaceEarlierFiles } from "./workspace-earlier-files.mjs";
import { createWorkspaceFileRemoval } from "./workspace-file-removal.mjs";
import { node, button, link, recoveryButton, setRecovery } from "./dom.mjs";
import { readFiles, readFileReview, fileStatus, previewType, reviewError } from "./files-model.mjs";
import { fileDescription, fileName, downloadAccess, downloadError } from "./download-model.mjs";
import { createWorkspaceFileHistory } from "./workspace-file-history.mjs";
import { createWorkspaceFileUploads } from "./workspace-file-uploads.mjs";
export function createWorkspaceFiles(caseId, { api, signal, ownerId, route, privateState }) {
  const section = node("section", { "aria-label": "Matter files", "data-workspace-files": "" });
  const feedback = node("p", { role: "status", "data-file-feedback": "" }), notice = node("p"), list = node("ul", { className: "av2-file-list" }), detail = node("section", { "aria-label": "Document review", className: "av2-file-detail" });
  const state = privateState.fileReviews.get(caseId) || { drafts: {}, pending: null }; privateState.fileReviews.set(caseId, state);
  state.upload ||= {}; state.replacements ||= {}; state.removal ||= {};
  let value = null, files = [], selected = null, busy = false, controller = null, reading = false, quietReading = false, sequence = 0, blobUrl = null, initialSelection = true, historyView = null, replacementController = null;
  const stale = new Set();
  const refresh = recoveryButton("Retry files", () => void load()), more = button("Load more files", () => void load({ append: true })), cancel = button("Cancel file transfer", () => controller?.abort());
  section.append(node("h2", { text: "Files" }), notice, feedback, node("div", { className: "av2-actions" }, [refresh, cancel]), list, more, detail);
  const upload = createWorkspaceFileUploads(caseId, { api, signal, ownerId, state: state.upload, onSaved: () => void load({ quiet: true }) }); section.append(upload);
  const removal = createWorkspaceFileRemoval(caseId, { api, signal, ownerId, state: state.removal, onRemoved: async fileId => { if (signal.aborted) return; if (selected?.id === fileId) selected = null; await load(); earlier.invalidate(); }, onDenied: denied, onClose: () => { const heading = section.querySelector("h2"); heading.tabIndex = -1; heading.focus(); } }); section.insertBefore(removal, upload);
  const earlier = createWorkspaceEarlierFiles(caseId, { api, signal, ownerId, route, onDenied: denied }); section.append(node("details", {className:"av2-secondary-disclosure"}, [node("summary", {text:"Earlier files"}), earlier]));
  const options = { signal, ownerId };
  const controls = () => {
    const blocked = busy || reading && !quietReading;
    refresh.disabled = blocked; refresh.textContent = state.pending ? "Check saved review" : "Refresh files"; more.hidden = !value?.nextCursor; more.disabled = blocked; cancel.hidden = !controller || reading;
    for (const row of list.querySelectorAll("[data-download-file]")) row.querySelector("button").disabled = blocked || stale.has(row.dataset.downloadFile);
    for (const control of detail.querySelectorAll("button,textarea")) control.disabled = blocked || stale.has(selected?.id);

    setRecovery(refresh, section, { pending: Boolean(state.pending), label: "Check saved review" });
  };
  function cancelQuietRead() {
    if (!quietReading) return;
    // A background read must not disable the next native press or replace its
    // selection later. Foreground actions keep their existing write checks.
    sequence++; const pendingRead = controller;
    quietReading = false; reading = false; controller = null;
    pendingRead?.abort(); controls();
  }
  for (const type of ["pointerdown", "keydown", "focusin", "click"]) section.addEventListener(type, cancelQuietRead, true);
  function closePreview() { if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null; detail.querySelector("[data-file-preview]")?.remove(); }
  function reset() { replacementController?.abort(); replacementController = null; historyView?.dispose(); historyView = null; closePreview(); files = []; value = null; selected = null; list.replaceChildren(); detail.replaceChildren(); }
  function denied(error) {
    reset(); if ([401, 403, 404].includes(error.status) || error.kind === "authentication") { upload.clear(); removal.clear(); earlier.clear(); state.drafts = {}; state.pending = null; state.replacements = {}; privateState.fileReviews.delete(caseId); feedback.textContent = "Files are no longer available to this account."; }
    else feedback.textContent = "Files couldn’t load. Try again."; section.dataset.state = [401, 403, 404].includes(error.status) || error.kind === "authentication" ? "restricted" : "error";
  }
  function render() {
    if (!value) return;
    notice.textContent = value.access === "available" ? "" : downloadAccess(value);
    list.replaceChildren(...files.map(file => node("li", { "data-download-file": file.id }, [node("h3", {}, [button(file.name, () => choose(file))]), node("p", { text: `${fileStatus(file)} · ${fileDescription(file)}` })])));
    for (const row of list.children) if (stale.has(row.dataset.downloadFile)) row.querySelector("button").disabled = true;
    if (value.access === "available" && !files.length) list.append(node("li", { text: "No documents have been shared on this Matter." }));
    if (selected) renderDetail(); controls();
  }
  function choose(file) {
    if (busy || reading || stale.has(file.id)) return;
    closePreview(); selected = file; renderDetail(); detail.tabIndex = -1; detail.focus({ preventScroll: true }); detail.scrollIntoView({ block: "start" });
  }
  function renderDetail() {
    replacementController?.abort(); replacementController = null; historyView?.dispose(); historyView = null; closePreview(); const file = selected; detail.replaceChildren(); if (!file) return;
    detail.append(node("h3", { text: file.name }), node("p", { text: `${fileStatus(file)} · ${fileDescription(file)}` }));
    if (file.replacedAt) detail.append(node("p", { text: `Replaced ${new Date(file.replacedAt).toLocaleString()}. Earlier versions remain in the document history.` }));
    if (file.approvedAt) detail.append(node("p", { text: `Approved ${new Date(file.approvedAt).toLocaleString()}` }));
    if (file.requestedAt) detail.append(node("p", { text: `Revisions requested ${new Date(file.requestedAt).toLocaleString()}` }));
    if (file.notes) detail.append(node("p", { className: "av2-preserve-lines", text: file.notes }));
    if (file.revisionOf) detail.append(link(`Earlier document${file.revisionOf.version ? ` · Version ${file.revisionOf.version}` : ""}`, `#/matters/${caseId}/files?fileId=${file.revisionOf.id}`));
    const transferActions = node("div", { className: "av2-actions" }, [button("Download file", () => void transfer(file, false))]);
    if (previewType(file) && (previewType(file) !== "pdf" || navigator.pdfViewerEnabled !== false)) transferActions.prepend(button("Preview file", () => void transfer(file, true)));
    else if (previewType(file) === "pdf") detail.append(node("p", { text: "This browser does not display PDF previews. Download the document to review it." }));
    if (value?.canUpload && !state.pending) transferActions.append(button("Replace document", () => openReplacement(file)));
    if (value?.canUpload && !state.pending) transferActions.append(button("Remove document", event => removal.open(file, event.currentTarget)));
    detail.append(transferActions); historyView = createWorkspaceFileHistory(caseId, file, { api, signal, ownerId, onDenied: denied }); detail.append(historyView);
    if (!file.canReview || state.pending) { if (file.uploadedByRole === "paralegal") detail.append(node("p", { text: state.pending ? "Check the saved review before making another decision." : "Review changes are unavailable for this document's current status." })); return; }
    const form = node("form"), labelId = `av2-file-notes-${file.id}`, notes = node("textarea", { id: labelId, rows: "4", maxlength: "2000" });
    notes.value = state.drafts[file.id] || "";
    notes.addEventListener("input", () => { if (notes.value) state.drafts[file.id] = notes.value; else delete state.drafts[file.id]; });
    form.append(node("label", { for: labelId, text: "Revision instructions (optional)" }), notes, node("p", { className: "av2-muted", text: "Instructions are shared with the paralegal. Review this document before recording a decision." }));
    form.addEventListener("submit", event => event.preventDefault());
    const actions = node("div", { className: "av2-actions" });
    if (file.status !== "approved") actions.append(button("Approve document", () => confirmReview(file, "approved", "")));
    actions.append(button("Request revisions", () => confirmReview(file, "attorney_revision", notes.value)));
    if (file.status !== "pending_review") actions.append(button("Return to awaiting review", () => confirmReview(file, "pending_review", "")));
    form.append(actions); detail.append(form);
  }
  function openReplacement(file) {
    if (busy || reading || signal.aborted || replacementController) return;
    replacementController = new AbortController();
    const scoped = { ...api, readWorkspaceUpload: (id, opts) => api.readWorkspaceReplacement(id, file.id, opts), uploadWorkspaceFile: (id, input, opts) => api.replaceWorkspaceFile(id, file.id, input, opts) };
    const panel = createWorkspaceFileUploads(caseId, { api: scoped, signal: replacementController.signal, ownerId, state: state.replacements[file.id] ||= {}, targetFile: file, onSaved: async (_saved, changed) => { if (signal.aborted) return; await load(); if (!signal.aborted && section.dataset.state === "ready") feedback.textContent = changed ? "The earlier replacement was recorded. This document has since changed again; review its current contents." : "Document replaced."; } });
    detail.append(panel); panel.tabIndex = -1; panel.focus({ preventScroll: true }); panel.scrollIntoView({ block: "start" });
  }
  function confirmReview(file, status, notes) {
    if (busy || reading || state.pending || selected?.reviewRevision !== file.reviewRevision) return;
    detail.querySelector("[data-file-confirm]")?.remove();
    const box = node("div", { "data-file-confirm": "", tabindex: "-1", className: "av2-file-confirm" });
    const label = status === "approved" ? "Confirm approval" : status === "attorney_revision" ? "Confirm revision request" : "Confirm awaiting review";
    box.append(node("p", { text: status === "approved" ? `Approve “${file.name}”${file.version ? `, version ${file.version}` : ""}? This records your review of this document. It does not complete the Matter or release payment.` : status === "attorney_revision" ? `Request revisions to “${file.name}”${file.version ? `, version ${file.version}` : ""}? The paralegal can read these instructions and submit a revised document.` : `Return “${file.name}” to awaiting attorney review? Its current approval or revision request will be cleared.` }));
    if (notes) box.append(node("p", { text: notes, className: "av2-preserve-lines" }));
    box.append(button(label, () => void save(file, status, notes)), button("Cancel", () => { box.remove(); detail.querySelector("form button")?.focus(); })); detail.append(box); box.focus();
  }
  async function save(file, status, notes) {
    if (busy || reading || state.pending || signal.aborted) return; busy = true; state.pending = { id: file.id, status }; controls(); detail.querySelectorAll("button,textarea").forEach(input => { input.disabled = true; }); feedback.textContent = "Recording document review…";
    try {
      const result = await api.updateWorkspaceFile(caseId, file.id, { status, notes, reviewedRevision: file.reviewRevision }, options); if (signal.aborted) return;
      const saved = readFileReview(result.file); if (saved.id !== file.id || saved.status !== status) throw new Error("invalid_review_confirmation");
      selected = saved; files = files.map(item => item.id === saved.id ? saved : item); state.pending = null; delete state.drafts[file.id];
      feedback.textContent = status === "approved" ? "Document approved." : status === "attorney_revision" ? "Revisions requested." : "Document returned to awaiting review."; render();
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied(error);
      else { feedback.textContent = reviewError(error); renderDetail(); }
    } finally { busy = false; if (!signal.aborted) { controls(); detail.querySelector("h3")?.setAttribute("tabindex", "-1"); detail.querySelector("h3")?.focus({ preventScroll: true }); } }
  }
  async function load({ append = false, quiet = false } = {}) {
    // Rebuilding the list between a native press and click loses that selection.
    // Keep pointer and keyboard interaction intact until the user leaves the list.
    if (busy || reading || signal.aborted || quiet && (state.pending || state.removal.target && !state.removal.outcome || Object.values(state.replacements).some(value => value.file || value.pending) || Object.keys(state.drafts).length || list.matches(":active") || list.contains(document.activeElement) || detail.contains(document.activeElement) || blobUrl)) return;
    reading = true; quietReading = quiet; const ticket = ++sequence, cursor = append ? value?.nextCursor : null;
    controller = new AbortController(); if (!quiet) { section.dataset.state = "loading"; feedback.textContent = append ? "Loading more documents…" : "Loading files…"; } controls();
    const target = state.pending?.id || selected?.id || route.query.get("fileId") || "";
    try {
      let next = readFiles(await api.readWorkspaceFiles(caseId, { ...options, signal: controller.signal, cursor, fileId: target }), caseId, ownerId); if (signal.aborted || sequence !== ticket) return;
      if (append && (next.nextCursor === cursor || next.files.some(file => files.some(previous => previous.id === file.id)))) throw new Error("invalid_file_page");
      let loaded = next.files;
      if (quiet && files.length) {
        const oldest = files.at(-1).id, seen = new Set(), limit = Math.ceil(files.length / 50) + 2;
        while (next.nextCursor && loaded.at(-1)?.id > oldest) {
          if (seen.has(next.nextCursor) || seen.size >= limit) throw new Error("invalid_file_page");
          seen.add(next.nextCursor);
          const page = readFiles(await api.readWorkspaceFiles(caseId, { ...options, signal: controller.signal, cursor: next.nextCursor, fileId: target }), caseId, ownerId);
          if (signal.aborted || sequence !== ticket) return;
          if (page.files.some(file => loaded.some(previous => previous.id === file.id))) throw new Error("invalid_file_page");
          loaded = [...loaded, ...page.files]; next = page;
        }
      }
      stale.clear(); files = append ? [...files, ...loaded] : loaded; value = next;
      selected = target ? next.selectedFile : null;
      if (state.pending) { feedback.textContent = selected ? `Current saved review: ${fileStatus(selected)}. Check the document before making another decision.` : "The previously reviewed document is no longer available."; state.pending = null; }
      else if (next.selection === "unavailable") feedback.textContent = "The linked document is no longer available on this Matter.";
      else if (!quiet) feedback.textContent = "";
      render(); section.dataset.state = "ready";
      if (initialSelection && selected && route.query.get("fileId")) requestAnimationFrame(() => {
        if (!signal.aborted && selected?.id === target) { detail.tabIndex = -1; detail.scrollIntoView({ block: "start" }); detail.focus({ preventScroll: true }); }
      });
      initialSelection = false;
    } catch (error) { if (!signal.aborted && sequence === ticket) { if (append && ![401, 403, 404].includes(error.status)) feedback.textContent = "More documents couldn’t load. Try again."; else denied(error); } }
    finally { if (!signal.aborted && sequence === ticket) { quietReading = false; reading = false; controller = null; controls(); } }
  }
  async function transfer(file, preview) {
    if (busy || reading || signal.aborted || stale.has(file.id)) return; busy = true; controller = new AbortController(); controls(); feedback.textContent = "Checking this file and preparing its contents…";
    try {
      if (preview && previewType(file) === "pdf") {
        const path = await api.prepareMatterPdfPreview(caseId, file.id, file.revision, { ...options, signal: controller.signal });
        if (signal.aborted || controller.signal.aborted) return;
        closePreview();
        const frame = node("iframe", { src: path, title: `Preview of ${file.name}`, className: "av2-file-preview" });
        frame.addEventListener("load", async () => {
          if (signal.aborted || !frame.isConnected) return;
          try { await api.prepareMatterPdfPreview(caseId, file.id, file.revision, options); }
          catch (error) { if (!signal.aborted && frame.isConnected) denied(error); return; }
          if (signal.aborted || !frame.isConnected) return;
          try {
            if (frame.contentDocument?.contentType === "application/json") { const error = JSON.parse(frame.contentDocument.body.textContent); frame.remove(); feedback.textContent = downloadError(error); section.dataset.state = "error"; }
          } catch { /* Native PDF viewers may expose no readable frame document. */ }
        });
        detail.append(node("div", { "data-file-preview": "" }, [frame, button("Close preview", closePreview)]));
        feedback.textContent = "PDF preview requested. If the pages do not appear, download the document to review it.";
        return;
      }
      const blob = await api.downloadMatterFile(caseId, file.id, file.revision, { ...options, signal: controller.signal }); if (signal.aborted || controller.signal.aborted) return;
      closePreview();
      if (preview && previewType(file) === "text") { const text = await blob.slice(0, 1024 * 1024).text(); if (signal.aborted || controller.signal.aborted) return; detail.append(node("div", { "data-file-preview": "" }, [node("p", { text: blob.size > 1024 * 1024 ? "Preview shows the first 1 MB. Download the complete document to review all text." : "Document preview" }), node("pre", { text, className: "av2-file-text-preview" }), button("Close preview", closePreview)])); }
      else {
        blobUrl = URL.createObjectURL(preview ? new Blob([blob], { type: file.mimeType }) : blob);
        if (preview) {
          const picture = node("img", { src: blobUrl, alt: file.name, className: "av2-file-preview" });
          detail.append(node("div", { "data-file-preview": "" }, [picture, button("Close preview", closePreview)]));
          try { await picture.decode(); }
          catch { closePreview(); throw Object.assign(new Error("Image preview unavailable"), { code: "PREVIEW_UNAVAILABLE" }); }
          if (signal.aborted || controller.signal.aborted) { closePreview(); throw new DOMException("Canceled", "AbortError"); }
        }
        else { const anchor = node("a", { href: blobUrl, download: fileName(file.name), hidden: true }); section.append(anchor); anchor.click(); anchor.remove(); const url = blobUrl; setTimeout(() => { URL.revokeObjectURL(url); if (blobUrl === url) blobUrl = null; }, 1000); }
      }
      feedback.textContent = preview ? "Preview ready. Check the complete document before approving it." : "The file was handed to your browser. Check its downloads list to confirm where it was saved.";
    } catch (error) { if (!signal.aborted) { if ([401, 403].includes(error.status) || error.kind === "authentication") denied(error); else { if (["DOWNLOAD_CHANGED", "DOWNLOAD_FILE_NOT_FOUND"].includes(error.code)) { stale.add(file.id); selected = null; replacementController?.abort(); replacementController = null; historyView?.dispose(); historyView = null; detail.replaceChildren(); render(); } feedback.textContent = error.name === "AbortError" ? "File transfer canceled." : error.code === "PREVIEW_UNAVAILABLE" ? "The image preview couldn’t load. Download the document to review it." : downloadError(error); section.dataset.state = error.name === "AbortError" ? "ready" : "error"; } } }
    finally { if (!signal.aborted) { busy = false; controller = null; controls(); } }
  }
  section.sync = () => Promise.all([load({ quiet: true }), upload.sync(), earlier.sync()]);
  signal.addEventListener("abort", () => { sequence++; controller?.abort(); closePreview(); reset(); section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
