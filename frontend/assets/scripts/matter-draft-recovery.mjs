import { draftFields, draftLabels, draftValues } from "./matter-draft-contract.mjs";

// Plain DOM shared by V1 and V2; draft text never enters HTML or browser storage.
export function createDraftRecovery(actions, { buttonClass = "av2-secondary", className = "av2-card av2-draft-status" } = {}) {
  const make = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };
  const root = make("section"); root.className = `${className} lpc-draft-save`; root.setAttribute("aria-label", "Draft save status");
  const status = make("p"); status.setAttribute("role", "status");
  const controls = make("div"); controls.className = "av2-actions";
  const button = (text, callback) => { const control = make("button", text); control.type = "button"; control.className = buttonClass; control.addEventListener("click", callback); controls.append(control); return control; };
  const save = button("Save draft", () => void actions.save());
  const check = button("Check saved draft", () => void actions.check());
  const comparison = make("div");
  const saved = button("Use saved draft", () => actions.choose(false));
  const keep = button("Keep my edits", () => actions.choose(true));
  root.append(status, comparison, controls);
  function render(state) {
    const saveHadFocus = document.activeElement === save;
    root.dataset.compact = String(state.loaded && !state.busy && !state.uncertain && !state.conflict && !state.error && !state.deleted && !state.missing);
    root.dataset.state = state.deleted ? "deleted" : state.busy ? "busy" : state.uncertain ? "uncertain" : state.loaded ? "ready" : "loading";
    status.textContent = state.deleted ? "Draft deleted." : state.busy ? (state.action === "delete" ? "Deleting draft…" : "Checking or saving draft…") : state.error || (!state.loaded ? "Loading draft…" : state.dirty ? "Unsaved changes. Drafts save automatically while you work." : state.id ? "Draft saved." : "Your draft will save when you add details.");
    if (state.dirty && !state.busy && !state.uncertain && state.loaded) status.textContent = "Unsaved changes. Select Save draft to save now.";
    save.hidden = Boolean(state.restricted);
    save.disabled = !state.loaded || state.busy || state.uncertain || state.deleted || state.missing || !state.dirty;
    check.disabled = state.busy || state.deleted;
    if (saveHadFocus && save.hidden && !check.disabled) check.focus();
    check.hidden = state.loaded && !state.uncertain;
    saved.hidden = keep.hidden = !state.conflict;
    saved.disabled = keep.disabled = state.busy;
    comparison.replaceChildren();
    comparison.hidden = !state.conflict;
    if (state.conflict) {
      comparison.append(make("h2", "Review draft changes"), make("p", "Keep my edits keeps the fields you changed and includes saved changes to other fields. Review the result before saving."));
      const local = draftValues(state.values, { descriptionLimit: state.descriptionLimit || 4000 }), remote = state.conflict.values;
      for (const key of [...draftFields, "requirements", "sourceDescription", "appliedSourceDescription", "pendingRequirement"].filter((key) => JSON.stringify(local[key]) !== JSON.stringify(remote[key]))) {
        const section = make("section"); section.append(make("h3", draftLabels[key] || (key === "pendingRequirement" ? "Unfinished requirement" : key === "appliedSourceDescription" ? "Last applied description" : key === "sourceDescription" ? "Original description" : "Requirements")));
        const display = (value) => key === "requirements" ? (value || []).join("\n") || "(empty)" : key === "tasks" ? value.map((task) => task.title).join("\n") || "(empty)" : value || "(empty)";
        section.append(make("strong", "Your edits"), make("pre", display(local[key])), make("strong", "Saved version"), make("pre", display(remote[key])));
        comparison.append(section);
      }
    }
  }
  return { root, render };
}
