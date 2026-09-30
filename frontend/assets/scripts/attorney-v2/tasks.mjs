import { node, page, button, link, recoveryButton, setRecovery } from "./dom.mjs";
import { readTaskPage } from "./private-state.mjs";
import { createMatterPicker } from './matter-picker.mjs';
import { createWeeklyNotes } from "./weekly-notes.mjs";

const objectId = (value) => /^[a-f0-9]{24}$/i.test(value || "");
function message(error, action, linked = false) {
  if (error.kind === "authorization") return "You no longer have permission to do this.";
  if (error.status === 400) return "Check the task fields and try again.";
  if (error.status === 404) {
    if (action !== "Creation") return "This task is no longer available. Refresh the list.";
    return linked ? "The linked Matter is unavailable. Choose another Matter or remove the link." : "The task could not be created. Refresh and try again.";
  }
  return `${action} wasn’t confirmed. Refresh the list to check what happened before trying again.`;
}

export function field(label, control) {
  return node("label", { className: "av2-field" }, [node("span", { text: label }), control]);
}
export function select(options, value, attrs = {}) {
  const control = node("select", attrs, options.map(([key, text]) => node("option", { value: key, text })));
  control.value = value;
  return control;
}

export function createTasks(route, identity, { api, signal, privateState }) {
  const view = page("Private Tasks", "Tasks and notes visible only to you, even when linked to a Matter.");
  view.classList.add("av2-tasks-index");
  const options = { signal, ownerId: identity.id };
  const form = node("form", { className: "av2-private-form", "aria-label": "New private task" });
  const title = node("input", { required: "", maxlength: "200", autocomplete: "off" });
  const notes = node("textarea", { maxlength: "4000", rows: "3" });
  const due = node("input", { type: "datetime-local" });
  const draft = privateState.task;
  title.value = draft.title || ""; notes.value = draft.notes || ""; due.value = draft.due || "";
  const associationPicker = createMatterPicker({ label: 'Matter (optional)', value: draft.caseId, ownerId: identity.id, api, signal });
  const association = associationPicker.input;
  const createStatus = node("p", { role: "status", className: "av2-notice" });
  const create = node("button", { type: "submit", className: "av2-button", text: "Create private task" });
  const checked = button("I checked the list — enable create", () => { draft.uncertain = false; create.disabled = false; checked.hidden = true; createStatus.textContent = "Your draft is ready to submit."; });
  checked.hidden = !draft.uncertain;
  create.disabled = Boolean(draft.uncertain);
  if (draft.uncertain) createStatus.textContent = "The last create request wasn’t confirmed. Check the list for your task before submitting this draft again.";
  const keepDraft = () => { Object.assign(draft, { title: title.value, notes: notes.value, due: due.value, caseId: association.value }); privateState.setTask(draft); };
  form.addEventListener("input", keepDraft); form.addEventListener("change", keepDraft);
  form.append(field("Task title", title), field("Private details (optional)", notes), node("div", { className: "av2-private-fields" }, [field("Due date and time (optional)", due), associationPicker.element]), node("p", { className: "av2-muted", text: "Times use your device’s time zone. Save before refreshing or closing this tab; unsaved text is kept only while this page stays open." }), node("div", { className: "av2-actions" }, [create, checked]), createStatus);
  const newTask = node("section", { className: "av2-card av2-new-task", id: "av2-new-private-task", "aria-label": "New private task" }, [form]);
  newTask.hidden = !(draft.title || draft.notes || draft.uncertain);
  const addTask = button("New private task", () => {
    newTask.hidden = !newTask.hidden;
    addTask.setAttribute("aria-expanded", String(!newTask.hidden));
    if (!newTask.hidden) title.focus();
  }, "av2-button av2-add-task");
  addTask.setAttribute("aria-controls", newTask.id);
  addTask.setAttribute("aria-expanded", String(!newTask.hidden));
  view.querySelector('.av2-view-header').append(addTask);
  const closeForm = button("Close", () => { newTask.hidden = true; addTask.setAttribute("aria-expanded", "false"); addTask.focus(); }, "av2-text-link");
  form.querySelector('.av2-actions').append(closeForm);
  view.append(newTask);

  const filters = node("form", { className: "av2-filters", "aria-label": "Private task filters" });
  const currentStatus = ["open", "done", "all", "overdue"].includes(route.query.get("status")) ? route.query.get("status") : "open";
  const caseId = objectId(route.query.get("caseId")) ? route.query.get("caseId") : "";
  const filterPicker = createMatterPicker({ label: 'Filter by Matter', emptyLabel: 'All Matters', value: caseId, ownerId: identity.id, api, signal });
  const matterFilter = filterPicker.input;
  const routeHref = (changes = {}) => {
    const query = new URLSearchParams(route.query);
    for (const [key, value] of Object.entries(changes)) { if (value) query.set(key, value); else query.delete(key); }
    return `#/tasks?${query}`;
  };
  filters.addEventListener("submit", (event) => { event.preventDefault(); location.hash = routeHref({ status: currentStatus, caseId: matterFilter.value, page: "" }); });
  const tabs = node("nav", { className: "av2-task-tabs", "aria-label": "Task status" });
  for (const [value, label] of [["open", "Open"], ["overdue", "Overdue"], ["done", "Completed"], ["all", "All tasks"]]) {
    const tab = link(label, routeHref({ status: value, page: "" }));
    if (value === currentStatus) tab.setAttribute("aria-current", "page");
    tabs.append(tab);
  }
  matterFilter.addEventListener('change', () => { location.hash = routeHref({ status: currentStatus, caseId: matterFilter.value, page: '' }); });
  filters.append(filterPicker.element);
  const listStatus = node("p", { role: "status", className: "av2-muted" });
  const rows = node("div");
  const refresh = recoveryButton("Retry private tasks", () => void load(), "av2-refresh");
  const list = node("section", { className: "av2-card", "aria-label": "Private task list", tabindex: -1, "data-av2-region": "private-tasks" }, [node("div", { className: "av2-card-heading av2-task-list-heading" }, [node("h2", { text: "Your tasks", tabindex: -1 }), refresh]), node("div", { className: "av2-task-toolbar" }, [tabs, filters]), listStatus, rows]);
  view.append(list);
  let generation = 0;
  async function load() {
    if (signal.aborted) return;
    const ticket = ++generation;
    list.dataset.state = "loading"; refresh.disabled = true; rows.replaceChildren(); listStatus.textContent = "Loading private tasks…";
    const query = new URLSearchParams({ status: currentStatus === "overdue" ? "open" : currentStatus, limit: "20", page: String(Math.min(100000, Math.max(1, Number.parseInt(route.query.get("page"), 10) || 1))) });
    if (currentStatus === "overdue") query.set("overdue", "true");
    if (caseId) query.set("caseId", caseId);
    try {
      const data = readTaskPage(await api.get(`/api/checklist?${query}`, { signal }));
      if (signal.aborted || ticket !== generation) return;
      list.dataset.state = "ready";
      listStatus.textContent = data.total ? "" : "No tasks match these filters.";
      for (const task of data.items) rows.append(taskRow(task));
      if (!data.items.length && data.total) rows.append(node("p", { text: "There are no tasks on this page." }));
      const paging = node("nav", { className: "av2-actions av2-task-paging", "aria-label": "Task pages" });
      if (data.total) paging.append(node("span", { text: `${data.total} ${data.total === 1 ? "task" : "tasks"}` }));
      if (data.page > 1) paging.append(link("Previous task page", routeHref({ page: data.page - 1 })));
      if (data.page < data.pages) paging.append(link("Next task page", routeHref({ page: data.page + 1 })));
      rows.append(paging);
    } catch (error) {
      if (signal.aborted || ticket !== generation) return;
      list.dataset.state = "error"; listStatus.textContent = error.kind === "authorization" ? "These tasks are no longer available to your account." : "Private tasks couldn’t be loaded. Refresh to try again.";
    } finally { if (!signal.aborted && ticket === generation) refresh.disabled = false;
      if (!signal.aborted) setRecovery(refresh, list);
    }
  }
  function taskRow(task) {
    const notice = node("p", { role: "status" });
    const toggle = button(task.done ? "Reopen task" : "Mark complete", () => void mutate("toggle"));
    toggle.className = 'av2-task-complete';
    toggle.setAttribute('aria-label', `${task.done ? 'Reopen task' : 'Mark complete'}: ${task.title}`);
    toggle.setAttribute('aria-pressed', String(task.done));
    toggle.textContent = task.done ? '✓' : '';
    const remove = button("Delete task", () => { confirmation.hidden = false; confirm.focus(); });
    const confirm = button("Confirm delete", () => void mutate("delete"));
    const cancel = button("Keep task", () => { confirmation.hidden = true; remove.focus(); });
    const confirmation = node("div", { className: "av2-notice" }, [node("p", { text: "Permanently delete this private task?" }), node("div", { className: "av2-actions" }, [confirm, cancel])]);
    confirmation.hidden = true;
    const date = task.due ? new Date(task.due) : null;
    const overdue = !task.done && date && Number.isFinite(date.getTime()) && date < new Date();
    const summary = node("summary", { text: "Task details" });
    const details = node("details", { className: "av2-preview" }, [summary, node("p", { className: "av2-preserve-text", text: task.notes || "No private details added." })]);
    if (objectId(task.caseId)) details.append(link("View linked Matter", `#/matters/${task.caseId}/overview`));
    const row = node("article", { className: "av2-task-row", "data-av2-task": task.id }, [node("div", { className: "av2-row-heading" }, [toggle, node("div", { className: "av2-task-identity" }, [node("h3", { text: task.title }), node("span", { className: "av2-status", text: task.done ? "Completed" : overdue ? "Overdue" : "Open" })])]), node("p", { className: "av2-muted av2-task-due", text: date && Number.isFinite(date.getTime()) ? `Due ${date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : "" }), details, confirmation, notice]);
    details.append(node("div", { className: "av2-actions" }, [remove]));
    async function mutate(action) {
      if (toggle.disabled || signal.aborted) return;
      toggle.disabled = remove.disabled = confirm.disabled = true;
      notice.textContent = action === "delete" ? "Deleting…" : "Saving…";
      try {
        const result = await (action === "delete" ? api.deletePrivateTask(task.id, options) : api.togglePrivateTask(task.id, options));
        if (result?.ok !== true || (action === "toggle" && typeof result.done !== "boolean")) throw new Error("invalid_response");
        if (!signal.aborted) {
          await load();
          const next = rows.querySelector(`[data-av2-task="${task.id}"] .av2-task-complete`) || rows.querySelector('.av2-task-complete') || list;
          next.focus({ preventScroll: true });
        }
      } catch (error) {
        if (signal.aborted) return;
        notice.textContent = message(error, action === "delete" ? "Deletion" : "Task completion");
        // A toggle is non-idempotent. A fresh read must precede another attempt.
        setRecovery(refresh, list, { pending: true, label: 'Check task status' });
        refresh.focus();
      }
    }
    return row;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (create.disabled || signal.aborted || !form.reportValidity()) return;
    keepDraft(); draft.uncertain = true; create.disabled = true; checked.hidden = true; createStatus.textContent = "Creating private task…";
    try {
      const date = due.value ? new Date(due.value) : null;
      if (date && !Number.isFinite(date.getTime())) throw new Error("invalid_date");
      const result = await api.createPrivateTask({ title: title.value.trim(), notes: notes.value, due: date?.toISOString() || null, caseId: association.value || null }, options);
      if (!objectId(result?.id)) throw new Error("invalid_response");
      if (signal.aborted) return;
      title.value = notes.value = due.value = ""; associationPicker.clear();
      draft.uncertain = false; keepDraft(); create.disabled = false;
      createStatus.textContent = "Private task created. It appears when it matches your list filters.";
      await load(); title.focus();
    } catch (error) {
      if (signal.aborted) return;
      createStatus.textContent = message(error, "Creation", Boolean(association.value));
      if (error.status >= 400 && error.status < 500) { draft.uncertain = false; create.disabled = false; }
      else checked.hidden = false;
    }
  });
  const weekly = createWeeklyNotes(route, { api, signal, privateState, ownerId: identity.id });
  const notesSection = node("details", { className: "av2-private-notes" }, [node("summary", { text: "Private notes" }), weekly]);
  notesSection.open = route.query.has("week") || route.query.has("calendar") || [...privateState.weeks.values()].some(week => week.dirty || week.uncertain);
  view.append(notesSection);
  view.readiness = Promise.allSettled([load(), associationPicker.readiness, filterPicker.readiness, weekly.readiness]);
  return view;
}
