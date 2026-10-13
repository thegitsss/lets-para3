import { node, page, button, link } from "./dom.mjs";
import { matterReturnHref } from "./matter-return.mjs";
import { draftFields, draftLabels, validDraftId, validDraftDate, dollarCents } from "../matter-draft-contract.mjs";

export function readPosting(payload, id) {
  const posting = payload?.posting;
  if (!posting || posting.id !== id || !/^[a-f0-9]{64}$/.test(posting.revision || "") || !posting.permissions || ["canEdit", "canDelete", "amountLocked", "tasksLocked"].some((key) => typeof posting.permissions[key] !== "boolean") || draftFields.some((key) => key === "tasks" ? !Array.isArray(posting.values?.tasks) || posting.values.tasks.some((task) => typeof task?.title !== "string") : typeof posting.values?.[key] !== "string")) throw new Error("invalid_posting");
  return posting;
}
export const postingChanges = (base, local) => Object.fromEntries(draftFields.filter((key) => JSON.stringify(base[key]) !== JSON.stringify(local[key])).map((key) => [key, structuredClone(local[key])]));
export const mergePosting = (base, local, remote) => ({ ...structuredClone(remote), ...postingChanges(base, local) });

export function createPostingEditor(route, identity, { api, signal, privateState, returnHref = matterReturnHref(route) }) {
  const section = page("Edit posted Matter", "Changes become public only after you review and save them. Eligibility is checked again when you save.");
  const id = route.query.get("caseId");
  if (!validDraftId(id)) { section.append(node("p", { role: "alert", text: "This Matter link is invalid." })); return section; }
  const state = privateState.postings.get(id) || { remote: null, base: null, values: null, dirty: false, uncertain: false, busy: false, error: "", conflict: null, submitted: null, action: "", deleted: false };
  privateState.postings.set(id, state);
  const options = { signal, ownerId: identity.id };
  signal.addEventListener("abort", () => {
    if (state.busy) { state.busy = false; state.uncertain = true; state.error = "The request was interrupted. Check the saved posting before continuing."; }
  }, { once: true });
  let practices = [], confirming = "";
  const status = node("section", { role: "region", "aria-label": "Posting save status", className: "av2-card", tabindex: -1 });
  const form = node("fieldset", { className: "av2-card av2-draft-fields" }, [node("legend", { text: "Posting fields" })]);
  const controls = {};
  for (const key of draftFields) {
    const textarea = ["description", "tasks"].includes(key);
    const control = node(key === "practiceArea" ? "select" : textarea ? "textarea" : "input", { id: `av2-posting-${key}`, name: key, ...(textarea || key === "practiceArea" ? {} : { type: key === "deadline" ? "date" : "text" }) });
    if (textarea) control.rows = key === "description" ? 9 : 5;
    if (key === "compAmount") control.inputMode = "decimal";
    if (!textarea) control.maxLength = key === "title" ? 300 : 200;
    if (key === "description") control.maxLength = 100000;
    controls[key] = control;
    control.addEventListener("input", () => {
      state.values[key] = key === "tasks" ? control.value.split("\n").map((title) => ({ title: title.trim() })) : control.value;
      state.dirty = Object.keys(postingChanges(state.base, state.values)).length > 0; render();
    });
    form.append(node("label", { for: control.id, text: draftLabels[key] + (key === "tasks" ? " (one per line)" : "") }), control);
  }
  const lock = node("p", { className: "av2-notice" }); form.append(lock);
  const review = node("section", { className: "av2-card av2-draft-review", tabindex: -1, "aria-label": "Posting confirmation" });
  function confirmAction(action) {
    confirming = action;
    state.confirmation = { action, revision: state.remote.revision };
    render(); review.focus();
  }
  const save = button("Review posting changes", () => {
    if (validate()) confirmAction("save");
  }, "av2-button");
  const remove = button("Delete posting", () => confirmAction("delete"));
  const editingActions = node("div", { className: "av2-actions" }, [save, remove]);
  const returnLink = link("Return to Matters", returnHref);
  const outcomeActions = node("div", { className: "av2-actions" }, [link("Return to Matters", returnHref, "av2-secondary")]);
  section.append(status, form, editingActions, review, returnLink);
  function validate() {
    const value = state.values;
    state.error = !value.title.trim() || !value.description.trim() ? "Add a title and description." : value.deadline && !validDraftDate(value.deadline) ? "Enter a valid deadline." : !state.remote.permissions.amountLocked && (dollarCents(value.compAmount) === null || dollarCents(value.compAmount) < 40000) ? "Minimum compensation is $400, using no more than two decimal places." : "";
    const changed = postingChanges(state.base, value);
    if (changed.tasks && (!value.tasks.length || value.tasks.length > 25 || value.tasks.some((task) => !task.title || task.title.length > 200))) state.error = "Use between 1 and 25 tasks, each with a title of at most 200 characters.";
    render(); return !state.error;
  }
  function adopt(remote, values = remote.values) {
    state.remote = remote; state.base = structuredClone(remote.values); state.values = structuredClone(values);
    state.dirty = Object.keys(postingChanges(state.base, state.values)).length > 0;
    state.uncertain = false; state.conflict = null; state.submitted = null; state.action = "";
  }
  async function check({ restoreConfirmation = false } = {}) {
    if (state.busy || signal.aborted || state.deleted) return;
    const pending = restoreConfirmation ? state.confirmation : null;
    state.confirmation = null;
    state.busy = true; state.error = ""; confirming = ""; render();
    try {
      const remote = readPosting(await api.get(`/api/cases/posting/${id}`, { signal }), id);
      if (signal.aborted) return;
      if (!state.values || (!state.dirty && !state.submitted)) adopt(remote);
      else if (JSON.stringify(remote.values) === JSON.stringify(state.base)) adopt(remote, state.values);
      else if (state.submitted && Object.entries(state.submitted).every(([key, value]) => JSON.stringify(remote.values[key]) === JSON.stringify(value))) { adopt(remote, mergePosting({ ...state.base, ...state.submitted }, state.values, remote.values)); state.error = "Your previous save is confirmed."; }
      else { state.remote = remote; state.conflict = remote; state.uncertain = true; state.error = "This posting changed elsewhere. Compare both versions before choosing which fields to keep."; }
      if (!practices.length) { const data = await api.get("/api/cases/posting/options", { signal }); if (!Array.isArray(data.practiceAreas)) throw new Error("invalid_options"); practices = data.practiceAreas; }
      // A same-account route refresh may rebuild an open confirmation. Restore
      // it only after verifying the same revision and its current permission.
      if (!signal.aborted && pending && !state.conflict && pending.revision === remote.revision &&
        ((pending.action === "delete" && remote.permissions.canDelete) || (pending.action === "save" && remote.permissions.canEdit))) {
        confirming = pending.action; state.confirmation = pending;
      }
    } catch (error) {
      if (signal.aborted) return;
      state.uncertain = true;
      if ([401, 403, 404].includes(error.status)) {
        // Absence can also mean access loss. Only the deletion acknowledgement
        // above can confirm deletion; discard stale private fields on denial.
        state.values = state.base = state.remote = state.conflict = state.submitted = null;
        state.dirty = false;
        state.error = state.action === "delete" ? "This posting is no longer available. Deletion was not confirmed." : "This posting is no longer available to your account.";
      } else state.error = "The saved posting couldn’t be checked. Your edits remain here.";
    } finally {
      if (!signal.aborted) {
        state.busy = false; render();
        if (confirming && review.isConnected && (document.activeElement === document.body || section.contains(document.activeElement))) review.focus({ preventScroll: true });
      }
    }
  }
  async function write(action) {
    if (state.busy || state.uncertain || !state.remote || signal.aborted) return;
    const restoreDeletionFocus = action === "delete" && section.contains(document.activeElement);
    state.confirmation = null;
    state.busy = true; state.action = action; state.error = ""; render();
    try {
      if (action === "save") {
        state.submitted = postingChanges(state.base, state.values);
        const remote = readPosting(await api.saveMatterPosting(id, state.submitted, state.remote.revision, options), id);
        if (signal.aborted) return;
        adopt(remote); state.error = "Posting changes saved.";
      } else {
        const result = await api.deleteMatterPosting(id, state.remote.revision, options);
        if (signal.aborted) return;
        if (result?.ok !== true) throw new Error("invalid_delete");
        state.deleted = true; state.dirty = false; state.values = null;
      }
    } catch (error) {
      if (signal.aborted) return;
      state.uncertain = true;
      state.error = error.status === 409 ? "This Matter changed or became ineligible. Check the saved posting before continuing." : "The result could not be confirmed. Your edits remain here. Check the saved posting before trying again.";
    } finally {
      if (!signal.aborted) {
        state.busy = false; confirming = ""; render();
        if (state.deleted && restoreDeletionFocus && status.isConnected && (document.activeElement === document.body || section.contains(document.activeElement))) status.focus({ preventScroll: true });
      }
    }
  }
  function choose(keep) {
    const remote = state.conflict;
    if (!remote) return;
    adopt(remote, keep ? mergePosting(state.base, state.values, remote.values) : remote.values);
    state.error = keep ? "Your edited fields were kept. Review them before saving." : "Showing the saved posting.";
    render();
  }
  function render() {
    if (signal.aborted) return;
    section.querySelector('.av2-view-header').hidden = state.deleted;
    section.setAttribute('aria-labelledby', state.deleted ? 'matter-posting-deleted-title' : 'av2-page-title');
    editingActions.hidden = returnLink.hidden = state.deleted;
    status.classList.toggle('lpc-matter-outcome', state.deleted);
    status.dataset.state = state.deleted ? "deleted" : state.busy ? "busy" : state.uncertain ? "uncertain" : "ready";
    status.replaceChildren(...(state.deleted
      ? [node("header", {}, [node("h1", { id: "matter-posting-deleted-title", text: "Posting deleted" })]), outcomeActions]
      : [node("h2", { text: "Posting save status" }), node("p", { role: "status", text: state.busy ? "Checking saved changes…" : state.error || (state.dirty ? "You have unsaved posting changes." : "Showing the saved posting.") })]));
    if (!state.deleted) { const checkButton = button("Check saved posting", check); checkButton.disabled = state.busy; status.append(checkButton); }
    if (state.conflict) {
      for (const key of draftFields.filter((key) => JSON.stringify(state.values[key]) !== JSON.stringify(state.conflict.values[key]))) status.append(node("h3", { text: draftLabels[key] }), node("pre", { text: `Your edits: ${display(state.values[key])}\nSaved: ${display(state.conflict.values[key])}` }));
      status.append(button("Keep my edited fields", () => choose(true)), button("Use saved posting", () => choose(false)));
    }
    const permissions = state.remote?.permissions;
    form.hidden = state.deleted || !state.values;
    form.disabled = state.busy || Boolean(confirming) || !permissions?.canEdit;
    for (const [key, control] of Object.entries(controls)) {
      const value = state.values?.[key];
      if (key === "practiceArea") { const selected = control.value; control.replaceChildren(...[...new Set([...practices, value || ""])].map((value) => node("option", { value, text: value }))); control.value = selected; }
      if (key === "deadline") control.type = value && !validDraftDate(value) ? "text" : "date";
      const shown = key === "tasks" ? (value || []).map((task) => task.title).join("\n") : value || "";
      if (control.value !== shown) control.value = shown;
      control.disabled = key === "compAmount" && Boolean(permissions?.amountLocked) || key === "tasks" && Boolean(permissions?.tasksLocked);
    }
    lock.textContent = [permissions?.reason, permissions?.amountLocked ? "Compensation is locked after an application or invitation." : "", permissions?.tasksLocked ? "Task scope is locked." : "", permissions?.deleteReason].filter(Boolean).join(" ");
    lock.hidden = !lock.textContent;
    save.hidden = remove.hidden = state.deleted;
    save.disabled = !state.dirty || state.busy || state.uncertain || !permissions?.canEdit || Boolean(confirming);
    remove.disabled = state.busy || state.uncertain || !permissions?.canDelete || Boolean(confirming);
    review.hidden = !confirming; review.replaceChildren();
    if (confirming) {
      review.append(node("h2", { text: confirming === "save" ? "Review your public changes" : "Permanently delete this posting?" }));
      if (confirming === "save") for (const [key, value] of Object.entries(postingChanges(state.base, state.values))) review.append(node("h3", { text: draftLabels[key] }), node("p", { text: `Saved: ${display(state.base[key])}\nNew: ${display(value)}` }));
      else review.append(node("p", { text: "This removes the open posting, its listing and applications. Any unsaved edits will be discarded. This cannot be undone." }));
      const confirm = button(confirming === "save" ? "Save reviewed changes" : "Delete posting permanently", () => write(confirming), "av2-button"); confirm.disabled = state.busy;
      review.append(node("div", { className: "av2-actions" }, [confirm, button("Keep editing", () => { confirming = ""; state.confirmation = null; render(); })]));
    }
  }
  const display = (value) => Array.isArray(value) ? value.map((task) => task.title).join("\n") : value || "Not specified";
  render(); section.readiness = check({ restoreConfirmation: true }); return section;
}
