import { node, link, recoveryButton, setRecovery } from "./dom.mjs";
import { objectId } from "./workspace-model.mjs";
import { readWork, workNotice } from "./work-model.mjs";
export function createWorkspaceWork(caseId, { api, signal, ownerId, route, privateState, hasClosedWorkNotice = false }) {
  const section = node("section", { "aria-label": "Matter work", "data-workspace-work": "" });
  const feedback = node("p", { role: "status" }), notice = node("p"), summary = node("p"), list = node("ol", { className: "av2-work-review-list" }), actions = node("div", { className: "av2-actions" });
  const state = privateState.workReviews.get(caseId) || { pending: null, busy: false }; privateState.workReviews.set(caseId, state); state.busy = false;
  const refresh = recoveryButton("Retry work", () => void load());
  let review = null, reading = false, quietRead = false, readController = null, sequence = 0;
  section.append(node("h2", { text: "Work" }), notice, feedback, summary, list, actions, refresh);
  const options = { signal, ownerId };
  function controls() {
    refresh.disabled = reading || state.busy; refresh.textContent = state.pending ? "Check saved work" : "Refresh work";
    for (const input of list.querySelectorAll("input")) input.disabled = reading && !quietRead || state.busy || !review?.items[Number(input.dataset.workIndex)]?.canToggle;

    setRecovery(refresh, section, { pending: Boolean(state.pending), label: "Check saved work" });
  }
  function render() {
    const focused = document.activeElement?.closest?.("[data-work-index]")?.dataset.workIndex;
    notice.textContent = hasClosedWorkNotice && review.reason === "closed" ? "" : workNotice(review); notice.hidden = !notice.textContent; const count = review.items.filter(item => item.completed).length;
    summary.textContent = review.items.length ? `${count} of ${review.items.length} work items complete` : "No work items are recorded.";
    list.replaceChildren(...review.items.map(item => {
      const input = node("input", { type: "checkbox", id: `av2-work-${caseId}-${item.index}`, "data-work-index": item.index }); input.checked = item.completed;
      input.addEventListener("change", () => { const next = input.checked; input.checked = item.completed; void save(item, next); });
      return node("li", { "data-work-index": item.index, ...(item.id ? { "data-task-id": item.id } : {}), tabindex: "-1" }, [node("label", { for: input.id }, [input, node("span", { text: item.title })])]);
    }));
    actions.replaceChildren(link("Private tasks for this Matter", `#/tasks?caseId=${caseId}`));
    if (review.canEditScope) actions.prepend(link("Edit the posted scope", `#/matters/new?caseId=${caseId}`));
    controls();
    if (focused !== undefined) focusItem(Number(focused));
  }
  function focusItem(index) { const row = list.querySelector(`li[data-work-index="${index}"]`), input = row?.querySelector("input"); if (input && !input.disabled) input.focus({ preventScroll: true }); else row?.focus({ preventScroll: true }); }
  function failed(error) {
    review = null; list.replaceChildren(); actions.replaceChildren(); summary.textContent = ""; notice.textContent = ""; notice.hidden = true; section.dataset.state = "error";
    if ([401, 403, 404].includes(error.status)) { state.pending = null; privateState.workReviews.delete(caseId); feedback.textContent = "Work is no longer available to this account. Refresh the Matter to check its access."; }
    else feedback.textContent = error.code === "WORKSPACE_WORK_CHANGED" ? "The work list changed while loading. Refresh work to review the current list." : "Work couldn’t load. Try again.";
  }
  async function load({ quiet = false } = {}) {
    if (reading || state.busy || signal.aborted) return;
    reading = true; quietRead = quiet; const ticket = ++sequence; readController = new AbortController(); controls(); if (!quiet) { section.dataset.state = "loading"; feedback.textContent = "Loading work…"; }
    try {
      const next = readWork(await api.readWorkspaceWork(caseId, { ...options, signal: readController.signal }), caseId); if (signal.aborted || ticket !== sequence) return;
      const changed = review?.revision !== next.revision; review = next; if (changed || !quiet) render(); section.dataset.state = "ready";
      if (state.pending) {
        const item = review.items[state.pending.index]; feedback.textContent = item ? `Current saved status for “${item.title}”: ${item.completed ? "Complete" : "Awaiting attorney review"}.` : "The previously selected work item is no longer in this scope.";
        state.pending = null;
      } else if (!quiet) feedback.textContent = "";
      const target = objectId(route.query.get("taskId"));
      if (target && !quiet) {
        const selected = list.querySelector(`[data-task-id="${target}"]`);
        if (selected) requestAnimationFrame(() => { if (!signal.aborted) { selected.scrollIntoView({ block: "center" }); selected.focus({ preventScroll: true }); } });
        else feedback.textContent = "The linked work item couldn’t be identified. Review the agreed scope below.";
      }
    } catch (error) { if (!signal.aborted && ticket === sequence) failed(error); }
    finally { if (!signal.aborted && ticket === sequence) { reading = false; quietRead = false; readController = null; controls(); } }
  }
  async function save(item, completed) {
    if (!review || state.busy || reading && !quietRead || !item.canToggle || signal.aborted) return;
    if (reading) { sequence++; readController?.abort(); readController = null; reading = false; quietRead = false; }
    state.pending = { index: item.index, completed }; state.busy = true; controls(); feedback.textContent = "Recording work review…";
    try {
      const response = await api.updateWorkspaceWork(caseId, item.index, completed, review.revision, options);
      if (signal.aborted) return;
      const next = readWork(response?.work, caseId); review = next; render(); state.pending = null;
      feedback.textContent = next.items[item.index]?.completed === completed ? `“${item.title}” marked ${completed ? "complete" : "awaiting attorney review"}.` : "The saved work changed again. Review the current list before continuing.";
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status)) failed(error);
      else { for (const input of list.querySelectorAll("input")) input.disabled = true; review = null; feedback.textContent = error.status === 409 ? "The work or Matter status changed. Refresh work before making another decision." : "This work change could not be confirmed. Refresh work to check its current saved status."; }
    } finally { if (!signal.aborted) { state.busy = false; controls(); focusItem(item.index); } }
  }
  section.sync = () => state.busy ? Promise.resolve() : load({ quiet: true });
  signal.addEventListener("abort", () => { sequence++; readController?.abort(); state.busy = false; review = null; section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}
