import { createMonthlyNotes } from "./monthly-notes.mjs";
import { node, link, button, recoveryButton, setRecovery } from "./dom.mjs";
import { calendarDate, dateKey, weekKey, moveWeek, readWeek, sameNotes } from "./private-state.mjs";

export function createWeeklyNotes(route, { api, signal, privateState, ownerId }) {
  if (route.query.get("calendar") === "month") return createMonthlyNotes(route, { api, signal, privateState });
  const key = weekKey(route.query.get("week")) || weekKey();
  const date = calendarDate(key);
  const end = calendarDate(key); end.setDate(end.getDate() + 6);
  const section = node("section", { className: "av2-card", "aria-label": "Weekly private notes", "data-av2-region": "weekly-notes" });
  const status = node("p", { role: "status", className: "av2-notice" });
  const content = node("div");
  const conflict = node("div", { className: "av2-notice" });
  conflict.hidden = true;
  const queryFor = (week) => { const query = new URLSearchParams(route.query); query.set("week", week); query.delete("calendar"); query.delete("day"); return `#/tasks?${query}`; };
  const monthQuery = new URLSearchParams(route.query); monthQuery.set("calendar", "month"); monthQuery.set("month", key.slice(0, 7));
  const refresh = recoveryButton("Retry weekly notes", () => void load(), "av2-refresh");
  const nav = node("nav", { className: "av2-actions", "aria-label": "Note weeks" }, [link("Previous week", queryFor(moveWeek(key, -1))), link("This week", queryFor(weekKey())), link("Next week", queryFor(moveWeek(key, 1))), link("Month view", `#/tasks?${monthQuery}`)]);
  const jump = node("input", { type: "date", value: key, "aria-label": "Choose a date for weekly notes" });
  const jumpForm = node("form", { className: "av2-actions" }, [jump, node("button", { type: "submit", className: "av2-secondary", text: "Go to week" })]);
  jumpForm.addEventListener("submit", (event) => { event.preventDefault(); const week = weekKey(jump.value); if (week) location.hash = queryFor(week); });
  const save = button("Save weekly notes", () => void saveNotes(), "av2-button");
  save.disabled = true;
  section.append(node("div", { className: "av2-card-heading" }, [node("h2", { text: "Weekly private notes" }), refresh]), node("p", { className: "av2-week-range", text: `${date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}` }), nav, jumpForm, node("p", { className: "av2-muted", text: "Save your notes before refreshing or closing this tab. Unsaved edits stay available as you move between weeks and pages in this workspace; they are cleared if your sign-in cannot be verified." }), status, content, conflict, save);
  let draft = privateState.weeks.get(key);
  let latest = null;
  let generation = 0;
  let busy = false;
  let inputs = [];
  const source = `/api/users/me/weekly-notes?weekStart=${key}`;
  const read = async () => readWeek(await api.get(source, { signal }), key);
  function render() {
    if (!draft || signal.aborted) return;
    inputs = draft.notes.map((note, index) => {
      const day = calendarDate(key); day.setDate(day.getDate() + index);
      const control = node("textarea", { rows: "4", maxlength: "2000", "data-av2-note-day": dateKey(day) });
      control.value = note;
      control.addEventListener("input", () => {
        draft.notes[index] = control.value;
        draft.dirty = !sameNotes(draft.notes, draft.baseline);
        save.disabled = !draft.dirty || Boolean(latest) || busy || draft.uncertain;
        status.textContent = draft.dirty ? "Unsaved notes." : "No unsaved changes.";
      });
      return control;
    });
    const grid = node("div", { className: "av2-weekly-grid", "data-av2-weekly-grid": "" }, inputs.map((control, index) => {
      const day = calendarDate(key); day.setDate(day.getDate() + index);
      return node("label", { className: "av2-note-day" }, [node("span", { text: day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) }), control]);
    }));
    content.replaceChildren(grid);
    save.disabled = !draft.dirty || Boolean(latest) || busy || draft.uncertain;
  }
  function showConflict(server) {
    latest = server;
    conflict.hidden = false;
    conflict.replaceChildren(node("h3", { text: "These notes changed elsewhere" }), node("p", { text: "Your edits are still above. Compare the saved notes below, then choose which version to use." }));
    server.notes.forEach((note, index) => {
      const day = calendarDate(key); day.setDate(day.getDate() + index);
      conflict.append(node("details", { className: "av2-preview" }, [node("summary", { text: `Saved ${day.toLocaleDateString(undefined, { weekday: "long" })} note` }), node("p", { className: "av2-preserve-text", text: note || "No saved note." })]));
    });
    conflict.append(node("div", { className: "av2-actions" }, [
      button("Use saved notes", () => { draft.notes = [...server.notes]; draft.baseline = [...server.notes]; draft.revision = server.revision; draft.dirty = false; draft.uncertain = false; latest = null; conflict.hidden = true; status.textContent = "Saved notes loaded; your unsaved edits were discarded."; render(); inputs[0].focus(); }),
      button("Keep my edits for review", () => { draft.notes = draft.notes.map((note, index) => note === draft.baseline[index] ? server.notes[index] : note); draft.baseline = [...server.notes]; draft.revision = server.revision; draft.dirty = !sameNotes(draft.notes, server.notes); draft.uncertain = false; latest = null; conflict.hidden = true; status.textContent = "Your edits are ready for review. Other days keep their latest saved notes. Save when you’re ready."; render(); inputs[0].focus(); }),
    ]));
    save.disabled = true;
  }
  function denyAccess() {
    content.replaceChildren(); conflict.replaceChildren(); conflict.hidden = true; latest = null; privateState.weeks.clear(); draft = null;
    status.textContent = "Weekly notes are no longer available to this account."; save.disabled = true;
  }
  async function load() {
    if (busy || signal.aborted) return;
    const ticket = ++generation; busy = true; save.disabled = true; refresh.disabled = true;
    section.dataset.state = "loading"; status.textContent = "Loading weekly notes…";
    try {
      const server = await read();
      if (signal.aborted || ticket !== generation) return;
      latest = null; conflict.hidden = true; conflict.replaceChildren();
      if (!draft) { draft = { notes: [...server.notes], baseline: [...server.notes], revision: server.revision, dirty: false, uncertain: false }; privateState.weeks.set(key, draft); }
      else if (sameNotes(server.notes, draft.notes)) { draft.baseline = [...server.notes]; draft.revision = server.revision; draft.dirty = false; draft.uncertain = false; }
      else if (!draft.dirty && !draft.uncertain) { draft.notes = [...server.notes]; draft.baseline = [...server.notes]; draft.revision = server.revision; }
      else if (!sameNotes(server.notes, draft.baseline)) showConflict(server);
      else { draft.uncertain = false; draft.revision = server.revision; }
      section.dataset.state = "ready";
      status.textContent = latest ? "The saved notes differ from your draft. Review both versions below." : draft.dirty ? "Your unsaved edits were recovered. Save when you’re ready." : "Saved notes are up to date.";
    } catch (error) {
      if (signal.aborted || ticket !== generation) return;
      section.dataset.state = "error";
      status.textContent = error.message === "week_boundary" ? "The server returned a different week. Notes are unavailable until the week-date mismatch is resolved." : error.kind === "authorization" ? "Weekly notes are no longer available to this account." : "Weekly notes couldn’t be loaded. Your unsaved edits are still available; refresh to try again.";
      if (error.kind === "authorization") denyAccess();
    } finally {
      if (!signal.aborted && ticket === generation) { busy = false; refresh.disabled = false; render(); if (section.dataset.state === "error") save.disabled = true; }

      if (!signal.aborted) setRecovery(refresh, section, { pending: Boolean(draft?.uncertain), label: "Check saved notes" });
    }
  }
  async function saveNotes() {
    if (busy || save.disabled || signal.aborted || !draft?.dirty) return;
    busy = true; save.disabled = true; refresh.disabled = true; inputs.forEach((input) => { input.disabled = true; });
    status.textContent = "Checking saved notes…";
    try {
      const server = await read();
      if (signal.aborted) return;
      if (!sameNotes(server.notes, draft.baseline)) { showConflict(server); status.textContent = "Your notes weren’t overwritten. Review the changed notes below."; return; }
      draft.uncertain = true;
      status.textContent = "Saving weekly notes…";
      const saved = readWeek(await api.saveWeeklyNotes({ weekStart: key, notes: [...draft.notes], revision: server.revision }, { signal, ownerId }), key);
      if (signal.aborted) return;
      draft.notes = [...saved.notes]; draft.baseline = [...saved.notes]; draft.revision = saved.revision; draft.dirty = false; draft.uncertain = false;
      status.textContent = "Weekly notes saved.";
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 409) {
        try { const server = await read(); if (signal.aborted) return; showConflict(server); status.textContent = "Your notes weren’t overwritten. Review the changed notes below."; }
        catch (readError) { if (!signal.aborted) { if (readError.kind === "authorization") denyAccess(); else status.textContent = "The saved notes changed. Your edits are still here; refresh to review the saved version."; } }
      } else if (error.kind === "authorization") {
        denyAccess();
      } else status.textContent = "Saving wasn’t confirmed. Your edited text is still here. Refresh weekly notes to check the saved version before trying again.";
    } finally {
      if (!signal.aborted) { busy = false; refresh.disabled = false; render(); if (!draft || draft.uncertain) save.disabled = true; }

      if (!signal.aborted) setRecovery(refresh, section, { pending: Boolean(draft?.uncertain), label: "Check saved notes" });
    }
  }
  section.readiness = load().then(() => {
    if (!signal.aborted && calendarDate(route.query.get("day"))) inputs.find((input) => input.dataset.av2NoteDay === route.query.get("day"))?.focus();
  });
  return section;
}
