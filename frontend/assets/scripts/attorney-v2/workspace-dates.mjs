import { node, button, link, recoveryButton, setRecovery } from "./dom.mjs";
import { matterLink, objectId } from "./workspace-model.mjs";
import { readDates, readDateOperation, dateTypes, dateFields, dateChanges, calendarLabel, wallInstants, occurrenceLabel, validDate } from "./dates-model.mjs";

export function createWorkspaceDates(caseId, { api, signal, ownerId, route, privateState }) {
  const section = node("section", { "aria-label": "Your Matter calendar", "data-workspace-dates": "" }), feedback = node("p", { role: "status" }), count = node("p", { className: "av2-muted" }), list = node("ol", { className: "av2-calendar-list" }), detail = node("div", { "data-calendar-detail": "" }), editor = node("div", { "data-calendar-editor": "" });
  const state = privateState.dateReviews.get(caseId) || { draft: null, pending: null, from: "", to: "", selectedId: null };
  privateState.dateReviews.set(caseId, state); state.busy = false;
  let review = null, rows = [], cursor = null, reading = false, transfer = null, selectedId = objectId(route.query.get("eventId")) || state.selectedId;
  const options = { signal, ownerId }, refresh = recoveryButton("Retry calendar", () => void load()), more = button("Show more dates", () => void load({ more: true })), add = button("Add calendar entry", () => openEditor("create"), "av2-button");
  const from = node("input", { id: `av2-date-from-${caseId}`, type: "date", value: state.from }), to = node("input", { id: `av2-date-to-${caseId}`, type: "date", value: state.to });
  const filters = node("div", { className: "av2-date-grid" }, [node("label", { for: from.id, text: "From date (UTC)" }), from, node("label", { for: to.id, text: "Through date (UTC)" }), to]);
  const apply = button("Filter dates", () => { if (from.value && !validDate(from.value) || to.value && !validDate(to.value) || from.value && to.value && from.value > to.value) { feedback.textContent = "Enter a valid date range."; return; } state.from = from.value; state.to = to.value; void load(); });
  const reset = button("Show all dates", () => { state.from = ""; state.to = ""; from.value = ""; to.value = ""; void load(); });
  const recovery = node("div", { "data-calendar-recovery": "" }), check = button("Check saved action", () => void checkPending()), retry = button("Retry the reviewed action", () => void perform());
  const stop = button("Stop waiting", () => transfer?.abort()); stop.hidden = true;
  section.append(node("h3", { text: "Your calendar" }), node("p", { text: "Your own calendar entries linked to this Matter. Adding an entry does not change the Matter’s deadline or add it to the paralegal’s calendar." }), node("div", { className: "av2-actions" }, [add, refresh]), filters, node("div", { className: "av2-actions" }, [apply, reset]), feedback, count, list, more, detail, editor, recovery, stop);
  function controls() {
    add.disabled = !review || reading || state.busy || Boolean(state.pending || state.draft);
    refresh.disabled = reading || state.busy; more.disabled = reading || state.busy; more.hidden = !cursor;
    for (const control of [apply, reset, from, to]) control.disabled = reading || state.busy;
    for (const control of [...detail.querySelectorAll("button"), ...editor.querySelectorAll("button,input,textarea,select")]) control.disabled = reading || state.busy || Boolean(state.pending);
    check.disabled = reading || state.busy; retry.disabled = reading || state.busy || !state.retryReviewed; stop.hidden = !state.busy;

    setRecovery(refresh, section);
  }
  function denied() {
    state.draft = null; state.pending = null; state.selectedId = null; privateState.dateReviews.delete(caseId); rows = []; review = null; cursor = null; list.replaceChildren(); detail.replaceChildren(); editor.replaceChildren(); recovery.replaceChildren(); count.textContent = ""; section.dataset.state = "error";
  }
  const currentEntry = () => review?.selectedEvent || rows.find(entry => entry.id === selectedId) || null;
  function showDetails() {
    detail.replaceChildren(); const entry = currentEntry(); if (!entry) { if (selectedId) detail.append(node("p", { text: "This calendar entry is no longer available to your account." })); return; }
    detail.append(node("h4", { text: entry.title }), node("p", { text: calendarLabel(entry) }));
    if (entry.end && !entry.isAllDay && entry.end !== entry.start) detail.append(node("p", { text: `Ends: ${calendarLabel({ ...entry, start: entry.end })}` }));
    if (entry.where) detail.append(node("p", { className: "av2-preserve-lines", text: `Location: ${entry.where}` }));
    if (entry.notes) detail.append(node("p", { className: "av2-preserve-lines", text: entry.notes }));
    if (entry.rrule) detail.append(node("p", { text: "A repeat rule is recorded for this entry. Repeated occurrences are not added to this calendar list." }), node("code", { text: entry.rrule }));
    if (entry.attendees.length) detail.append(node("h5", { text: "Recorded attendees" }), node("ul", {}, entry.attendees.map(value => node("li", { text: `${value.name || value.email || "Attendee"}${value.name && value.email ? ` · ${value.email}` : ""} · ${{ needsAction: "No response recorded", accepted: "Accepted", declined: "Declined", tentative: "Tentative" }[value.response] || "Response unavailable"}${value.required ? " · Required" : ""}` }))));
    if (entry.reminders.length) detail.append(node("h5", { text: "Recorded reminders" }), node("ul", {}, entry.reminders.map(value => node("li", { text: `${value.method === "none" ? "No delivery method" : value.method === "email" ? "Email" : value.method === "push" ? "Push" : "Method unavailable"} · ${value.minutesBefore === null ? "Timing not recorded" : `${value.minutesBefore} minutes before`}` }))), node("p", { className: "av2-muted", text: "Reminder delivery status is not available here." }));
    detail.append(node("div", { className: "av2-actions" }, [button("Edit calendar entry", () => openEditor("update", entry)), button("Remove calendar entry", () => openEditor("delete", entry)), button("Add attendee record", () => openEditor("attendee", entry)), button("Record reminder", () => openEditor("reminder", entry)), link("Link to this date", matterLink(caseId, "deadlines", new URLSearchParams({ eventId: entry.id })))]));
  }
  function render() {
    const focus = document.activeElement, focusedRow = focus?.closest?.("[data-event-id]")?.dataset.eventId, focusedDetail = detail.contains(focus) && focus?.tagName === "BUTTON" ? focus.textContent : null;
    list.replaceChildren(...rows.map(entry => node("li", { "data-event-id": entry.id }, [node("strong", { text: entry.title }), node("p", { text: `${dateTypes[entry.type] || "Calendar entry"} · ${calendarLabel(entry)}` }), button("Review date", () => { selectedId = entry.id; state.selectedId = entry.id; void load(); })])));
    count.textContent = !review.total ? "" : `${review.total} ${review.total === 1 ? "entry" : "entries"} in this date range${cursor ? ` · ${rows.length} shown` : ""}.`;
    if (!rows.length) list.append(node("li", { text: "No calendar entries are recorded in this date range." }));
    showDetails(); showRecovery(); controls();
    if (focusedRow || focusedDetail) requestAnimationFrame(() => {
      if (signal.aborted || document.activeElement !== document.body && document.activeElement !== focus) return;
      if (focusedRow) list.querySelector(`[data-event-id="${focusedRow}"] button`)?.focus({ preventScroll: true });
      else [...detail.querySelectorAll("button")].find(control => control.textContent === focusedDetail)?.focus({ preventScroll: true });
    });
  }
  function showRecovery() {
    recovery.replaceChildren(); if (!state.pending) return;
    recovery.append(node("h4", { text: "Check the calendar action" }), node("p", { text: state.busy ? "Saving the reviewed action…" : "The action is not yet confirmed. Check its saved status before making another change." }), node("div", { className: "av2-actions" }, [check, retry]));
  }
  function openEditor(action, entry = null) {
    if (state.busy || state.pending) return;
    state.draft = { action, entry, fields: action === "create" || action === "update" ? dateFields(entry) : action === "attendee" ? { name: "", email: "", role: "guest", response: "needsAction", required: true } : action === "reminder" ? { minutesBefore: "30", method: "email" } : {} };
    renderEditor(); controls(); editor.querySelector("input,button")?.focus();
  }
  function renderEditor() {
    editor.replaceChildren(); const draft = state.draft; if (!draft) return;
    const labels = { create: "Add calendar entry", update: "Edit calendar entry", delete: "Remove this calendar entry?", attendee: "Add attendee record", reminder: "Record reminder" };
    editor.append(node("h4", { text: labels[draft.action] }));
    const grid = node("div", { className: "av2-date-grid" }), fields = draft.fields, formControls = {};
    function field(key, label, type = "text", choices = null, max = null) {
      const fieldId = `av2-calendar-${caseId}-${key}`;
      const control = choices ? node("select", { id: fieldId }, Object.entries(choices).map(([value, text]) => node("option", { value, text }))) : node(type === "textarea" ? "textarea" : "input", { id: fieldId, ...(type === "textarea" ? { rows: "4" } : { type }), ...(max ? { maxlength: String(max) } : {}) });
      if (type === "checkbox") control.checked = fields[key]; else control.value = fields[key] ?? "";
      control.addEventListener(type === "checkbox" || choices ? "change" : "input", () => { fields[key] = type === "checkbox" ? control.checked : control.value; if (["isAllDay", "timezone", "startDate", "startTime", "endDate", "endTime"].includes(key)) updateTimes(); });
      grid.append(node("label", { for: fieldId, text: label }), control); formControls[key] = control; return control;
    }
    const occurrences = {};
    function updateTimes() {
      if (!formControls.startTime) return;
      for (const prefix of ["start", "end"]) {
        const time = formControls[`${prefix}Time`]; time.hidden = fields.isAllDay; grid.querySelector(`label[for="${time.id}"]`).hidden = fields.isAllDay;
        const container = occurrences[prefix]; if (!container) continue; container.replaceChildren();
        const values = fields.isAllDay ? [] : wallInstants(fields[`${prefix}Date`], fields[`${prefix}Time`], fields.timezone);
        if (values.length > 1) {
          const fieldId = `av2-calendar-${caseId}-${prefix}-occurrence`, select = node("select", { id: fieldId }, [node("option", { value: "", text: "Choose an occurrence" }), ...values.map((value, index) => node("option", { value, text: `${index === 0 ? "First" : "Second"} · ${occurrenceLabel(value, fields.timezone)}` }))]);
          select.value = values.includes(fields[`${prefix}Occurrence`]) ? fields[`${prefix}Occurrence`] : "";
          select.addEventListener("change", () => { fields[`${prefix}Occurrence`] = select.value; }); container.append(node("label", { for: fieldId, text: `Which ${prefix} time?` }), select);
        }
      }
    }
    if (["create", "update"].includes(draft.action)) {
      field("title", "Entry title", "text", null, 500); field("type", "Type of date", "text", dateTypes); field("isAllDay", "All-day entry", "checkbox"); field("timezone", "Time zone", "text", null, 100);
      for (const prefix of ["start", "end"]) { field(`${prefix}Date`, `${prefix === "start" ? "Start" : "End"} date${prefix === "end" ? " (optional)" : ""}`, "date"); field(`${prefix}Time`, `${prefix === "start" ? "Start" : "End"} time`, "time"); occurrences[prefix] = node("div", { className: "av2-date-occurrence" }); grid.append(occurrences[prefix]); }
      field("where", "Location or meeting link", "text", null, 2000); field("notes", "Calendar notes", "textarea", null, 20000); updateTimes();
    } else if (draft.action === "attendee") {
      editor.append(node("p", { text: "Record an attendee and their response. No invitation is sent." })); field("name", "Attendee name", "text", null, 300); field("email", "Attendee email (optional)", "email", null, 320); field("role", "Role", "text", { guest: "Guest", attorney: "Attorney", paralegal: "Paralegal", admin: "LPC administrator" }); field("response", "Recorded response", "text", { needsAction: "No response recorded", accepted: "Accepted", declined: "Declined", tentative: "Tentative" }); field("required", "Attendance required", "checkbox");
    } else if (draft.action === "reminder") {
      editor.append(node("p", { text: "Record the reminder settings for this entry. Delivery is not confirmed by this action." })); field("minutesBefore", "Minutes before the entry", "number"); formControls.minutesBefore.min = "0"; formControls.minutesBefore.max = "20160"; formControls.minutesBefore.step = "1"; field("method", "Recorded delivery method", "text", { email: "Email", push: "Push", none: "None" });
    } else editor.append(node("p", { text: draft.entry.title }), node("p", { text: "This removes the entry from your calendar. The Matter’s deadline and its other records remain." }));
    editor.append(grid, node("div", { className: "av2-actions" }, [button(draft.action === "delete" ? "Confirm removal" : "Save calendar entry", () => void beginSave(), "av2-button"), button(draft.action === "delete" ? "Keep calendar entry" : "Discard calendar changes", () => { state.draft = null; editor.replaceChildren(); controls(); })]));
  }
  async function beginSave() {
    if (!state.draft || !review || state.pending || state.busy || reading || signal.aborted) return;
    const draft = state.draft;
    try {
      const values = ["create", "update"].includes(draft.action) ? dateChanges(draft.fields, draft.entry) : draft.action === "reminder" ? { method: draft.fields.method, minutesBefore: Number(draft.fields.minutesBefore) } : draft.action === "attendee" ? Object.fromEntries(Object.entries(draft.fields).filter(([key, value]) => key !== "email" || value)) : {};
      if (draft.action === "update" && !Object.keys(values).length) { feedback.textContent = "No calendar changes to save."; return; }
      state.pending = { requestId: crypto.randomUUID(), action: draft.action, values, reviewedMatterRevision: review.revision, ...(draft.entry ? { eventId: draft.entry.id, reviewedRevision: draft.entry.revision } : {}) }; state.retryReviewed = false;
      await perform();
    } catch (error) { if (!signal.aborted) feedback.textContent = error.message; }
  }
  async function confirmed(value) {
    const operation = readDateOperation(value, caseId);
    if (operation.status !== "recorded" || operation.action !== state.pending?.action || state.pending.eventId && state.pending.eventId !== operation.eventId) throw new Error("unconfirmed_calendar_action");
    const action = operation.action; selectedId = operation.event?.id || null; state.selectedId = selectedId; state.pending = null; state.draft = null; state.retryReviewed = false; editor.replaceChildren(); recovery.replaceChildren(); await load();
    if (section.dataset.state === "ready") feedback.textContent = operation.changedSinceSave ? "The action was recorded. This entry has changed or been removed since then; its current record is shown." : action === "delete" ? "Calendar entry removed." : action === "attendee" ? "Attendee recorded." : action === "reminder" ? "Reminder settings recorded." : "Calendar entry saved.";
  }
  async function perform() {
    if (!state.pending || state.busy || signal.aborted) return;
    const controller = new AbortController(); transfer = controller; const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true }); const timer = setTimeout(abort, 120000);
    state.busy = true; state.retryReviewed = false; showRecovery(); controls(); feedback.textContent = "Saving calendar entry…";
    try { const result = await api.saveWorkspaceDate(caseId, state.pending, { ...options, signal: controller.signal }); if (!signal.aborted && !controller.signal.aborted) await confirmed(result.operation); }
    catch (error) {
      if (signal.aborted) return;
      if ([401, 403].includes(error.status) || error.kind === "authentication") { denied(); feedback.textContent = "Calendar access changed. Refresh the Matter before continuing."; }
      else if ([400, 422].includes(error.status)) { state.pending = null; recovery.replaceChildren(); feedback.textContent = "The calendar entry was not saved. Check the dates, time zone and other fields before trying again."; }
      else feedback.textContent = error.status === 409 ? "The entry or Matter changed. Check the saved action and review the current entry before trying again." : "The calendar action could not be confirmed. Check its saved status before trying again.";
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); transfer = null; state.busy = false; if (!signal.aborted) { showRecovery(); controls(); } }
  }
  async function checkPending() {
    if (!state.pending || state.busy || reading || signal.aborted) return;
    reading = true; controls();
    try {
      const next = readDates(await api.readWorkspaceDates(caseId, { ...options, requestId: state.pending.requestId, ...(state.pending.eventId ? { eventId: state.pending.eventId } : {}) }), caseId, ownerId);
      if (signal.aborted) return;
      if (next.operation.status === "recorded") { reading = false; await confirmed(next.operation); return; }
      review = next; state.retryReviewed = false; showRecovery();
      const current = next.selectedEvent;
      recovery.append(node("p", { text: "No completed action is recorded for this request." }));
      if (state.pending.action !== "create" && !current) { recovery.append(node("p", { text: "The selected entry is no longer available. Its removal cannot be attributed to this request." }), button("Close these unsaved calendar changes", () => { state.pending = null; state.draft = null; editor.replaceChildren(); recovery.replaceChildren(); void load(); })); return; }
      if (current) recovery.append(node("p", { className: "av2-preserve-lines", text: `Current entry: ${current.title}\n${calendarLabel(current)}\n${current.notes}` }));
      recovery.append(button("Use the current record for this action", () => { state.pending.reviewedMatterRevision = next.revision; if (current) state.pending.reviewedRevision = current.revision; state.retryReviewed = true; feedback.textContent = "Current record reviewed. Retry the same action when ready."; controls(); }));
    } catch (error) { if (!signal.aborted) { if ([401, 403].includes(error.status)) denied(); feedback.textContent = "The saved action couldn’t be checked. No retry has been sent."; } }
    finally { reading = false; if (!signal.aborted) controls(); }
  }
  async function load({ more: append = false, quiet = false } = {}) {
    if (reading || signal.aborted) return;
    reading = true; const retained = rows; controls(); if (!quiet) { section.dataset.state = "loading"; feedback.textContent = "Loading your calendar…"; }
    try {
      const query = { ...options, ...(selectedId ? { eventId: selectedId } : {}), ...(state.from ? { from: `${state.from}T00:00:00.000Z` } : {}), ...(state.to ? { to: `${state.to}T23:59:59.999Z` } : {}) };
      let page = readDates(await api.readWorkspaceDates(caseId, { ...query, ...(append ? { cursor } : {}) }), caseId, ownerId); if (signal.aborted) return;
      const added = [...page.items], seen = new Set();
      while (quiet && added.length < retained.length && page.nextCursor) { if (seen.has(page.nextCursor)) throw new Error("repeated_calendar_page"); seen.add(page.nextCursor); page = readDates(await api.readWorkspaceDates(caseId, { ...query, cursor: page.nextCursor }), caseId, ownerId); if (signal.aborted) return; added.push(...page.items); }
      rows = append ? [...retained, ...added] : added; if (new Set(rows.map(entry => entry.id)).size !== rows.length) throw new Error("repeated_calendar_entry"); review = page; cursor = page.nextCursor; section.dataset.state = "ready"; if (!quiet) feedback.textContent = ""; render();
    } catch (error) { if (!signal.aborted) { if ([401, 403, 404].includes(error.status)) denied(); else { rows = []; cursor = null; review = null; list.replaceChildren(); detail.replaceChildren(); count.textContent = ""; section.dataset.state = "error"; } feedback.textContent = "Your calendar couldn’t load. Refresh it to try again."; } }
    finally { reading = false; if (!signal.aborted) controls(); }
  }
  signal.addEventListener("abort", () => { transfer?.abort(); state.busy = false; section.replaceChildren(); }, { once: true });
  section.sync = () => state.draft || state.pending || state.busy ? Promise.resolve() : load({ quiet: true });
  renderEditor(); showRecovery(); section.readiness = load(); return section;
}
