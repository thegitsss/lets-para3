import { node, link, recoveryButton, setRecovery } from "./dom.mjs";
import { calendarDate, dateKey, weekKey, moveWeek, readWeek } from "./private-state.mjs";

export function createMonthlyNotes(route, { api, signal, privateState }) {
  const requested = route.query.get("month");
  const start = calendarDate(`${requested}-01`) || calendarDate(`${(weekKey(route.query.get("week")) || weekKey()).slice(0, 7)}-01`);
  const end = new Date(start); end.setMonth(end.getMonth() + 1); end.setDate(0);
  const first = weekKey(dateKey(start)); const last = weekKey(dateKey(end));
  const keys = [];
  for (let key = first; key <= last; key = moveWeek(key, 1)) keys.push(key);
  const queryFor = (month) => { const query = new URLSearchParams(route.query); query.set("calendar", "month"); query.set("month", month); query.delete("day"); return `#/tasks?${query}`; };
  const adjacent = (offset) => { const date = new Date(start); date.setMonth(date.getMonth() + offset); return dateKey(date).slice(0, 7); };
  const weekQuery = new URLSearchParams(route.query); weekQuery.delete("calendar"); weekQuery.delete("day"); weekQuery.set("week", first);
  const section = node("section", { className: "av2-card", "aria-label": "Monthly private notes", "data-av2-region": "monthly-notes" });
  const status = node("p", { role: "status", className: "av2-muted" });
  const content = node("div");
  const refresh = recoveryButton("Retry monthly notes", () => void load(), "av2-refresh");
  const jump = node("input", { type: "month", value: dateKey(start).slice(0, 7), "aria-label": "Choose a month for private notes" });
  const jumpForm = node("form", { className: "av2-actions" }, [jump, node("button", { type: "submit", text: "Go to month", className: "av2-secondary" })]);
  jumpForm.addEventListener("submit", (event) => { event.preventDefault(); if (calendarDate(`${jump.value}-01`)) location.hash = queryFor(jump.value); });
  section.append(node("div", { className: "av2-card-heading" }, [node("h2", { text: "Monthly private notes" }), refresh]), node("p", { className: "av2-week-range", text: start.toLocaleDateString(undefined, { month: "long", year: "numeric" }) }), node("nav", { className: "av2-actions", "aria-label": "Note months" }, [link("Previous month", queryFor(adjacent(-1))), link("This month", queryFor(dateKey(new Date()).slice(0, 7))), link("Next month", queryFor(adjacent(1))), link("Week view", `#/tasks?${weekQuery}`)]), jumpForm, node("p", { className: "av2-muted", text: "Choose a date to edit its note. A dot marks a saved note; a star marks a day in a week with unsaved edits. Drafts remain in this workspace until saved or your sign-in ends." }), status, content);
  let busy = false;
  async function load() {
    if (busy || signal.aborted) return;
    busy = true; refresh.disabled = true; section.dataset.state = "loading"; status.textContent = "Loading monthly notes…"; content.replaceChildren();
    try {
      const weeks = await Promise.all(keys.map(async (key) => readWeek(await api.get(`/api/users/me/weekly-notes?weekStart=${key}`, { signal }), key)));
      if (signal.aborted) return;
      const grid = node("div", { className: "av2-month-grid", "aria-label": "Private note dates" });
      for (let i = 0; i < 7; i += 1) { const day = calendarDate(first); day.setDate(day.getDate() + i); grid.append(node("span", { className: "av2-month-heading", "aria-hidden": "true", text: day.toLocaleDateString(undefined, { weekday: "short" }) })); }
      keys.forEach((key, weekIndex) => {
        const draft = privateState.weeks.get(key);
        const unsaved = Boolean(draft?.dirty || draft?.uncertain);
        const notes = unsaved ? draft.notes : weeks[weekIndex].notes;
        notes.forEach((note, index) => {
          const date = calendarDate(key); date.setDate(date.getDate() + index); const dayKey = dateKey(date);
          const query = new URLSearchParams(route.query); query.delete("calendar"); query.set("week", key); query.set("day", dayKey);
          const label = `${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${unsaved ? ", week has unsaved edits" : note ? ", saved note" : ", no note"}`;
          const cell = link("", `#/tasks?${query}`, "av2-month-day");
          cell.setAttribute("aria-label", label); cell.dataset.noteDate = dayKey;
          if (date.getMonth() !== start.getMonth()) cell.classList.add("av2-month-outside");
          if (dayKey === dateKey(new Date())) cell.setAttribute("aria-current", "date");
          cell.append(node("span", { text: String(date.getDate()) }), node("span", { className: "av2-month-marker", "aria-hidden": "true", text: unsaved ? "★" : note ? "●" : "" }), node("span", { className: "av2-month-excerpt", "aria-hidden": "true", text: note.slice(0, 140) }));
          grid.append(cell);
        });
      });
      content.replaceChildren(grid); section.dataset.state = "ready"; status.textContent = "Monthly notes loaded.";
    } catch (error) {
      if (signal.aborted) return;
      content.replaceChildren(); section.dataset.state = "error";
      if (error.kind === "authorization") privateState.weeks.clear();
      status.textContent = error.kind === "authorization" ? "Private notes are no longer available to this account." : "Monthly notes couldn’t be loaded. Refresh to try again; your drafts are still in this workspace.";
    } finally { if (!signal.aborted) { busy = false; refresh.disabled = false; }
      if (!signal.aborted) setRecovery(refresh, section);
    }
  }
  section.readiness = load();
  return section;
}
