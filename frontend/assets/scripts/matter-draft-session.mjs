import { draftValues, sameDraft, mergeDraft, hasDraftContent, readDraft, validDraftId, validRequestId } from "./matter-draft-contract.mjs";

export function newDraftState({ id = "", requestId = "", descriptionLimit = 4000 } = {}) {
  return { id, requestId, descriptionLimit, values: draftValues(), base: draftValues(), revision: "", loaded: false, dirty: false, uncertain: false, busy: false, conflict: null, missing: false, deleted: false, error: "", submitted: null, action: "" };
}

// Network outcomes are never retried implicitly. The owner is verified by the
// adapter before each write; revision checks arbitrate writes in either editor.
export function createDraftSession(state, { api, ownerId, signal, onChange = () => {}, onIdentity = () => {} }) {
  const contractOptions = { descriptionLimit: state.descriptionLimit || 4000 };
  let timer, running;
  const notify = () => { if (!signal.aborted) onChange(state); };
  const options = { ownerId, signal };
  const adopt = (remote, keepLocal = false) => {
    state.id = remote.id; state.revision = remote.revision; state.publishedCaseId = remote.publishedCaseId;
    if (!keepLocal) state.values = remote.values;
    state.base = remote.values; state.loaded = true; state.uncertain = false; state.error = ""; state.conflict = null; state.submitted = null;
    state.dirty = !sameDraft(state.values, state.base, contractOptions);
    state.restricted = false; state.restriction = "";
    onIdentity(state);
  };
  function failed(error) {
    state.uncertain = true;
    if (["DRAFT_RETAINED_REVIEW_REQUIRED", "DRAFT_ARCHIVED"].includes(error.code)) { state.restricted = true; state.restriction = error.code === "DRAFT_ARCHIVED" ? "archived" : "review"; }
    state.error = state.restriction === "archived" ? "Restore it from Archived to continue." : state.restricted ? "This retained draft needs a record review before it can be changed." : error.status === 409 ? "This draft changed elsewhere. Check the saved draft before continuing."
      : error.status === 404 && state.id ? "This draft is no longer available. Your unsaved text remains here."
      : "The save could not be confirmed. Your text remains here. Check the saved draft before trying again.";
    if (error.status === 404 && state.id) state.missing = true;
  }
  async function check() {
    clearTimeout(timer);
    if (running) await running;
    if (signal.aborted || state.deleted) return false;
    state.busy = true; notify();
    try {
      if ((state.id && !validDraftId(state.id)) || (!state.id && !validRequestId(state.requestId))) throw new Error("invalid_identity");
      const remote = readDraft(await api.get(state.id ? `/api/case-drafts/${state.id}` : `/api/case-drafts/resolve/${state.requestId}`, { signal }), state.id || undefined, contractOptions);
      if (signal.aborted) return false;
      state.missing = false;
      if (!state.loaded || (!state.dirty && !state.submitted)) adopt(remote);
      else if (sameDraft(remote.values, state.base, contractOptions) || (state.submitted && sameDraft(remote.values, state.submitted, contractOptions))) adopt(remote, true);
      else { state.conflict = remote; state.uncertain = true; state.error = "Compare the saved version with your edits, then choose which fields to keep."; }
      return !state.conflict;
    } catch (error) {
      if (signal.aborted) return false;
      if (error.status === 404 && !state.id) {
        state.loaded = true; state.uncertain = false; state.error = ""; state.submitted = null;
        return true;
      }
      state.uncertain = true;
      state.missing = error.status === 404;
      if (["DRAFT_RETAINED_REVIEW_REQUIRED", "DRAFT_ARCHIVED"].includes(error.code)) { state.restricted = true; state.restriction = error.code === "DRAFT_ARCHIVED" ? "archived" : "review"; }
      state.error = error.code === "DRAFT_ARCHIVED" ? "Restore it from Archived to continue." : error.code === "DRAFT_RETAINED_REVIEW_REQUIRED" ? "This retained draft needs a record review before it can be changed." : state.missing ? state.action === "delete" ? "This draft is no longer available. Deletion was not confirmed. Your text remains here; it has not been recreated." : "This draft is no longer available. Any unsaved text remains here; it has not been recreated." : "The saved draft couldn’t be checked. Try again when your connection is available.";
      return false;
    } finally { state.busy = false; notify(); }
  }
  async function save() {
    clearTimeout(timer);
    if (running) { await running; return signal.aborted ? false : save(); }
    if (state.publishedCaseId || signal.aborted || !state.loaded || state.uncertain || state.conflict || state.missing || state.deleted || state.busy) return false;
    if (!state.dirty || (!state.id && !hasDraftContent(state.values))) return true;
    const submitted = draftValues(state.values, contractOptions);
    state.submitted = submitted; state.busy = true; state.action = "save"; notify();
    running = (async () => {
      try {
        const result = state.id ? await api.saveMatterDraft(state.id, submitted, state.revision, options) : await api.createMatterDraft(submitted, state.requestId, options);
        if (signal.aborted) throw new DOMException("Canceled", "AbortError");
        const remote = readDraft(result, state.id || undefined, contractOptions);
        if (!sameDraft(remote.values, submitted, contractOptions)) {
          state.conflict = remote; state.uncertain = true; state.error = "The saved draft differs from these edits. Review both versions before continuing.";
          return false;
        }
        adopt(remote, true);
        return true;
      } catch (error) { failed(error); return false; }
      finally { state.busy = false; notify(); }
    })();
    const success = await running; running = null;
    if (success && state.dirty && !signal.aborted) return save();
    return success;
  }
  function edit(values) {
    if (state.publishedCaseId || state.deleted || state.missing || !state.loaded || signal.aborted) return;
    state.values = structuredClone(values); state.dirty = !sameDraft(state.values, state.base, contractOptions);
    clearTimeout(timer); notify();
    if (!state.uncertain && !state.conflict) timer = setTimeout(() => { void save(); }, 1600);
  }
  function choose(keepLocal) {
    if (!state.conflict || signal.aborted) return;
    const remote = state.conflict;
    if (keepLocal) state.values = mergeDraft(state.base, state.values, remote.values, contractOptions);
    adopt(remote, keepLocal); notify();
    // Choosing a merge doesn't write until the explicit Save draft action.
  }
  async function remove() {
    clearTimeout(timer);
    if (running) await running;
    if (signal.aborted || !state.id || !state.loaded || state.uncertain || state.conflict || state.busy || state.deleted || state.missing) return false;
    state.busy = true; state.action = "delete"; notify();
    try {
      const result = await api.deleteMatterDraft(state.id, state.revision, options);
      if (signal.aborted) throw new DOMException("Canceled", "AbortError");
      if (result?.success !== true) throw new Error("invalid_delete");
      state.deleted = true; state.values = draftValues(); state.base = draftValues(); state.dirty = false; state.uncertain = false;
      return true;
    } catch (error) { failed(error); return false; }
    finally { state.busy = false; notify(); }
  }
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return { check, save, edit, choose, remove };
}
