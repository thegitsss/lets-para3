import { node, button, recoveryButton, setRecovery } from "./dom.mjs";
import { BUILT_IN_VIEWS, VIEW_SCOPE, viewFilters, viewName, readSavedViews, sameFilters, matchesCreation, filterDescription } from "./saved-view-model.mjs";

export function mountAttorneySavedViews({ picker, saveButton, deleteButton, status, host, getState, applyState, api, privateState, ownerId, signal, builtIns = BUILT_IN_VIEWS }) {
  const state = privateState.savedViews;
  let busy = false, loaded = false, destroyed = false, epoch = 0;
  const check = recoveryButton("Retry saved views", () => void load(), "saved-view-button");
  const review = node("div", { className: "saved-view-review" });
  const region = node("section", { className: "attorney-saved-views", "aria-label": "Saved view management", "data-saved-views": "" }, [check, review]);
  host.append(region);
  const valid = (ticket = epoch) => ticket === epoch && !signal.aborted && !destroyed;
  const describe = (filters) => node("dl", { className: "saved-view-filters" }, filterDescription(filters).map(([label, value]) => node("div", {}, [node("dt", { text: label }), node("dd", { text: value })])));
  function message(value, phase = "ready") { status.textContent = value; region.dataset.state = phase; }
  function currentSelection() {
    const filters = getState();
    if (state.selected?.startsWith("saved:")) { const chosen = state.views?.find((view) => view.id === state.selected.slice(6)); if (chosen && sameFilters(chosen.filters, filters)) return state.selected; }
    const builtIn = builtIns.find((view) => sameFilters(view.filters, filters));
    return builtIn ? `builtin:${builtIn.id}` : "custom";
  }
  function populate() {
    const built = node("optgroup", { label: "Built-in views" }, builtIns.map((view) => node("option", { value: `builtin:${view.id}`, text: view.name })));
    const saved = node("optgroup", { label: "Your saved views" }, (state.views || []).map((view) => node("option", { value: `saved:${view.id}`, text: view.name })));
    picker.replaceChildren(built, node("option", { value: "custom", text: "Custom view" }), saved);
    picker.value = currentSelection();
    saveButton.disabled = !loaded || busy || Boolean(state.pending || state.draft || state.deleting);
    deleteButton.hidden = !picker.value.startsWith("saved:");
    deleteButton.disabled = !loaded || busy || Boolean(state.pending || state.draft || state.deleting);
    picker.disabled = busy;
    check.disabled = busy;
    setRecovery(check, region, { pending: Boolean(state.pending), label: "Check saved views" });
  }
  function renderReview() {
    if (!valid()) return;
    review.replaceChildren(); review.hidden = !state.draft && !state.deleting && !state.pending;
    if (state.draft) {
      const draft = state.draft;
      const name = node("input", { type: "text", maxlength: 48, autocomplete: "off", id: "attorney-saved-view-name" }); name.value = draft.name;
      name.disabled = busy || Boolean(state.pending);
      const form = node("form", {}, [node("h3", { text: "Save this Matter view" }), node("label", { for: name.id, text: "View name" }), name, describe(draft.filters)]);
      name.addEventListener("input", () => { draft.name = name.value; });
      const submit = node("button", { type: "submit", className: "saved-view-button saved-view-primary", text: "Save view" });
      submit.disabled = busy || !loaded || Boolean(state.pending);
      form.append(node("div", { className: "saved-view-actions" }, [submit, button("Cancel view creation", () => { delete state.draft; message("View creation canceled."); renderReview(); populate(); saveButton.focus(); }, "saved-view-button")]));
      form.lastChild.lastChild.disabled = busy || Boolean(state.pending);
      form.addEventListener("submit", (event) => { event.preventDefault(); void create(); });
      review.append(form);
    }
    if (state.deleting && !state.pending) {
      const view = state.deleting;
      review.append(node("h3", { text: `Delete saved view “${view.name}”?` }), node("p", { text: "Your Matters and applied filters stay unchanged." }), describe(view.filters), node("div", { className: "saved-view-actions" }, [
        button("Delete view", () => void remove(view), "saved-view-button"),
        button("Keep saved view", () => { delete state.deleting; message("Saved view kept."); renderReview(); populate(); picker.focus(); }, "saved-view-button"),
      ]));
      review.querySelectorAll("button").forEach((control) => { control.disabled = busy || !loaded; });
    }
  }
  function clear() {
    epoch += 1; busy = false; Object.keys(state).forEach((key) => delete state[key]); loaded = false;
    review.replaceChildren(); review.hidden = true; populate();
    message("Saved views are unavailable until your account is verified.", "restricted");
  }
  function deny(error) { if ([401, 403].includes(error.status) || error.kind === "authentication") { clear(); return true; } return false; }
  async function load() {
    if (busy || !valid()) return;
    const ticket = epoch; busy = true; loaded = false; populate(); renderReview(); message("Checking saved views…", "loading");
    try {
      const views = readSavedViews(await api.readMatterViews({ signal, ownerId }), ownerId);
      if (!valid(ticket)) return;
      state.views = views; loaded = true;
      const pending = state.pending;
      if (pending?.action === "create") {
        const stored = views.find((view) => view.id === pending.sent.id);
        if (matchesCreation(stored, pending.sent)) { state.selected = `saved:${stored.id}`; delete state.pending; delete state.draft; message("View saved."); }
        else if (stored) { message("That view ID has different saved filters. Your original draft is retained; start a separate view after review.", "conflict"); delete state.pending; state.draft.id = crypto.randomUUID(); }
        else { delete state.pending; message("No saved view was found for that request. Your draft is retained; you can save it again."); }
      } else if (pending?.action === "delete") {
        const stored = views.find((view) => view.id === pending.view.id);
        delete state.pending;
        if (!stored) { delete state.deleting; message("Saved view deleted."); }
        else { state.deleting = stored; message(stored.revision === pending.view.revision ? "The saved view is still present. Review it before trying deletion again." : "The saved view changed. Review its latest filters before deleting it.", "conflict"); }
      } else if (state.deleting) {
        const stored = views.find((view) => view.id === state.deleting.id);
        state.deleting = stored || null;
        message(stored ? "The latest saved filters are shown for deletion review." : "The saved view is no longer present.");
      } else message("");
    } catch (error) {
      if (!valid(ticket)) return;
      if (!deny(error)) { delete state.views; message("Saved views could not be checked. Any unfinished request is retained. Check again before saving or deleting.", "error"); }
    } finally { if (valid(ticket)) { busy = false; state.busy = false; populate(); renderReview(); } }
  }
  async function create() {
    if (busy || !loaded || state.pending || !state.draft || !valid()) return;
    const ticket = epoch;
    let name;
    try { name = viewName(state.draft.name); } catch { message("Enter a view name of 1–48 characters.", "error"); return; }
    if (state.draft.filters.search.length > 200 || state.draft.filters.practice.length > 120) { message("These filters exceed the saved-view limits. Shorten them before saving.", "error"); return; }
    state.draft.name = name;
    const sent = { id: state.draft.id, name, filters: { ...state.draft.filters }, scope: VIEW_SCOPE, revision: null };
    state.pending = { action: "create", sent }; busy = true; state.busy = true; message("Saving view…", "saving"); populate(); renderReview();
    try {
      const result = await api.saveMatterView(sent, { signal, ownerId }); if (!valid(ticket)) return;
      const [saved] = readSavedViews({ ownerId, scope: VIEW_SCOPE, views: [result.view] }, ownerId);
      if (!matchesCreation(saved, sent)) throw new Error("invalid_saved_view");
      state.views = [...(state.views || []).filter((view) => view.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
      state.selected = `saved:${saved.id}`; delete state.draft; delete state.pending; message("View saved.");
    } catch (error) {
      if (!valid(ticket)) return;
      if (!deny(error)) {
        const known = { SAVED_VIEW_DUPLICATE_NAME: "A view with that name already exists. Choose another name.", SAVED_VIEW_LIMIT: "You can save up to 12 views. Delete an unused view or cancel this draft.", SAVED_VIEW_INVALID: "The view name or filters are invalid. Review them before saving." }[error.code];
        if (known) { delete state.pending; message(known, "error"); }
        else message("Saving was not confirmed. Check saved views before trying again.", "uncertain");
      }
    } finally { if (valid(ticket)) { busy = false; state.busy = false; populate(); renderReview(); } }
  }
  async function remove(view) {
    if (busy || !loaded || state.pending || !valid()) return;
    const ticket = epoch;
    state.pending = { action: "delete", view }; busy = true; state.busy = true; message("Deleting saved view…", "saving"); populate(); renderReview();
    try {
      const result = await api.deleteMatterView(view.id, view.revision, { signal, ownerId }); if (!valid(ticket)) return;
      if (result?.ok !== true) throw new Error("invalid_deletion");
      state.views = state.views.filter((item) => item.id !== view.id); delete state.pending; delete state.deleting; message("Saved view deleted.");
    } catch (error) { if (valid(ticket) && !deny(error)) message("Deletion was not confirmed. Check saved views before trying again.", "uncertain"); }
    finally { if (valid(ticket)) { busy = false; state.busy = false; populate(); renderReview(); } }
  }
  const select = (value, { apply = true } = {}) => {
    state.selected = value; picker.value = value;
    if (apply) {
      const view = value.startsWith("saved:") ? state.views?.find((item) => item.id === value.slice(6)) : builtIns.find((item) => item.id === value.slice(8));
      if (view) applyState(viewFilters(view.filters), view);
    }
    populate();
  };
  picker.addEventListener("change", () => select(picker.value), { signal });
  saveButton.addEventListener("click", () => { if (!loaded || busy || state.pending || state.draft) return; state.draft = { id: crypto.randomUUID(), name: "", filters: viewFilters(getState()) }; renderReview(); populate(); review.querySelector("input")?.focus(); }, { signal });
  deleteButton.addEventListener("click", () => { if (!loaded || busy || state.pending) return; state.deleting = state.views.find((view) => `saved:${view.id}` === picker.value); renderReview(); populate(); review.querySelector("button")?.focus(); }, { signal });
  const checkIdentity = (value) => { try { const user = typeof value === "string" ? JSON.parse(value) : value; if (String(user?.id || user?._id || "") !== ownerId || user?.role !== "attorney") clear(); } catch { clear(); } };
  window.addEventListener("storage", (event) => { if (event.key === "lpc_user") checkIdentity(event.newValue); }, { signal });
  window.addEventListener("lpc:user-updated", (event) => checkIdentity(event.detail), { signal });
  window.addEventListener("beforeunload", (event) => { if (state.draft || state.pending || state.busy) { event.preventDefault(); event.returnValue = ""; } }, { signal });
  window.addEventListener("pagehide", clear, { signal });
  signal.addEventListener("abort", () => { state.busy = false; destroyed = true; }, { once: true });
  populate(); const readiness = load();
  return { readiness, load, clear, element: region, check, markCustom() { state.selected = "custom"; populate(); }, select };
}

export function createSavedViews({ api, privateState, signal, ownerId, getState, applyState }) {
  const picker = node("select", { id: "av2-saved-views", "aria-label": "Saved views" });
  const saveButton = node("button", { type: "button", text: "Save applied view", className: "saved-view-button" });
  const deleteButton = node("button", { type: "button", text: "Delete selected view", className: "saved-view-button" });
  const status = node("p", { role: "status" });
  const host = node("div", { className: "attorney-saved-views av2-saved-views-host" });
  const controller = mountAttorneySavedViews({ picker, saveButton, deleteButton, status, host, getState, applyState, api, privateState, signal, ownerId });
  controller.element.prepend(node("div", { className: "av2-saved-view-toolbar" }, [
    node("label", { for: picker.id }, [node("span", { text: "Saved views" }), picker]),
    node("div", { className: "saved-view-actions" }, [saveButton, deleteButton, controller.check]),
  ]));
  host.append(status);
  host.readiness = controller.readiness; return host;
}
