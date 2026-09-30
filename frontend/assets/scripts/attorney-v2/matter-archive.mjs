import { node, button, link, page } from "./dom.mjs";
import { matterReturnHref, withMatterReturn } from "./matter-return.mjs";
import { readArchive, confirmsArchive, archiveReason, archiveAction, archiveEffect, archiveStatus } from "./archive-model.mjs";

export function createMatterArchive(caseId, { api, signal, privateState, ownerId, current = false, showHeading = true, compact = false, onRecorded = () => {}, onNavigate = () => {}, route }) {
  const state = privateState.archives.get(caseId) || {}; privateState.archives.set(caseId, state);
  const section = node("section", { className: "matter-notes matter-archive", "aria-label": "Archive and restore", "data-matter-archive": caseId });
  const feedback = node("p", { role: "status", "data-archive-feedback": "" }), body = node("div"), review = node("div", { className: "matter-note-conflict" });
  const check = button("Check archive status", () => void load(), "matter-note-button");
  const start = button("Review archive change", () => {
    if (!loaded || busy || state.pending || !state.value?.canChange) return;
    state.review = { revision: state.value.revision, archived: state.value.targetArchived }; render(); review.querySelector("button")?.focus();
  }, "matter-note-button matter-note-primary");
  if (showHeading) section.append(node("h2", { text: "Archive and restore" }));
  section.append(feedback, body, node("div", { className: "matter-note-actions" }, [check, start]), review);
  let busy = false, loaded = false;
  const alive = () => !signal.aborted;
  function message(text, phase = "ready") { feedback.textContent = text; section.dataset.state = phase; }
  function recorded(value) { Promise.resolve().then(() => onRecorded(value)).catch(() => { if (alive()) message("The archive change was recorded. Refresh the Matter list to see its current position."); }); }
  function render() {
    if (!alive()) return;
    body.replaceChildren(); review.replaceChildren(); review.hidden = !state.review && !state.pending;
    check.disabled = busy; start.disabled = !loaded || busy || !state.value?.canChange || Boolean(state.pending || state.review);
    const value = state.value;
    if (compact) {check.hidden = !state.pending && !["error","uncertain","conflict"].includes(section.dataset.state); check.textContent = "Retry archive status"; start.hidden = !loaded || !value?.canChange; }
    if (value) {
      if (!compact) body.append(node("h3", { text: value.caseTitle }), node("p", { text: `Lifecycle status: ${archiveStatus(value)}` }));
      body.append(node("p", { text: archiveReason(value) }));
      if (value.canChange && !state.review) body.append(node("p", { text: archiveEffect(value) }));
      const view = value.archived ? "archived" : value.restoredView;
      const list = link("View current Matter list", current ? `/dashboard-attorney.html#cases:${view === "applications" ? "inquiries" : view}` : `#/matters?view=${view}&highlightCase=${caseId}`, "matter-note-button");
      list.addEventListener("click", onNavigate);
      if (!compact) body.append(node("div", { className: "matter-note-actions" }, [list, link("Review Matter details", current ? `/dashboard-attorney.html?previewCaseId=${caseId}#cases:${view === "applications" ? "inquiries" : view}` : withMatterReturn(`#/matters/${caseId}/overview`, route), "matter-note-button")]));
    }
    if (state.pending) review.append(node("p", { text: "This request is unconfirmed. Check archive status before trying again." }));
    else if (state.review && value) {
      review.append(node("h3", { text: `${archiveAction(value)}?` }), node("p", { text: archiveEffect(value) }), node("div", { className: "matter-note-actions" }, [
        button(archiveAction(value), () => void persist(), "matter-note-button matter-note-primary"),
        button("Cancel", () => { delete state.review; render(); start.focus(); }, "matter-note-button"),
      ]));
      review.querySelectorAll("button").forEach(control => { control.disabled = busy || !loaded; });
    }
  }
  function denied() {
    privateState.archives.delete(caseId); Object.keys(state).forEach(key => delete state[key]); loaded = false;
    message("This Matter's archive controls are no longer available to your account.", "restricted");
  }
  async function load() {
    if (busy || !alive()) return;
    busy = true; loaded = false; delete state.value; message("Checking archive status…", "loading"); render();
    try {
      const value = readArchive(await api.readMatterArchive(caseId, { signal, ownerId }), caseId, ownerId);
      if (!alive()) return;
      const pending = state.pending, changed = state.review && state.review.revision !== value.revision;
      state.value = value; loaded = true; delete state.pending;
      if (confirmsArchive(value, pending)) { delete state.review; message("Your archive change was recorded. The status below is current."); recorded(value); }
      else if (pending || changed) { delete state.review; message(pending ? "The earlier request could not be confirmed. The current Matter state is shown below; review it before choosing another change." : "The Matter changed after your review. Review its current state before continuing.", "conflict"); }
      else message(compact ? "" : "Archive status is up to date.");
    } catch (error) {
      if (!alive()) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied();
      else message("Archive status could not be checked. Any unconfirmed request is retained. Check again before continuing.", "error");
    } finally { if (alive()) { busy = false; render(); } }
  }
  async function persist() {
    if (!alive() || busy || !loaded || state.pending || !state.value?.canChange || state.review?.revision !== state.value.revision || state.review.archived !== state.value.targetArchived) return;
    const sent = { ...state.review, requestId: crypto.randomUUID() }; state.pending = sent; state.busy = true; busy = true; message("Saving archive change…", "saving"); render();
    try {
      const result = await api.changeMatterArchive(caseId, sent, { signal, ownerId });
      if (!alive()) return;
      const value = readArchive(result.archive, caseId, ownerId);
      if (result.ok !== true || !confirmsArchive(value, sent)) throw new Error("unconfirmed_archive");
      state.value = value; delete state.pending; delete state.review; message("Your archive change was recorded. The status below is current."); recorded(value);
    } catch (error) {
      if (!alive()) return;
      if ([401, 403, 404].includes(error.status) || error.kind === "authentication") denied();
      else message("The archive result was not confirmed. Check archive status before trying again.", "uncertain");
    } finally { if (alive()) { busy = false; state.busy = false; render(); } }
  }
  signal.addEventListener("abort", () => { state.busy = false; section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
export function createArchivePage(route, identity, context) {
  const section = page("Archive and restore");
  section.firstChild.append(link("Back to Matters", matterReturnHref(route)));
  const archive = createMatterArchive(route.caseId, { ...context, route, ownerId: identity.id, showHeading: false }); section.append(archive); section.readiness = archive.readiness; return section;
}
