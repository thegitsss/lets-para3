import { node, button, link } from "./dom.mjs";
import { selectionError, uploadAccept, uploadSize, readUploadReview, readReplacementReview, readUpload, uploadError } from "./upload-model.mjs";
export function createWorkspaceFileUploads(caseId, { api, signal, ownerId, state, onSaved, targetFile = null, compact = false, composerMode = false, onChange }) {
  const root = node("section", { "aria-label": targetFile ? "Replace document" : "Share a document", [targetFile ? "data-file-replacement" : "data-file-upload"]: "", className: "av2-file-upload" }), feedback = node("p", { role: "status" }), form = node("div");
  if (!compact) root.append(node("h3", { text: targetFile ? "Replace document" : "Share a document" }));
  root.append(feedback, form);
  let review = null, busy = false, transferring = false, controller = null;
  const options = { signal, ownerId };
  function clear() { state.file = null; state.requestId = null; state.pending = false; state.outcome = null; state.confirmation = null; review = null; }
  function confirm() { state.confirmation = { revision: review.revision, targetRevision: review.target?.reviewRevision || null }; render(); if (compact && !composerMode) form.querySelector("button")?.focus(); }
  function render() {
    if (onChange) queueMicrotask(() => {if (!signal.aborted) onChange();});
    form.replaceChildren(); root.dataset.state = busy ? "busy" : review ? "ready" : "unavailable";
    if (busy) { form.append(node("progress", { "aria-label": transferring ? "Sending document" : "Checking document sharing" }), button(transferring ? "Stop waiting for upload" : "Stop checking upload", () => controller?.abort())); return; }
    if (state.outcome?.status === "recorded") {
      form.append(node("p", { text: state.outcome.changedSinceUpload ? "This upload was recorded. The document has since been replaced; its current contents are available below." : state.outcome.file ? `“${state.outcome.file.name}” is saved on this Matter.` : "This upload was recorded, but its document is no longer available here. Sending it again will not restore it." }));
      if (state.outcome.file) form.append(link(state.outcome.changedSinceUpload ? "Open current document" : "Open shared document", `#/matters/${caseId}/files?fileId=${state.outcome.file.id}`));
      form.append(button(targetFile ? "Review another replacement" : "Choose another document", () => { clear(); void check(); })); return;
    }
    if (state.pending) {
      if (state.file) form.append(node("p", { text: state.file.name }));
      form.append(button("Check saved upload", () => void check()));
      if (review?.canUpload && state.outcome?.retryAllowed && state.file) form.append(button("Retry this file", () => { state.pending = false; confirm(); }));
      if (state.outcome?.retryAllowed) form.append(button("Remove selection", () => { clear(); feedback.textContent = "Selection removed. This does not remove a document already saved to the Matter."; void check(); }));
      return;
    }
    if (!review) { form.append(button("Check upload availability", () => void check())); return; }
    if (!review.canUpload) { form.append(node("p", { text: targetFile ? "This document cannot currently be replaced. Refresh Files to check its availability." : "Documents can be shared while the Matter is active, funded and assigned to a paralegal." })); return; }
    if (targetFile) form.append(node("p", { text: `Current document: ${review.target.name}${review.target.version ? ` · Version ${review.target.version}` : ""}` }));
    if (state.confirmation && state.file) {
      if (composerMode && !targetFile) {
        const row = node("div", {className:"av2-upload-selection-row"});
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(icon.namespaceURI,"path"); path.setAttribute("d","M14 3H5v18h14V8Zm0 0v5h5M8 13h8M8 17h5"); icon.append(path);
        const copy = node("div", {}, [node("strong", {className:"av2-upload-selection",text:state.file.name}), node("span", {text:`Ready to attach · ${uploadSize(state.file.size)}`})]);
        const remove = button("×", () => {clear();feedback.textContent="";void check();}, "av2-remove-attachment"); remove.setAttribute("aria-label", "Remove attachment"); remove.dataset.av2Tooltip="Remove attachment";
        row.append(icon,copy,remove);form.append(row);return;
      }
      if (compact && !targetFile) {
        form.append(node("p", {className:"av2-upload-selection", text:`${state.file.name} · ${uploadSize(state.file.size)}`}), node("p", {className:"av2-muted",text:"Shared with your paralegal after the security check."}));
        const share = button("Share document", () => void send()); share.setAttribute("aria-label", "Confirm and share document");
        const back = button("Change file", () => {state.confirmation = null; render();}); back.setAttribute("aria-label", "Back to selection");
        form.append(share, back); return;
      }
      form.append(node("p", { text: targetFile ? `Replace “${review.target.name}”${review.target.version ? `, version ${review.target.version}` : ""}, with “${state.file.name}” (${uploadSize(state.file.size)})? Prior contents remain in document history. The current approval and revision instructions will be cleared, and the replacement will receive a new security check.` : `Share “${state.file.name}” (${uploadSize(state.file.size)}) on this Matter? The assigned paralegal can access it once its security check allows access.` }), button(targetFile ? "Confirm replacement" : "Confirm and share document", () => void send()), button("Back to selection", () => { state.confirmation = null; render(); })); return;
    }
    const input = node("input", { type: "file", id: `av2-upload-${caseId}${targetFile ? `-${targetFile.id}` : ""}`, accept: uploadAccept });
    input.addEventListener("change", () => { state.file = input.files?.[0] || null; state.requestId = null; state.outcome = null; state.confirmation = null; feedback.textContent = state.file ? selectionError(state.file) : ""; if (compact && state.file && !selectionError(state.file)) confirm(); else render(); });
    input.classList.add("av2-upload-input");
    form.append(node("label", { className:"av2-upload-label av2-secondary", for: input.id, text: targetFile ? "Choose replacement" : "Choose document" }), input, node("p", { className: "av2-muted", text: "PDF, Office, text or images · Up to 20 MB" }));
    if (state.file) {
      form.append(node("p", { text: state.file.name }));
      const next = button("Review selected document", confirm); next.disabled = Boolean(selectionError(state.file)); form.append(next, button("Remove selection", () => { clear(); void check(); }));
    }
  }
  function restricted(error) {
    if ([401, 403, 404].includes(error.status) || error.kind === "authentication") { clear(); feedback.textContent = "Uploads are no longer available to this account."; return true; }
    return false;
  }
  function recorded(value) {
    const previouslyRecorded = state.outcome?.status === "recorded"; state.outcome = readUpload(value);
    if (value.status !== "recorded") return false;
    state.file = null; state.pending = false; state.confirmation = null; feedback.textContent = value.changedSinceUpload ? "Earlier upload confirmed." : targetFile ? "Document replaced." : "Upload confirmed.";
    if (value.file && !previouslyRecorded) onSaved?.(value.file, value.changedSinceUpload === true); return true;
  }
  async function check() {
    if (busy || signal.aborted) return; busy = true; controller = new AbortController(); feedback.textContent = state.requestId ? "Checking whether the document was saved…" : "Checking document sharing…"; render();
    try {
      const response = await api.readWorkspaceUpload(caseId, { ...options, signal: controller.signal, requestId: state.requestId });
      review = targetFile ? readReplacementReview(response, caseId, ownerId, targetFile.id) : readUploadReview(response, caseId, ownerId); if (signal.aborted) return;
      const changedSinceReview = state.confirmation && (!review.canUpload || state.confirmation.revision !== review.revision || state.confirmation.targetRevision !== (review.target?.reviewRevision || null));
      if (changedSinceReview) state.confirmation = null;
      if (state.requestId && review.upload) {
        if (!recorded(review.upload)) { state.pending = true; feedback.textContent = review.upload.retryAllowed ? "This upload has no confirmed document. You can retry the same selected file." : "The upload is not confirmed. Check again or contact support before sending another copy."; }
      } else feedback.textContent = changedSinceReview ? "The Matter or document changed. Review your selection again before sharing it." : targetFile && review.target && review.target.reviewRevision !== targetFile.reviewRevision ? "The document changed since Files loaded. Review its current name and version before replacing it." : "";
    } catch (error) { if (!signal.aborted && !restricted(error)) { review = null; feedback.textContent = "Upload status couldn’t load. Try again."; } }
    finally { busy = false; controller = null; if (!signal.aborted) render(); }
  }
  async function send() {
    if (busy || !review?.canUpload || !state.file || selectionError(state.file) || signal.aborted || composerMode && !state.confirmation) return;
    busy = true; transferring = true; state.pending = true; state.requestId ||= crypto.randomUUID(); controller = new AbortController(); const timer = setTimeout(() => controller?.abort(), 180000); feedback.textContent = "Sending document. Wait for confirmation that it was saved…"; render();
    try {
      const value = await api.uploadWorkspaceFile(caseId, { file: state.file, requestId: state.requestId, reviewedRevision: review.revision, ...(targetFile ? { reviewedFileRevision: review.target.reviewRevision } : {}) }, { ...options, signal: controller.signal });
      if (!signal.aborted) { if (!recorded(value)) throw new Error("unconfirmed_upload"); }
    } catch (error) { if (!signal.aborted && !restricted(error)) { state.outcome = null; feedback.textContent = error.name === "AbortError" ? "Stopped waiting. The file may still be saved. Check the saved upload before trying again." : uploadError(error); } }
    finally { clearTimeout(timer); busy = false; transferring = false; controller = null; if (!signal.aborted) render(); }
  }
  signal.addEventListener("abort", () => { controller?.abort(); root.replaceChildren(); }, { once: true });
  root.clear = () => { controller?.abort(); clear(); render(); };
  root.sync = () => { if (!busy && !state.file && !state.pending && state.outcome?.status !== "recorded" && !root.contains(document.activeElement)) return check(); };
  root.canSubmit = () => !busy && Boolean(review?.canUpload && state.confirmation && state.file && !selectionError(state.file) && !state.pending);
  root.submit = send;
  root.hasSelection = () => Boolean(state.file || state.pending || state.outcome);
  root.reset = () => {clear();feedback.textContent="";return check();};
  root.readiness = check(); return root;
}
