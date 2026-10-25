import { createMonthlyNotes } from "./monthly-notes.mjs";
import { node, link, button, recoveryButton, setRecovery } from "./dom.mjs";
import { calendarDate, dateKey, weekKey, moveWeek, readWeek, sameNotes } from "./private-state.mjs";

export function createWeeklyNotes(route, { api, signal, privateState, ownerId }) {
  if (route.query.get("calendar") === "month") return createMonthlyNotes(route, { api, signal, privateState });
  const key = weekKey(route.query.get("week")) || weekKey();
  const date = calendarDate(key), end = calendarDate(key); end.setDate(end.getDate() + 6);
  const section = node("section", { className: "av2-card", "aria-label": "Personal notes", "data-av2-region": "weekly-notes" });
  const status = node("p", { role: "status", className: "av2-notice lpc-note-status", "data-routine": "true" });
  const content = node("div"), conflict = node("div", { className: "av2-notice", hidden: "" });
  let draft = privateState.weeks.get(key), latest = null, generation = 0, busy = false, interactionGeneration = 0, timer, inputs = [], composing = false, paused = false;
  const source = `/api/users/me/weekly-notes?weekStart=${key}`;
  const read = async () => readWeek(await api.get(source, { signal }), key);
  const refresh = recoveryButton("Check saved notes", () => void load(), "av2-refresh");
  const undo = button("Undo", () => restore("undo"), "av2-secondary"), redo = button("Redo", () => restore("redo"), "av2-secondary");
  const queryFor = week => { const query = new URLSearchParams(route.query); query.set("week", week); query.delete("calendar"); query.delete("day"); return `#/tasks?${query}`; };
  const monthQuery = new URLSearchParams(route.query); monthQuery.set("calendar", "month"); monthQuery.set("month", key.slice(0, 7));
  const nav = node("nav", { className: "av2-actions", "aria-label": "Note weeks" }, [link("Previous week", queryFor(moveWeek(key, -1))), link("This week", queryFor(weekKey())), link("Next week", queryFor(moveWeek(key, 1))), link("Month view", `#/tasks?${monthQuery}`)]);
  const jump = node("input", { type: "date", value: key, "aria-label": "Choose a date for personal notes" });
  const jumpForm = node("form", { className: "av2-actions" }, [jump, node("button", { type: "submit", className: "av2-secondary", text: "Go to week" })]);
  jumpForm.addEventListener("submit", event => { event.preventDefault(); const week = weekKey(jump.value); if (week) location.hash = queryFor(week); });
  section.append(node("div", { className: "av2-card-heading" }, [node("h2", { text: "Personal notes" }), refresh]), node("p", { className: "av2-week-range", text: `${date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}` }), nav, jumpForm, node("p", { className: "av2-muted", text: "Changes save automatically." }), status, content, conflict, node("div", { className: "av2-actions lpc-note-history" }, [undo, redo]));
  for (const type of ["focusin", "input", "pointerdown", "keydown", "compositionstart"]) section.addEventListener(type, () => { interactionGeneration += 1; }, { capture: true, signal });
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    // Navigation may detach this view before the debounce expires. The same
    // owner-checked revision writer finishes the pending edit in page memory.
    if (ownsDraft() && !busy && !composing && draft.dirty && !draft.saveTask && !latest && !paused && !draft.uncertain) void saveNotes();
  }, { once: true });
  function ownsDraft() { return Boolean(draft && privateState.weeks.get(key) === draft); }
  function say(text, routine = false) { if(signal.aborted)return; status.textContent = text; status.dataset.routine = String(routine); }
  function history() { if (draft) { draft.undo ||= []; draft.redo ||= []; } }
  function controls() {
    history();
    undo.disabled = !draft || !draft.undo.length || busy || draft.dirty || Boolean(latest) || draft.uncertain || paused;
    redo.disabled = !draft || !draft.redo.length || busy || draft.dirty || Boolean(latest) || draft.uncertain || paused;
    refresh.disabled = busy;
    if (!signal.aborted) setRecovery(refresh, section, { pending: paused || Boolean(draft?.uncertain), label: "Check saved notes" });
  }
  function schedule() {
    clearTimeout(timer); controls();
    if (draft?.dirty && !busy && !latest && !draft.uncertain && !paused && !composing && section.dataset.state === "ready") timer = setTimeout(() => void saveNotes(), 650);
  }
  function render() {
    if (!draft || signal.aborted) return;
    inputs = draft.notes.map((note, index) => {
      const day = calendarDate(key); day.setDate(day.getDate() + index);
      const control = node("textarea", { rows: "4", maxlength: "2000", "data-av2-note-day": dateKey(day) }); control.value = note;
      control.addEventListener("compositionstart", () => { composing = true; clearTimeout(timer); });
      control.addEventListener("compositionend", () => { composing = false; schedule(); });
      control.addEventListener("input", () => {
        draft.notes[index] = control.value; draft.dirty = !sameNotes(draft.notes, draft.baseline);
        if (!busy && !paused && !latest) say(draft.dirty ? "Changes waiting to save." : "Saved.", true);
        schedule();
      });
      return control;
    });
    content.replaceChildren(node("div", { className: "av2-weekly-grid", "data-av2-weekly-grid": "" }, inputs.map((control, index) => {
      const day = calendarDate(key); day.setDate(day.getDate() + index);
      return node("label", { className: "av2-note-day" }, [node("span", { text: day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) }), control]);
    })));
    controls();
  }
  function showConflict(server) {
    clearTimeout(timer); latest = server; paused = true; conflict.hidden = false;
    conflict.replaceChildren(node("h3", { text: "These notes changed elsewhere" }), node("p", { text: "Your edits are still above. Choose which version to keep." }));
    server.notes.forEach((note, index) => {
      const day = calendarDate(key); day.setDate(day.getDate() + index);
      conflict.append(node("details", { className: "av2-preview" }, [node("summary", { text: `Saved ${day.toLocaleDateString(undefined, { weekday: "long" })} note` }), node("p", { className: "av2-preserve-text", text: note || "No saved note." })]));
    });
    conflict.append(node("div", { className: "av2-actions" }, [
      button("Use saved notes", () => { draft.notes = [...server.notes]; draft.baseline = [...server.notes]; draft.revision = server.revision; draft.dirty = false; draft.uncertain = false; draft.undo = []; draft.redo = []; latest = null; paused = false; conflict.hidden = true; say("Saved notes loaded.", true); render(); inputs[0].focus(); }),
      button("Keep my edits", () => { draft.notes = draft.notes.map((note, index) => note === draft.baseline[index] ? server.notes[index] : note); draft.baseline = [...server.notes]; draft.revision = server.revision; draft.dirty = !sameNotes(draft.notes, server.notes); draft.uncertain = false; draft.undo = []; draft.redo = []; latest = null; paused = false; conflict.hidden = true; say("Saving your edits; other days keep their latest notes.", true); render(); inputs[0].focus(); schedule(); }),
    ])); controls();
  }
  function denyAccess() {
    clearTimeout(timer); content.replaceChildren(); conflict.replaceChildren(); conflict.hidden = true; latest = null; privateState.weeks.clear(); draft = null; paused = true;
    say("Personal notes are no longer available to this account."); controls();
  }
  async function load() {
    if (draft?.saveTask) await draft.saveTask;
    if (busy || signal.aborted) return;
    clearTimeout(timer); const ticket = ++generation; busy = true; controls();
    section.dataset.state = "loading"; say("Loading notes…", true);
    try {
      const server = await read(); if (signal.aborted || ticket !== generation) return;
      latest = null; paused = false; conflict.hidden = true; conflict.replaceChildren();
      if (!draft) { draft = { notes: [...server.notes], baseline: [...server.notes], revision: server.revision, dirty: false, uncertain: false }; privateState.weeks.set(key, draft); }
      else if (sameNotes(server.notes, draft.notes)) { draft.baseline = [...server.notes]; draft.revision = server.revision; draft.dirty = false; draft.uncertain = false; }
      else if (!draft.dirty && !draft.uncertain) { draft.notes = [...server.notes]; draft.baseline = [...server.notes]; draft.revision = server.revision; }
      else if (!sameNotes(server.notes, draft.baseline)) showConflict(server);
      else { draft.uncertain = false; draft.revision = server.revision; }
      section.dataset.state = "ready"; say(latest ? "Review the changed notes below." : draft.dirty ? "Saving recovered edits…" : "Saved.", !latest);
    } catch (error) {
      if (signal.aborted || ticket !== generation) return;
      paused = true; section.dataset.state = "error";
      if (error.kind === "authorization") denyAccess();
      else say("Notes couldn’t be checked. Your edits are kept in this tab. Check saved notes to continue.");
    } finally { if (!signal.aborted && ticket === generation) { busy = false; render(); controls(); schedule(); } }
  }
  function saveNotes() {
    if (draft?.saveTask) return draft.saveTask;
    const target=draft, task=persistNotes();
    if(target)target.saveTask=task;
    return task.finally(()=>{
      if(target?.saveTask===task)delete target.saveTask;
      if(signal.aborted && ownsDraft() && !busy && !composing && draft.dirty && !draft.uncertain && !latest && !paused) void saveNotes();
    });
  }
  async function persistNotes() {
    if (busy || !ownsDraft() || !draft?.dirty || draft.uncertain || latest || paused || composing) return;
    clearTimeout(timer); generation += 1; busy = true; controls();
    const attempted = [...draft.notes], baseline = [...draft.baseline], restoreKind = draft.restoreKind;
    const writer=new AbortController(), timeout=setTimeout(()=>writer.abort(),30000);
    const readForSave=async()=>readWeek(await api.get(source,{signal:writer.signal}),key);
    say("Saving…", true);
    try {
      const server = await readForSave(); if (!ownsDraft()) return;
      if (!sameNotes(server.notes, baseline)) { showConflict(server); say("Your notes weren’t overwritten. Review the changed notes below."); return; }
      draft.uncertain = true;
      const saved = readWeek(await api.saveWeeklyNotes({ weekStart: key, notes: attempted, revision: server.revision }, { signal:writer.signal, ownerId }), key);
      if (!ownsDraft()) return;
      history();
      if (!restoreKind && !sameNotes(baseline, saved.notes)) { draft.undo.push(baseline); draft.undo = draft.undo.slice(-20); draft.redo = []; }
      draft.restoreKind = null; draft.baseline = [...saved.notes]; draft.revision = saved.revision;
      // A pending request never replaces newer typing or disconnects the focused editor.
      draft.dirty = !sameNotes(draft.notes, saved.notes); draft.uncertain = false;
      say("Saved.", true);
    } catch (error) {
      if (!ownsDraft()) return;
      paused = true;
      if (error.status === 409) {
        try { const server = await readForSave(); if (ownsDraft()) { showConflict(server); say("Your notes weren’t overwritten. Review the changed notes below."); } }
        catch (readError) { if (ownsDraft()) { if (readError.kind === "authorization") denyAccess(); else say("The saved notes changed. Check saved notes to continue."); } }
      } else if (error.kind === "authorization") denyAccess();
      else say("Saving wasn’t confirmed. Your edits are still here. Check saved notes before retrying.");
    } finally { clearTimeout(timeout);busy = false; if (!signal.aborted) { controls(); schedule(); } }
  }
  function restore(kind) {
    const control = kind === "undo" ? undo : redo; if (control.disabled || !draft) return;
    const from = kind === "undo" ? draft.undo : draft.redo, to = kind === "undo" ? draft.redo : draft.undo;
    to.push([...draft.notes]); draft.notes = [...from.pop()]; draft.restoreKind = kind; draft.dirty = !sameNotes(draft.notes, draft.baseline);
    inputs.forEach((input, index) => { input.value = draft.notes[index]; }); schedule();
  }
  section.refreshAfterSessionCheck = async ({ ownerId: verifiedOwner, isCurrent = () => true } = {}) => {
    const startDraft = draft, interaction = interactionGeneration;
    const sameScope = ticket => !signal.aborted && ticket === generation && isCurrent() && verifiedOwner === ownerId && draft === startDraft && privateState.weeks.get(key) === startDraft;
    const canUpdate = () => !busy && draft && !draft.dirty && !draft.uncertain && !latest && !paused && section.dataset.state === "ready" && interaction === interactionGeneration && !section.contains(document.activeElement);
    if (verifiedOwner !== ownerId || signal.aborted || !isCurrent() || !canUpdate()) return;
    const ticket = ++generation;
    try {
      const server = await read(); if (!sameScope(ticket) || !canUpdate()) return;
      const changed = !sameNotes(server.notes, draft.notes);
      draft.notes = [...server.notes]; draft.baseline = [...server.notes]; draft.revision = server.revision;
      if (changed) { draft.undo = []; draft.redo = []; }
      inputs.forEach((input, index) => { input.value = server.notes[index]; }); controls();
    } catch (error) {
      if (!sameScope(ticket)) return;
      if (error.kind === "authorization") { denyAccess(); section.dataset.state = "error"; }
      else if (canUpdate()) { paused = true; say("Notes couldn’t be checked. Check saved notes to continue."); controls(); }
    }
  };
  section.readiness = load().then(() => { if (!signal.aborted && calendarDate(route.query.get("day"))) inputs.find(input => input.dataset.av2NoteDay === route.query.get("day"))?.focus(); });
  return section;
}
