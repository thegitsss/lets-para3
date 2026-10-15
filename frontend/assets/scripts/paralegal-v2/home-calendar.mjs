// The Home calendar projects assigned, active Matter deadlines already verified by Home.
const DAY = 86_400_000;
const asDate = value => new Date(`${value}T12:00:00.000Z`);
const dateKey = value => value.toISOString().slice(0, 10);
const shiftDays = (value, amount) => dateKey(new Date(asDate(value).getTime() + amount * DAY));
const shiftMonths = (value, amount) => {
  const date = asDate(value);
  return dateKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1, 12)));
};
const weekStart = value => shiftDays(value, -((asDate(value).getUTCDay() + 6) % 7));
const monthStart = value => value.slice(0, 7) + '-01';
const label = (value, options) => asDate(value).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });

export function renderHomeCalendar({ page, model, actions, node, link, button }) {
  const state = actions.desktop;
  state.calendarView ||= 'week';
  state.calendarAnchor ||= model.today;
  state.calendarSelected ||= model.today;
  const section = node('section', { className: 'pv2-overview-section pv2-calendar', 'aria-label': 'Matter deadline calendar', 'data-home-calendar': '' });
  const title = node('h2', { text: 'Calendar' });
  const period = node('div', { className: 'pv2-calendar-period', role: 'status' });
  const controls = node('div', { className: 'pv2-calendar-controls', 'aria-label': 'Calendar navigation' });
  const content = node('div', { className: 'pv2-calendar-content' });
  section.append(node('header', { className: 'pv2-calendar-header' }, [node('div', { className: 'pv2-calendar-title' }, [title, period]), controls]), content);
  page.append(section);

  // activeWork is derived from the authenticated dashboard and excludes applications,
  // invitations, archived Matters, and records assigned to another paralegal.
  const deadlines = model.activeWork.filter(matter => matter.deadline).map(matter => ({
    ...matter,
    href: matter.workspaceReady ? `/matter/${encodeURIComponent(matter.id)}?tab=deadlines` : '/work?section=active',
  }));
  const byDate = new Map();
  deadlines.forEach(matter => byDate.set(matter.deadline, [...(byDate.get(matter.deadline) || []), matter]));

  const dayEvents = day => (byDate.get(day) || []).map(matter => link(matter.title, matter.href, 'pv2-calendar-event'));
  function paint() {
    if (!actions.isValid()) return;
    const monthly = state.calendarView === 'month';
    const start = monthly ? monthStart(state.calendarAnchor) : weekStart(state.calendarAnchor);
    const end = monthly ? dateKey(new Date(Date.UTC(asDate(start).getUTCFullYear(), asDate(start).getUTCMonth() + 1, 0, 12))) : shiftDays(start, 6);
    period.textContent = monthly ? label(start, { month: 'long', year: 'numeric' }) : `${label(start, { month: 'short', day: 'numeric' })}–${label(end, { month: 'short', day: 'numeric' })}`;
    const move = direction => {
      state.calendarAnchor = monthly ? shiftMonths(state.calendarAnchor, direction) : shiftDays(state.calendarAnchor, 7 * direction);
      if (monthly && state.calendarSelected.slice(0, 7) !== state.calendarAnchor.slice(0, 7)) state.calendarSelected = state.calendarAnchor;
      paint();
    };
    controls.replaceChildren(
      button('Prev', () => move(-1), 'pv2-calendar-control', { 'aria-label': `Previous ${monthly ? 'month' : 'week'}` }),
      button('Next', () => move(1), 'pv2-calendar-control', { 'aria-label': `Next ${monthly ? 'month' : 'week'}` }),
      button('', () => {
        state.calendarView = monthly ? 'week' : 'month';
        if (monthly) state.calendarAnchor = weekStart(monthStart(state.calendarAnchor));
        paint();
      }, `pv2-calendar-control pv2-calendar-toggle${monthly ? ' is-active' : ''}`, { 'aria-label': monthly ? 'Week view' : 'Full month view', 'aria-pressed': String(monthly) }),
    );
    controls.lastElementChild.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
    content.replaceChildren();
    if (!model.sources.dashboard.complete) {
      content.append(node('p', { className: 'pv2-overview-empty', role: 'status', text: model.sources.dashboard.state === 'loading' ? 'Loading Matter deadlines…' : 'Matter deadlines could not be loaded.' }));
      return;
    }
    const first = monthly ? weekStart(start) : start;
    const last = monthly ? shiftDays(end, 6 - ((asDate(end).getUTCDay() + 6) % 7)) : end;
    const dates = [];
    for (let day = first; day <= last; day = shiftDays(day, 1)) dates.push(day);
    section.classList.toggle('is-empty-period', !dates.some(day => byDate.has(day)));
    const grid = node('div', { className: `pv2-calendar-grid ${monthly ? 'is-month' : 'is-week'}` });
    if (monthly) {
      const weekdays = node('div', { className: 'pv2-calendar-weekdays', 'aria-hidden': 'true' });
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(day => weekdays.append(node('span', { text: day })));
      content.append(weekdays);
    }
    dates.forEach(day => {
      const events = byDate.get(day) || [];
      const cell = node('div', { className: `pv2-calendar-day${day === model.today ? ' is-today' : ''}${monthly && day.slice(0, 7) !== start.slice(0, 7) ? ' is-outside' : ''}`, 'data-calendar-date': day });
      const dayLabel = label(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const dayHeader = node('div', { className: 'pv2-calendar-day-header' });
      if (monthly) {
        const select = button('', () => {
          state.calendarSelected = day;
          if (day.slice(0, 7) !== start.slice(0, 7)) state.calendarAnchor = day;
          paint();
        }, 'pv2-calendar-date-button', { 'aria-label': `${dayLabel}, ${events.length} Matter deadline${events.length === 1 ? '' : 's'}`, 'aria-pressed': String(state.calendarSelected === day) });
        dayHeader.append(
          node('span', { className: 'pv2-calendar-day-name', text: label(day, { weekday: 'short' }) }),
          node('span', { className: 'pv2-calendar-date pv2-calendar-date-number', text: label(day, { day: 'numeric' }) }),
          node('span', { className: 'pv2-calendar-date pv2-calendar-date-month', text: label(day, { month: 'short', day: 'numeric' }) }),
        );
        select.append(dayHeader, node('span', { className: 'pv2-calendar-preview', text: events.map(item => item.title).join(' · ') }));
        cell.append(select);
      } else {
        dayHeader.append(node('span', { className: 'pv2-calendar-day-name', text: label(day, { weekday: 'short' }) }), node('time', { className: 'pv2-calendar-date', datetime: day, text: label(day, { day: 'numeric' }) }));
        cell.append(dayHeader);
        cell.append(node('div', { className: 'pv2-calendar-events' }, dayEvents(day)));
      }
      grid.append(cell);
    });
    content.append(grid);
    if (monthly) {
      const selected = state.calendarSelected;
      const agenda = node('div', { className: 'pv2-calendar-agenda', 'aria-label': `Matter deadlines for ${label(selected, { month: 'long', day: 'numeric', year: 'numeric' })}` }, [
        node('h3', { text: label(selected, { weekday: 'long', month: 'long', day: 'numeric' }) }),
        ...(byDate.has(selected) ? dayEvents(selected) : [node('p', { className: 'pv2-overview-empty', text: 'No Matter deadlines on this date.' })]),
      ]);
      content.append(agenda);
    } else if (!dates.some(day => byDate.has(day))) {
      content.append(node('p', { className: 'pv2-overview-empty pv2-calendar-empty', text: model.activeWork.length ? 'No Matter deadlines this week.' : 'Matter deadlines will appear here once you begin work.' }));
    }
  }
  paint();
}
