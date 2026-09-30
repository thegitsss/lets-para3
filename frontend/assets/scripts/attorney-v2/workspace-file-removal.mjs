import { node, button } from "./dom.mjs";
import { readRemovalReview, readRemoval, removalNotice } from "./file-removal-model.mjs";
export function createWorkspaceFileRemoval(caseId, { api, signal, ownerId, state, onRemoved, onDenied, onClose }) {
  const section = node("section", { "aria-label": "Document removal", "data-file-removal": "", hidden: true });
  const notice = node("p", { role: "status" }), content = node("div"), actions = node("div", { className: "av2-actions" });
  section.append(node("h3", { text: "Remove document" }), notice, content, actions);
  let controller = null, busy = false, reviewed = null, sequence = 0, retry = false, trigger = null;
  const restricted = error => [401, 403].includes(error.status) || error.kind === "authentication";
  function closeReview() {
    state.target = null; reviewed = null; section.hidden = true;
    if (trigger?.isConnected) trigger.focus(); else onClose?.(); trigger = null;
  }
  function render() {
    section.hidden = !state.target; actions.replaceChildren(); content.replaceChildren(); if (!state.target) return;
    section.dataset.state = busy ? "loading" : state.pending ? "uncertain" : reviewed?.canRemove ? "ready" : "reviewed";
    content.append(node("p", { text: `“${state.target.name}”${state.target.version ? `, version ${state.target.version}` : ""}` }));
    if (busy) { actions.append(button("Stop waiting", () => controller?.abort())); return; }
    if (state.pending) {
      actions.append(button("Check removal result", () => void load()));
      if (retry) actions.append(button("Confirm removal again", () => void save()));
      else if (reviewed?.file && reviewed.revision !== state.pending.reviewedRevision) actions.append(button("Keep current document", () => { state.pending = null; closeReview(); }));
      return;
    }
    if (reviewed?.canRemove && reviewed.file.reviewRevision === state.target.reviewRevision) {
      content.append(node("p", { text: "This removes the current document from Files. Copies still referenced in correspondence or document history remain under this Matter’s retention period. Removal cannot be undone here." }));
      actions.append(button("Confirm document removal", () => void save()));
    } else if (reviewed?.file && reviewed.file.reviewRevision !== state.target.reviewRevision) notice.textContent = "This document changed since you opened it. Refresh Files and review its current contents before removing it.";
    else if (reviewed && !reviewed.removal) notice.textContent = reviewed.file ? "This document cannot currently be removed. Refresh the Matter to check its status." : "This document is no longer listed in Files. Its removal could not be verified.";
    actions.append(button("Close removal review", closeReview));
  }
  async function saved(result) {
    const targetId = state.target.id; state.pending = null; state.outcome = result; reviewed = { canRemove: false, removal: result }; retry = false;
    notice.textContent = removalNotice(result); render(); section.tabIndex = -1; section.focus({ preventScroll: true }); await onRemoved(targetId);
  }
  async function load() {
    if (busy || signal.aborted || !state.target) return;
    busy = true; retry = false; controller = new AbortController(); const ticket = ++sequence;
    notice.textContent = state.pending ? "Checking the recorded removal…" : "Checking the document before removal…"; render();
    try {
      const value = readRemovalReview(await api.readWorkspaceRemoval(caseId, state.target.id, { ownerId, signal: controller.signal, requestId: state.pending?.requestId }), caseId, ownerId, state.target.id);
      if (signal.aborted || ticket !== sequence || controller.signal.aborted) return;
      reviewed = value;
      if (value.removal) { busy = false; await saved(value.removal); return; }
      if (state.pending) {
        retry = Boolean(value.canRemove && value.revision === state.pending.reviewedRevision && value.file.reviewRevision === state.target.reviewRevision);
        notice.textContent = retry ? "No removal is recorded for this request. Review the named document and confirm again only if you still intend to remove it." : "The document or Matter changed. This pending request cannot remove its current contents. Refresh Files to review the saved state.";
        if (!retry) actions.dataset.changed = "true";
      } else notice.textContent = "Review the document and the effect of removal before confirming.";
    } catch (error) {
      if (signal.aborted || ticket !== sequence) return;
      if (restricted(error)) { state.target = null; state.pending = null; section.hidden = true; onDenied(error); return; }
      notice.textContent = state.pending ? "The removal result could not be confirmed. Check again before making another removal request." : "The document could not be checked. Close this review and refresh Files.";
    } finally { if (!signal.aborted && ticket === sequence) { busy = false; controller = null; render(); } }
  }
  async function save() {
    if (busy || signal.aborted || !reviewed?.canRemove || reviewed.file.reviewRevision !== state.target?.reviewRevision || state.pending && !retry) return;
    state.pending ||= { requestId: crypto.randomUUID(), reviewedRevision: reviewed.revision }; retry = false;
    busy = true; controller = new AbortController(); const ticket = ++sequence;
    notice.textContent = "Recording document removal…"; render();
    try {
      const result = await api.removeWorkspaceFile(caseId, state.target.id, state.pending, { ownerId, signal: controller.signal });
      if (signal.aborted || ticket !== sequence || controller.signal.aborted) return;
      const removal = readRemoval(result.removal, state.target.id); if (!removal.exactRequest) throw new Error("invalid_removal_confirmation");
      busy = false; await saved(removal);
    } catch (error) {
      if (signal.aborted || ticket !== sequence) return;
      if (restricted(error)) { state.target = null; state.pending = null; section.hidden = true; onDenied(error); return; }
      notice.textContent = error.name === "AbortError" ? "Stopped waiting. The removal may still finish; check its recorded result." : "The removal could not be confirmed. Check its recorded result before trying again.";
    } finally { if (!signal.aborted && ticket === sequence) { busy = false; controller = null; render(); } }
  }
  section.open = (file, returnFocus) => {
    if (busy || state.pending || signal.aborted) { if (!section.hidden) section.scrollIntoView({ block: "start" }); return; }
    trigger = returnFocus; state.target = { id: file.id, name: file.name, version: file.version, reviewRevision: file.reviewRevision }; state.outcome = null; reviewed = null;
    section.hidden = false; section.tabIndex = -1; section.focus({ preventScroll: true }); section.scrollIntoView({ block: "start" }); void load();
  };
  section.clear = () => { sequence++; controller?.abort(); state.target = null; state.pending = null; state.outcome = null; section.hidden = true; };
  section.sync = async () => { if (state.pending && !busy) await load(); };
  signal.addEventListener("abort", () => { sequence++; controller?.abort(); section.replaceChildren(); }, { once: true });
  if (state.pending) void load(); else { state.target = null; state.outcome = null; }
  return section;
}
