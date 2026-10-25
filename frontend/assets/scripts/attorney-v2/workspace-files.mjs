import {showDocumentQuickLook} from "../utils/document-quick-look.mjs";
import { matterLink } from "./workspace-model.mjs";
import {nativeSelectControl,portalIcon} from '../utils/portal-controls.mjs';
import { withMatterReturn } from "./matter-return.mjs";
import { actionMenu } from "./presentation.mjs";
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
  const routedFilters = {q:route.query.get("fileSearch") || "",status:route.query.get("fileStatus") || "all",sort:route.query.get("fileSort") || "newest"};
  if (["fileSearch","fileStatus","fileSort"].some(key=>route.query.has(key))) {
    if (JSON.stringify(state.filters) !== JSON.stringify(routedFilters)) state.loadedCount=0;
    state.filters=routedFilters;
  } else state.filters ||= routedFilters;
  const search = node("input",{type:"search",maxlength:"200",placeholder:"Search files", "aria-label":"Search files",value:state.filters.q});
  const statusFilter = node("select",{"aria-label":"File status"}, [["all","All documents"],["pending_review","Awaiting review"],["approved","Approved"],["attorney_revision","Revisions requested"],["shared","Shared documents"],["security_pending","Security pending"],["security_blocked","Security blocked"]].map(([value,text]) => node("option",{value,text})));
  const sort = node("select",{"aria-label":"Sort files"},[["newest","Newest first"],["oldest","Oldest first"],["name","Filename A–Z"]].map(([value,text])=>node("option",{value,text})));
  statusFilter.value=state.filters.status; sort.value=state.filters.sort;
  const statusControl = nativeSelectControl(statusFilter, {toolbar:true,iconOnly:true});
  statusControl.querySelector('svg').replaceWith(portalIcon('filter'));
  const filters = node("form",{className:"av2-file-filters","aria-label":"Filter files"},[search,statusControl,nativeSelectControl(sort,{toolbar:true,iconOnly:true}),node("button",{type:"submit",className:"av2-secondary",text:"Search"}),button("Clear filters",()=>{search.value="";statusFilter.value="all";sort.value="newest";filters.requestSubmit();})]);
  const count = node("p",{className:"av2-muted"});
  const inventory = node("div",{className:"av2-file-inventory"},[filters,count,list,morePlaceholder()]);
  function morePlaceholder() { return document.createTextNode(""); }
  const browser = node("div",{className:"av2-file-browser"},[inventory,detail]);
  function rememberSelection(fileId) { state.selectedId=fileId || null; if(fileId) route.query.set("fileId",fileId);else route.query.delete("fileId");
    const target=matterLink(caseId,"files",route.query); if(target){route.key=target.slice(1);history.replaceState(history.state,"",target);} }
  filters.addEventListener("submit",event=>{event.preventDefault();if(busy || reading)return;state.loadedCount=0;state.filters={q:search.value.trim(),status:statusFilter.value,sort:sort.value};for(const [key,value] of [["fileSearch",state.filters.q],["fileStatus",state.filters.status],["fileSort",state.filters.sort]]){if(value && !["all","newest"].includes(value))route.query.set(key,value);else route.query.delete(key);}rememberSelection(selected?.id);void load();});
  for(const control of [statusFilter,sort])control.addEventListener("change",()=>filters.requestSubmit());
  let value = null, files = [], selected = null, busy = false, controller = null, reading = false, quietReading = false, sequence = 0, blobUrl = null, initialSelection = true, historyView = null, replacementController = null;
  const stale = new Set();
  const refresh = recoveryButton("Retry files", () => void load()), more = button("Load more files", () => void load({ append: true })), cancel = button("Cancel file transfer", () => controller?.abort());
  section.append(node("div",{className:"av2-section-heading"},[node("h2", { text: "Files" }),node("div", { className: "av2-actions" }, [refresh, cancel])]), notice, feedback, browser); inventory.append(more);
  const upload = createWorkspaceFileUploads(caseId, { api, signal, ownerId, state: state.upload, route, onSaved: () => void load({ quiet: true }) }); browser.before(upload);
  const removal = createWorkspaceFileRemoval(caseId, { api, signal, ownerId, state: state.removal, onRemoved: async fileId => { if (signal.aborted) return; if (selected?.id === fileId) { selected = null; rememberSelection(null); } await load(); earlier.invalidate(); }, onDenied: denied, onClose: () => { const heading = section.querySelector("h2"); heading.tabIndex = -1; heading.focus(); } }); section.append(removal);
  const earlier = createWorkspaceEarlierFiles(caseId, { api, signal, ownerId, route, onDenied: denied }); section.append(node("details", {className:"av2-secondary-disclosure", ...(route.query.has("earlierFileId") ? {open:""} : {})}, [node("summary", {text:"Earlier documents and retained versions"}), earlier]));
  const options = { signal, ownerId };
  const controls = () => {
    const blocked = busy || reading && !quietReading;
    refresh.disabled = blocked; refresh.textContent = state.pending ? "Check saved review" : "Refresh files"; more.hidden = !value?.nextCursor; more.disabled = blocked; cancel.hidden = !controller || reading;
    for (const row of list.querySelectorAll("[data-download-file]")) row.querySelector("button").disabled = blocked || stale.has(row.dataset.downloadFile);
    detail.inert = blocked || stale.has(selected?.id);
    for (const control of filters.querySelectorAll("input,select,button")) control.disabled=blocked;
    for (const control of detail.querySelectorAll("[data-file-transfer-control]")) control.disabled=blocked || stale.has(selected?.id) || !["clean","not_required"].includes(selected?.securityStatus);
    for (const control of detail.querySelectorAll("[data-file-review-control]")) control.disabled=blocked || stale.has(selected?.id) || Boolean(state.pending) || !selected?.canReview;
  
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
    else feedback.textContent = error.status === 413 ? "This Matter exceeds the document inventory review limit. Contact LPC support for the remaining records." : "Files couldn’t load. Try again."; section.dataset.state = [401, 403, 404].includes(error.status) || error.kind === "authentication" ? "restricted" : "error";
  }
  function render({ preserveDetail = false } = {}) {
    if (!value) return;
    notice.textContent = value.access === "available" ? "" : downloadAccess(value);
    list.replaceChildren(...files.map(file => {
      const name = button(file.name, () => choose(file), "av2-file-name"); name.setAttribute("aria-pressed",String(selected?.id === file.id));
      const security = {clean:"Security cleared",not_required:"Security check not required",pending:"Security check pending",blocked:"Security blocked",error:"Security check unavailable",unknown:"Security status unavailable"}[file.securityStatus];
      return node("li", { "data-download-file": file.id, ...(selected?.id === file.id ? {"data-selected":"true"} : {}) }, [node("h3",{},[name]),node("p",{className:"av2-file-review-status",text:fileStatus(file)}),node("p",{className:"av2-muted",text:`${file.uploadedByRole === "unknown" ? "Uploader unavailable" : `Uploaded by ${file.uploadedByRole}`} · ${fileDescription(file)}`}),node("span",{className:"av2-file-security",text:security})]);
    }));
    count.textContent = value.total === undefined ? `${files.length} documents shown${value.nextCursor ? " · More available" : ""}` : `${files.length} of ${value.total} matching documents`;
    detail.hidden = !selected; browser.classList.toggle("has-selection",Boolean(selected));
    for (const row of list.children) if (stale.has(row.dataset.downloadFile)) row.querySelector("button").disabled = true;
    if (value.access === "available" && !files.length) list.append(node("li", { text: state.filters.q || state.filters.status !== "all" ? "No documents match these filters. Clear filters to see the other documents." : "No documents have been shared on this Matter. Upload a file when sharing is available." }));
    if (selected && !preserveDetail) renderDetail(); controls();
  }
  function choose(file) {
    if (busy || reading || stale.has(file.id)) return;
    closePreview(); selected = file; rememberSelection(file.id); render(); detail.tabIndex = -1; detail.focus({ preventScroll: true });
  }
  function renderDetail() {
    replacementController?.abort(); replacementController = null; historyView?.dispose(); historyView = null; closePreview(); const file = selected; detail.replaceChildren(); if (!file) return;
    detail.append(button("Back to files", () => {closePreview();selected=null;rememberSelection(null);render();list.querySelector("button")?.focus({preventScroll:true});},"av2-text-link"));
    detail.append(node("h3", { text: file.name }), node("p", { text: `${fileStatus(file)} · ${fileDescription(file)}` }));
    if (file.replacedAt) detail.append(node("p", { text: `Replaced ${new Date(file.replacedAt).toLocaleString()}. Earlier versions remain in the document history.` }));
    if (file.approvedAt) detail.append(node("p", { text: `Approved ${new Date(file.approvedAt).toLocaleString()}` }));
    if (file.requestedAt) detail.append(node("p", { text: `Revisions requested ${new Date(file.requestedAt).toLocaleString()}` }));
    if (file.notes) detail.append(node("p", { className: "av2-preserve-lines", text: file.notes }));
    if (file.revisionOf) detail.append(link(`Earlier document${file.revisionOf.version ? ` · Version ${file.revisionOf.version}` : ""}`, withMatterReturn(`#/matters/${caseId}/files?fileId=${file.revisionOf.id}`,route)));
    const transferActions = node("div", { className: "av2-actions" }, [button("Download file", () => void transfer(file, false))]);
    if (previewType(file) && (previewType(file) !== "pdf" || navigator.pdfViewerEnabled !== false)) transferActions.prepend(button("Preview file", () => void transfer(file, true)));
    else if (previewType(file) === "pdf") detail.append(node("p", { text: "This browser does not display PDF previews. Download the document to review it." }));
    transferActions.querySelectorAll("button").forEach(action => {action.dataset.fileTransferControl=""; action.disabled = !["clean","not_required"].includes(file.securityStatus);});
    if (!["clean","not_required"].includes(file.securityStatus)) {
      const message = file.securityStatus === "blocked"
        ? "This file did not pass the security check. Preview and download are blocked. Remove it or replace it with a safe file."
        : file.securityStatus === "error"
          ? "The security check could not complete. This file stays unavailable. Check its status again later."
          : "Security check in progress. Preview and download remain unavailable until the file passes.";
      const check = button("Check security status", () => void recheckSecurity(file));
      check.disabled = busy;
      detail.append(node("p", { className: "av2-notice", text: message }), check);
    }
    const secondary = [];
    if (value?.canUpload && !state.pending) secondary.push(button("Replace document", () => openReplacement(file)));
    if (value?.canUpload && !state.pending) secondary.push(button("Remove document", event => removal.open(file, event.currentTarget)));
    if (secondary.length) transferActions.append(actionMenu("Document options",secondary,signal));
    detail.append(transferActions); historyView = createWorkspaceFileHistory(caseId, file, { api, signal, ownerId, route, onDenied: denied,
      onUseEarlier:value?.canUpload&&!state.pending ? async blob=>{
        if(signal.aborted||selected?.id!==file.id||busy||reading||replacementController)throw new Error('Close the current replacement before preparing another.');
        const existing=state.replacements[file.id];if(existing?.file||existing?.pending)throw new Error('Finish or remove the current replacement draft first.');
        const mime=blob.type.split(';')[0];
        const extensions={'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','image/gif':'gif','text/plain':'txt','text/csv':'csv','application/msword':'doc','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/vnd.ms-excel':'xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx','application/vnd.ms-powerpoint':'ppt','application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx'};
        if(!extensions[mime])throw new Error('Download the earlier contents to inspect their format before choosing a replacement.');
        state.replacements[file.id]={file:new File([blob],`Recovered contents.${extensions[mime]}`,{type:mime})};openReplacement(file);
      }:undefined,
    }); detail.append(historyView);
    if (!file.canReview || state.pending) { if (file.uploadedByRole === "paralegal") detail.append(node("p", { text: state.pending ? "Check the saved review before making another decision." : "Review changes are unavailable for this document's current status." })); return; }
    const form = node("form"), labelId = `av2-file-notes-${file.id}`, notes = node("textarea", { id: labelId, rows: "4", maxlength: "2000" });
    notes.value = state.drafts[file.id] || "";
    notes.addEventListener("input", () => { if (notes.value) state.drafts[file.id] = notes.value; else delete state.drafts[file.id]; });
    form.append(node("label", { for: labelId, text: "Revision instructions (optional)" }), notes, node("p", { className: "av2-muted", text: "Instructions are shared with the paralegal. Review this document before recording a decision." }));
    form.addEventListener("submit", event => event.preventDefault());
    const actions = node("div", { className: "av2-actions" });
    if (file.status !== "approved") actions.append(button("Approve document", () => confirmReview(file, "approved", ""), "av2-button"));
    actions.append(button("Request revisions", () => confirmReview(file, "attorney_revision", notes.value)));
    if (file.status !== "pending_review") actions.append(button("Return to awaiting review", () => confirmReview(file, "pending_review", "")));
    form.append(actions); for(const control of form.querySelectorAll("button,textarea")) control.dataset.fileReviewControl=""; detail.insertBefore(form,historyView);
  }
  function openReplacement(file) {
    if (busy || reading || signal.aborted || replacementController) return;
    replacementController = new AbortController();
    const scoped = { ...api, readWorkspaceUpload: (id, opts) => api.readWorkspaceReplacement(id, file.id, opts), uploadWorkspaceFile: (id, input, opts) => api.replaceWorkspaceFile(id, file.id, input, opts) };
    const panel = createWorkspaceFileUploads(caseId, { api: scoped, signal: replacementController.signal, ownerId, state: state.replacements[file.id] ||= {}, route, targetFile: file, onSaved: async (_saved, changed) => { if (signal.aborted) return; await load(); if (!signal.aborted && section.dataset.state === "ready") feedback.textContent = changed ? "The earlier replacement was recorded. This document has since changed again; review its current contents." : "Document replaced."; } });
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
  async function recheckSecurity(file) {
    if (busy || signal.aborted) return;
    busy = true; feedback.textContent = "Checking document security…"; controls();
    try {
      await api.readWorkspaceFileSecurity(caseId, file.id, { signal });
      if (signal.aborted) return;
      busy = false; await load();
      if (!signal.aborted) feedback.textContent = "Security status checked. Files remain unavailable until their security check clears.";
    } catch (error) {
      if (signal.aborted) return;
      if ([401,403,404].includes(error.status) || error.kind === "authentication") denied(error);
      else feedback.textContent = "The security status could not be verified. The file stays unavailable. Try again later.";
    } finally { busy = false; if (!signal.aborted) controls(); }
  }
  async function load({ append = false, quiet = false } = {}) {
    // Rebuilding the list between a native press and click loses that selection.
    // Keep pointer and keyboard interaction intact until the user leaves the list.
    if (busy || reading || signal.aborted || quiet && (state.pending || state.removal.target && !state.removal.outcome || Object.values(state.replacements).some(value => value.file || value.pending) || Object.keys(state.drafts).length || list.matches(":active") || list.contains(document.activeElement) || detail.contains(document.activeElement) || blobUrl)) return;
    reading = true; quietReading = quiet; const ticket = ++sequence, cursor = append ? value?.nextCursor : null;
    controller = new AbortController(); if (!quiet) { section.dataset.state = "loading"; feedback.textContent = append ? "Loading more documents…" : "Loading files…"; } controls();
    const target = state.pending?.id || selected?.id || route.query.get("fileId") || state.selectedId || "";
    try {
      let next = readFiles(await api.readWorkspaceFiles(caseId, { ...options, ...state.filters, signal: controller.signal, cursor, fileId: target }), caseId, ownerId, state.filters); if (signal.aborted || sequence !== ticket) return;
      if (append && (next.nextCursor === cursor || next.files.some(file => files.some(previous => previous.id === file.id)))) throw new Error("invalid_file_page");
      let loaded = next.files;
      const restoreCount = initialSelection ? state.loadedCount || 0 : files.length;
      if ((quiet || initialSelection) && restoreCount) {
        const seen = new Set(), limit = Math.ceil(restoreCount / 50) + 2;
        while (next.nextCursor && loaded.length < restoreCount) {
          if (seen.has(next.nextCursor) || seen.size >= limit) throw new Error("invalid_file_page");
          seen.add(next.nextCursor);
          const page = readFiles(await api.readWorkspaceFiles(caseId, { ...options, ...state.filters, signal: controller.signal, cursor: next.nextCursor, fileId: target }), caseId, ownerId, state.filters);
          if (signal.aborted || sequence !== ticket) return;
          if (page.files.some(file => loaded.some(previous => previous.id === file.id))) throw new Error("invalid_file_page");
          loaded = [...loaded, ...page.files]; next = page;
        }
      }
      const previousAccess = value?.access, previousCanUpload = value?.canUpload;
      stale.clear(); files = append ? [...files, ...loaded] : loaded; state.loadedCount=files.length; value = next;
      const preserveDetail = quiet && previousAccess === next.access && previousCanUpload === next.canUpload && selected && next.selectedFile && detail.childElementCount > 0 && JSON.stringify(selected) === JSON.stringify(next.selectedFile);
      selected = target ? next.selectedFile : null;
      if (state.pending) { feedback.textContent = selected ? `Current saved review: ${fileStatus(selected)}. Check the document before making another decision.` : "The previously reviewed document is no longer available."; state.pending = null; }
      else if (next.selection === "unavailable") feedback.textContent = "The linked document is no longer available on this Matter.";
      else if (!quiet) feedback.textContent = "";
      render({ preserveDetail }); section.dataset.state = "ready";
      if (initialSelection && selected && route.query.get("fileId")) requestAnimationFrame(() => {
        if (!signal.aborted && selected?.id === target) { detail.tabIndex = -1; detail.focus({ preventScroll: true }); }
      });
      initialSelection = false;
    } catch (error) { if (!signal.aborted && sequence === ticket) { if (append && ![401, 403, 404].includes(error.status)) feedback.textContent = "More documents couldn’t load. Try again."; else denied(error); } }
    finally { if (!signal.aborted && sequence === ticket) { quietReading = false; reading = false; controller = null; controls(); } }
  }
  async function transfer(file, preview) {
    if (busy || reading || signal.aborted || stale.has(file.id) || !["clean","not_required"].includes(file.securityStatus)) return; busy = true; controller = new AbortController(); controls(); feedback.textContent = "Checking this file and preparing its contents…";
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
        showDocumentQuickLook(detail.querySelector("[data-file-preview]"),{name:file.name,onClose:closePreview,onDownload:()=>void transfer(file,false)});
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
      if(preview)showDocumentQuickLook(detail.querySelector("[data-file-preview]"),{name:file.name,onClose:closePreview,onDownload:()=>void transfer(file,false)});
      feedback.textContent = preview ? "Preview ready. Check the complete document before approving it." : "The file was handed to your browser. Check its downloads list to confirm where it was saved.";
    } catch (error) { if (!signal.aborted) { if ([401, 403].includes(error.status) || error.kind === "authentication") denied(error); else { if (["DOWNLOAD_CHANGED", "DOWNLOAD_FILE_NOT_FOUND"].includes(error.code)) { stale.add(file.id); selected = null; replacementController?.abort(); replacementController = null; historyView?.dispose(); historyView = null; detail.replaceChildren(); render(); } feedback.textContent = error.name === "AbortError" ? "File transfer canceled." : error.code === "PREVIEW_UNAVAILABLE" ? "The image preview couldn’t load. Download the document to review it." : downloadError(error); section.dataset.state = error.name === "AbortError" ? "ready" : "error"; } } }
    finally { if (!signal.aborted) { busy = false; controller = null; controls(); } }
  }
  section.sync = () => Promise.all([load({ quiet: true }), upload.sync(), earlier.sync()]);
  signal.addEventListener("abort", () => { sequence++; controller?.abort(); closePreview(); reset(); section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
