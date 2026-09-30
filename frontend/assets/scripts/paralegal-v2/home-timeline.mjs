// A read-only calendar projection of the already-authorized Home deadlines.
// A point represents one recorded date, never an inferred task duration.
const DAY = 86_400_000;
const dateKey = date => date.toISOString().slice(0, 10);
const dayValue = value => Date.parse(`${value}T00:00:00Z`);

export function deadlineTimelineRange(today, offset = 0, monthCount = 3) {
  const anchor = new Date(dayValue(today));
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1 + offset * 3, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + monthCount, 1));
  const days = (last - first) / DAY;
  const months = Array.from({ length: monthCount }, (_, index) => {
    const start = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index, 1));
    const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index + 1, 1));
    return { date: dateKey(start), label: start.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }), left: (start - first) / DAY / days * 100, width: (end - start) / DAY / days * 100 };
  });
  return { start: dateKey(first), end: dateKey(last), days, months };
}

export function enhanceHomeTimeline({ host, model, actions, node, link, button, shortDate }) {
  const section = host.querySelector(".ph-deadlines");
  if (!section) return;
  const state = actions.desktop;
  const listContent = [...section.querySelectorAll(".ph-date-list,.ph-more,.ph-empty")];
  const toggle = node("div", { className: "ph-timeline-toggle", role: "group", "aria-label": "Deadline display" });
  const timeline = node("div", { className: "ph-timeline", "data-home-timeline": "", hidden: true });
  const listButton = button("List", () => { if (actions.isValid()) { state.timeline = false; paint(); } }, "ph-desktop-tab", { "aria-pressed": "true" });
  const timelineButton = button("Timeline", () => { if (actions.isValid()) { state.timeline = true; paint(); } }, "ph-desktop-tab", { "aria-pressed": "false" });
  toggle.append(listButton, timelineButton);
  section.querySelector(".ph-section-heading").append(toggle);
  section.append(timeline);

  function period(change) {
    if (!actions.isValid()) return;
    state.timelinePeriod = change === 0 ? 0 : (state.timelinePeriod || 0) + change;
    paint();
    timeline.querySelector(`[data-timeline-period="${change}"]`)?.focus({ preventScroll: true });
  }
  function paint() {
    if (!actions.isValid()) return;
    const active = Boolean(state.timeline);
    listContent.forEach(el => { el.hidden = active; });
    timeline.hidden = !active;
    listButton.setAttribute("aria-pressed", String(!active));
    timelineButton.setAttribute("aria-pressed", String(active));
    if (!active) return;
    const range = deadlineTimelineRange(model.today, state.timelinePeriod || 0);
    const position = value => ((dayValue(value) - dayValue(range.start)) / DAY + .5) / range.days * 100;
    const dates = model.deadlines.filter(row => {
      const date = row.deadline || row.date;
      return date >= range.start && date < range.end;
    });
    const controls = node("div", { className: "ph-timeline-controls" }, [
      node("p", { role: "status", text: `${range.months[0].label} – ${range.months[2].label}` }),
      button("←", () => period(-1), "ph-desktop-icon", { "aria-label": "Previous three months", "data-timeline-period": "-1" }),
      button("Today", () => period(0), "ph-desktop-small-button", { "data-timeline-period": "0" }),
      button("→", () => period(1), "ph-desktop-icon", { "aria-label": "Next three months", "data-timeline-period": "1" }),
    ]);
    const table = node("table", { className: "ph-timeline-table" });
    const monthTrack = node("div", { className: "ph-timeline-track ph-timeline-months" }, range.months.map(month => node("span", { text: month.label, style: `left:${month.left}%;width:${month.width}%` })));
    table.append(node("thead", {}, [node("tr", {}, [node("th", { scope: "col", text: "Recorded deadline" }), node("th", { scope: "col", "aria-label": `Dates from ${range.months[0].label} through ${range.months[2].label}` }, [monthTrack])])]));
    const body = node("tbody");
    dates.forEach(row => {
      const date = row.deadline || row.date;
      const point = row.href ? link("●", row.href, "ph-timeline-point") : node("span", { className: "ph-timeline-point", text: "●" });
      point.setAttribute("aria-label", `${row.title}: ${row.label || "Matter deadline"}, ${shortDate(date)}`);
      point.setAttribute("title", shortDate(date));
      point.style.left = `${position(date)}%`;
      const track = node("div", { className: "ph-timeline-track" }, [point]);
      range.months.slice(1).forEach(month => track.append(node("span", { className: "ph-timeline-month-line", "aria-hidden": "true", style: `left:${month.left}%` })));
      if (model.today >= range.start && model.today < range.end) track.append(node("span", { className: "ph-timeline-today", "aria-hidden": "true", style: `left:${position(model.today)}%` }));
      body.append(node("tr", {}, [
        node("th", { scope: "row" }, [row.href ? link(row.title, row.href) : node("span", { text: row.title }), node("time", { datetime: date, text: shortDate(date) })]),
        node("td", {}, [track]),
      ]));
    });
    table.append(body);
    const scroll = node("div", { className: "ph-timeline-scroll", tabindex: "0", role: "region", "aria-label": "Deadline timeline; scroll horizontally to review dates" }, [table]);
    timeline.replaceChildren(controls, scroll, node("p", { className: "ph-timeline-note", text: dates.length ? "Points show recorded due dates. The vertical line marks today when it is in view." : "No recorded deadlines in this period in the available preview." }));
  }
  paint();
}
