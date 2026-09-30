import { node, button } from "./dom.mjs";
import { readMatterNote, noteDraft, editNote, adoptNote, reconcileNote } from "./matter-note-model.mjs";

// Shared by both attorney dashboards. Text lives only in the account's page memory.
export function createMatterNotes(caseId, { api, signal, privateState, ownerId, onSaved = () => {}, embedded = false, compact = false, onTitleChange = () => {} }) {
  if (!/^[a-f0-9]{24}$/i.test(caseId)) throw new TypeError("Invalid Matter ID.");
  const section = node("section", { className: "matter-notes", "aria-label": "Matter notes", "data-matter-notes": caseId });
  const feedback = node("p", { role: "status", "data-note-feedback": "" });
  const heading = node("h2", { id: `matter-note-heading-${caseId}`, text: embedded ? "Notes" : "Matter notes" });
  const matterTitle = embedded ? null : node("h3");
  const savedAt = node("p", { className: "matter-notes-meta" });
  const counter = node("p", { id: `matter-note-count-${caseId}`, className: "matter-notes-meta" });
  const input = node("textarea", { id: `matter-note-${caseId}`, rows: compact ? 4 : 10, "aria-describedby": `matter-note-help-${caseId} ${counter.id}` });
  input.setAttribute("aria-labelledby", heading.id);
  input.disabled = true;
  const conflict = node("div", { className: "matter-note-conflict" }); conflict.hidden = true;
  const emptyReview = node("div", { className: "matter-note-conflict" }); emptyReview.hidden = true;
  const check = button("Check saved note", () => void load({ announce: true }), "matter-note-button");
  const save = button("Save Matter note", () => {
    if (!draft?.note && draft?.baseline) {
      emptyReview.hidden = false;
      emptyReview.replaceChildren(node("h3", { text: "Save an empty note?" }), node("p", { text: "This removes the saved note, including any admin feedback in it." }), button("Confirm empty note", () => { emptyReview.hidden = true; void persist(); }, "matter-note-button"), button("Keep editing", () => { emptyReview.hidden = true; input.focus(); }, "matter-note-button"));
    } else void persist();
  }, "matter-note-button matter-note-primary");
  section.append(heading);
  if (matterTitle) section.append(matterTitle);
  section.append(node("p", { id: `matter-note-help-${caseId}`, text: "Only you and LPC admins can see this note." }));
  section.append(input, counter, savedAt, feedback, conflict, emptyReview, node("div", { className: "matter-note-actions" }, [save, check]));
  let draft = privateState.matterNotes.get(caseId);
  let busy = false, unavailable = false, loaded = false;
  let editing = Boolean(draft?.dirty || draft?.uncertain || draft?.conflict);
  const preview = node("p", {className:"av2-preserve-lines av2-note-preview"});
  const edit = button("Add note", () => { editing = true; render(); input.focus(); }, "av2-text-link");
  const done = button("Close editor", () => { editing = false; render(); edit.focus(); }, "av2-text-link");
  if (compact) { section.prepend(preview); heading.after(edit, preview); section.querySelector('.matter-note-actions').append(done); }
  section.openEditor = () => { editing = true; render(); input.focus(); };
  const read = async () => readMatterNote(await api.get(`/api/cases/${caseId}/notes`, { signal }), caseId);
  function render() {
    if (signal.aborted) return;
    onTitleChange(loaded && !unavailable ? draft?.caseTitle : null);
    if (matterTitle) matterTitle.textContent = draft?.caseTitle || "";
    input.disabled = !draft || unavailable || !loaded;
    if (draft && input.value !== draft.note) input.value = draft.note;
    save.disabled = !draft?.dirty || !loaded || busy || unavailable || draft.uncertain || Boolean(draft.conflict) || draft.note.length > 10000;
    check.disabled = busy;
    if (compact) {
      check.hidden = !["error","uncertain","conflict"].includes(section.dataset.state);
      check.textContent = "Retry saved note";
      preview.textContent = loaded ? draft?.note || "No note added." : "";
      edit.textContent = draft?.note ? "Edit note" : "Add note";
      edit.disabled = !loaded || unavailable;
      const visible = editing || Boolean(draft?.dirty || draft?.uncertain || draft?.conflict);
      for (const e of [input,counter,savedAt,save,done,section.querySelector(`#matter-note-help-${caseId}`)]) e.hidden = !visible;
      preview.hidden = visible; edit.hidden = visible;
      done.hidden = !visible || Boolean(draft?.dirty || draft?.uncertain || draft?.conflict);
    }
    counter.textContent = draft?.note.length ? `${draft.note.length} / 10,000 characters${draft.note.length > 10000 ? ". This existing note exceeds the save limit. Shorten it before saving; no text has been removed." : ""}` : "";
    savedAt.textContent = draft?.updatedAt ? `Last saved ${new Date(draft.updatedAt).toLocaleString()}` : "";
    conflict.hidden = !draft?.conflict;
    conflict.replaceChildren();
    if (draft?.conflict) {
      const server = draft.conflict;
      conflict.append(node("h3", { text: "This note changed elsewhere" }), node("p", { text: "Your edits are above. Compare the saved note below before choosing which version to use. Keeping your edits requires a separate save." }), node("pre", { text: server.note || "No saved note." }), node("div", { className: "matter-note-actions" }, [
        button("Use saved note and discard my edits", () => { adoptNote(draft, server); section.dataset.state = "ready"; feedback.textContent = "Saved note loaded."; render(); input.focus(); }, "matter-note-button"),
        button("Keep my edits for review", () => { adoptNote(draft, server, true); section.dataset.state = "ready"; feedback.textContent = "Your edits are ready for review. Save when you are ready to replace the saved note."; render(); input.focus(); }, "matter-note-button"),
      ]));
    }
  }
  input.addEventListener("input", () => {
    if (!draft) return;
    editNote(draft, input.value); emptyReview.hidden = true;
    if (!busy && !draft.uncertain && !draft.conflict) feedback.textContent = draft.dirty ? "Unsaved note." : "No unsaved changes.";
    render();
  });
  function denied() {
    privateState.matterNotes.delete(caseId); draft = null; input.value = ""; unavailable = true; savedAt.textContent = ""; emptyReview.replaceChildren(); emptyReview.hidden = true;
    feedback.textContent = "Notes are no longer available for this Matter. Private text has been cleared.";
    section.dataset.state = "restricted";
  }
  async function load({ announce = false } = {}) {
    if (busy || signal.aborted) return;
    busy = true; loaded = false; section.dataset.state = "loading"; feedback.textContent = "Checking saved note…"; render();
    try {
      const server = await read(); if (signal.aborted) return;
      unavailable = false; loaded = true;
      let outcome = "current";
      if (!draft) { draft = noteDraft(server); privateState.matterNotes.set(caseId, draft); }
      else outcome = reconcileNote(draft, server);
      section.dataset.state = outcome === "conflict" ? "conflict" : "ready";
      feedback.textContent = outcome === "conflict" ? "Review both versions below. Your edits have been retained." : outcome === "confirmed" ? "Your submitted note is saved. Any later edits are still above." : draft.dirty ? "Your unsaved edits are retained. Review and save when ready." : announce ? "Saved note is up to date." : "";
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied();
      else { section.dataset.state = "error"; feedback.textContent = "The saved note could not be checked. Your edited text is retained. Check again before saving."; }
    } finally { if (!signal.aborted) { busy = false; render(); } }
  }
  async function persist() {
    if (busy || save.disabled || signal.aborted || !draft) return;
    busy = true; draft.busy = true; draft.uncertain = true; draft.sent = { note: draft.note, revision: draft.revision };
    section.dataset.state = "saving"; feedback.textContent = "Saving Matter note…"; render();
    try {
      const server = readMatterNote(await api.saveMatterNote(caseId, draft.sent.note, draft.sent.revision, { signal, ownerId }), caseId);
      if (signal.aborted) return;
      adoptNote(draft, server, true); section.dataset.state = "ready";
      feedback.textContent = draft.dirty ? "Matter note saved. Your later edits still need saving." : "Matter note saved.";
      onSaved(server);
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied();
      else { section.dataset.state = "uncertain"; feedback.textContent = error.status === 409 ? "The note changed before your save. Your text is retained. Check the saved note to review both versions." : "Saving was not confirmed. Your text is retained. Check the saved note before trying again."; }
    } finally { if (!signal.aborted) { busy = false; if (draft) draft.busy = false; render(); } }
  }
  signal.addEventListener("abort", () => { if (draft) draft.busy = false; }, { once: true });
  if (draft) input.value = draft.note;
  section.refresh = () => load({ announce: true });
  section.readiness = load();
  return section;
}
