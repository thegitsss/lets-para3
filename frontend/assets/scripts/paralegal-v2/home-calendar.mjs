import { createCalendarEvents } from '../connected-workspace/calendar-events.mjs';
import { createCalendarNotes } from './calendar-notes.mjs';
import { weekKey } from '../attorney-v2/private-state.mjs';
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
  const period = node('h2', { className: 'pv2-calendar-period', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const dateNavigation = node('div', { className: 'pv2-calendar-title' });
  const controls = node('div', { className: 'pv2-calendar-controls', 'aria-label': 'Calendar navigation' });
  const content = node('div', { className: 'pv2-calendar-content' });
  section.append(node('header', { className: 'pv2-calendar-header' }, [dateNavigation, controls]), content);
  page.append(section);
  const notesHost = node('div', { className: 'pv2-calendar-notes-host' });
  section.append(notesHost);
  const updateNoteIndicators = () => {
    section.querySelectorAll('[data-calendar-date]').forEach(cell => {
      const day = cell.dataset.calendarDate, key = weekKey(day);
      const index = Math.round((asDate(day) - asDate(key)) / DAY);
      const hasNote = Boolean(actions.calendarWeeks?.get(key)?.notes?.[index]?.trim());
      cell.classList.toggle('has-personal-note', hasNote);
      const control = cell.querySelector('.pv2-calendar-date-button');
      if (control) { control.setAttribute('aria-label', control.dataset.calendarLabel + (hasNote ? ', has notes' : '')); }
    });
  };
  const notes = createCalendarNotes({ api: actions.calendarApi, ownerId: actions.userId, weeks: actions.calendarWeeks,
    ownsSession: actions.calendarOwnsSession, signal: actions.aiSignal, host: notesHost, onChange: updateNoteIndicators, onAccessLost: actions.onSessionLost,
    role: actions.calendarRole || 'paralegal',
    onClose: ({ restoreFocus = true } = {}) => { state.calendarNotesDay = ''; if (restoreFocus) section.querySelector(`[data-calendar-date="${state.calendarSelected}"] button`)?.focus(); },
  });
  let personal = [], personalState = 'loading', personalRange = '';
  const personalCalendar = createCalendarEvents({ ownerId: actions.userId, role: actions.calendarRole || 'paralegal', signal: actions.aiSignal, onAccessLost: actions.onSessionLost, onChange: () => { personalRange = ''; paint(); } });
  section.__calendarDispose = () => { notes.dispose(); personalCalendar.dispose(); };
  section.refreshAfterSessionCheck = options => notes.refreshAfterSessionCheck(options);
  const selectDate = day => {
    state.calendarSelected = day; state.calendarNotesDay = day;
    if (state.calendarView === 'month' && day.slice(0, 7) !== state.calendarAnchor.slice(0, 7)) state.calendarAnchor = day;
    paint(); notes.open(day);
  };

  // activeWork is derived from the authenticated dashboard and excludes applications,
  // invitations, archived Matters, and records assigned to another paralegal.
  let deadlines = model.activeWork.filter(matter => matter.deadline).map(matter => ({
    ...matter,
    href: actions.calendarMatterHref ? actions.calendarMatterHref(matter) : matter.workspaceReady ? `/matter/${encodeURIComponent(matter.id)}?tab=deadlines` : '/work?section=active',
  }));
  const byDate = new Map();
  deadlines.forEach(matter => byDate.set(matter.deadline, [...(byDate.get(matter.deadline) || []), matter]));

  const personalForDay = day => personal.filter(event => {
    const start = event.isAllDay ? event.start.slice(0,10) : new Intl.DateTimeFormat('en-CA', {year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(event.start));
    const endDate = new Date(new Date(event.end).getTime() - 1);
    const end = event.isAllDay ? endDate.toISOString().slice(0,10) : new Intl.DateTimeFormat('en-CA', {year:'numeric',month:'2-digit',day:'2-digit'}).format(endDate);
    return day >= start && day <= (end < start ? start : end);
  });
  const dayEvents = day => [...(byDate.get(day) || []).map(matter => link(matter.title, matter.href, 'pv2-calendar-event')), ...personalForDay(day).map(event => personalCalendar.control(event))];
  function paint() {
    if (!actions.isValid()) return;
    const focusedDate = section.contains(document.activeElement) ? document.activeElement.closest('[data-calendar-date]')?.dataset.calendarDate : null;
    const monthly = state.calendarView === 'month';
    const start = monthly ? monthStart(state.calendarAnchor) : weekStart(state.calendarAnchor);
    const end = monthly ? dateKey(new Date(Date.UTC(asDate(start).getUTCFullYear(), asDate(start).getUTCMonth() + 1, 0, 12))) : shiftDays(start, 6);
    period.textContent = monthly ? label(start, { month: 'long', year: 'numeric' }) : `${label(start, { month: 'short', day: 'numeric' })}–${label(end, { month: 'short', day: 'numeric' })}`;
    const move = direction => {
      const focusSelector = direction < 0 ? '.pv2-calendar-prev' : '.pv2-calendar-next';
      const restoreFocus = document.activeElement === dateNavigation.querySelector(focusSelector);
      notes.close(); state.calendarNotesDay = "";
      state.calendarAnchor = monthly ? shiftMonths(state.calendarAnchor, direction) : shiftDays(state.calendarAnchor, 7 * direction);
      if (monthly && state.calendarSelected.slice(0, 7) !== state.calendarAnchor.slice(0, 7)) state.calendarSelected = state.calendarAnchor;
      paint();
      if (restoreFocus) dateNavigation.querySelector(focusSelector)?.focus({ preventScroll: true });
    };
    dateNavigation.replaceChildren(
      button('←', () => move(-1), 'pv2-calendar-control pv2-calendar-prev', { 'aria-label': `Previous ${monthly ? 'month' : 'week'}` }),
      period,
      button('→', () => move(1), 'pv2-calendar-control pv2-calendar-next', { 'aria-label': `Next ${monthly ? 'month' : 'week'}` }),
    );
    controls.replaceChildren(
      button('', () => {
        notes.close(); state.calendarNotesDay = '';
        state.calendarView = monthly ? 'week' : 'month';
        if (monthly) state.calendarAnchor = weekStart(monthStart(state.calendarAnchor));
        paint();
      }, `pv2-calendar-control pv2-calendar-toggle${monthly ? ' is-active' : ''}`, { 'aria-label': monthly ? 'Week view' : 'Full month view', 'aria-pressed': String(monthly) }),
    );
    controls.lastElementChild.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
    content.replaceChildren();
    if (!model.sources.dashboard.complete) {
      content.append(node('p', { className: 'pv2-overview-empty', role: 'status', text: model.sources.dashboard.state === 'loading' ? 'Loading Matter deadlines…' : 'Matter deadlines could not be loaded.' }));
    }
    const first = monthly ? weekStart(start) : start;
    const last = monthly ? shiftDays(end, 6 - ((asDate(end).getUTCDay() + 6) % 7)) : end;
    const range = `${first}:${last}`;
    if (personalRange !== range) {
      personalRange = range; personalState = 'loading'; personal = [];
      void personalCalendar.load(first, last).then(items => {
        if (items && personalRange === range && actions.isValid()) { personal = items; personalState = 'ready'; }
      }).catch(() => { if (personalRange === range && actions.isValid()) personalState = 'error'; }).finally(() => {
        if (personalRange === range && actions.isValid()) { paint(); }
      });
    }
    const dates = [];
    for (let day = first; day <= last; day = shiftDays(day, 1)) dates.push(day);
    section.classList.toggle('is-empty-period', !dates.some(day => byDate.has(day) || personalForDay(day).length));
    const grid = node('div', { className: `pv2-calendar-grid ${monthly ? 'is-month' : 'is-week'}` });
    if (monthly) {
      const weekdays = node('div', { className: 'pv2-calendar-weekdays', 'aria-hidden': 'true' });
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(day => weekdays.append(node('span', { text: day })));
      content.append(weekdays);
    }
    dates.forEach(day => {
      const events = [...(byDate.get(day) || []), ...personalForDay(day)];
      const cell = node('div', { className: `pv2-calendar-day${day === model.today ? ' is-today' : ''}${monthly && day.slice(0, 7) !== start.slice(0, 7) ? ' is-outside' : ''}`, 'data-calendar-date': day });
      const dayLabel = label(day, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const deadlineLabel = personalForDay(day).length ? `${dayLabel}, ${events.length} calendar entr${events.length === 1 ? 'y' : 'ies'}` : model.sources.dashboard.complete ? `${dayLabel}, ${events.length} Matter deadline${events.length === 1 ? '' : 's'}` : dayLabel;
      const dayHeader = node('div', { className: 'pv2-calendar-day-header' });
      if (monthly) {
        const select = button('', () => selectDate(day), 'pv2-calendar-date-button', { 'aria-label': deadlineLabel, 'aria-pressed': String(state.calendarSelected === day), 'data-calendar-label': deadlineLabel });
        dayHeader.append(
          node('span', { className: 'pv2-calendar-day-name', text: label(day, { weekday: 'short' }) }),
          node('span', { className: 'pv2-calendar-date pv2-calendar-date-number', text: label(day, { day: 'numeric' }) }),
          node('span', { className: 'pv2-calendar-date pv2-calendar-date-month', text: label(day, { month: 'short', day: 'numeric' }) }),
        );
        select.append(dayHeader, node('span', { className: 'pv2-calendar-preview', text: events.map(item => item.title).join(' · ') }));
        cell.append(select);
      } else {
        dayHeader.append(node('span', { className: 'pv2-calendar-day-name', text: label(day, { weekday: 'short' }) }), node('time', { className: 'pv2-calendar-date', datetime: day, text: label(day, { day: 'numeric' }) }));
        const select = button('', () => selectDate(day), 'pv2-calendar-date-button', {
          'aria-label': dayLabel, 'aria-pressed': String(state.calendarSelected === day), 'data-calendar-label': dayLabel,
        });
        select.append(dayHeader); cell.append(select);
        cell.append(node('div', { className: 'pv2-calendar-events' }, dayEvents(day)));
      }
      grid.append(cell);
    });
    content.append(grid);
    if (personalState !== 'ready') content.append(node('p', { className: 'pv2-overview-empty', role: 'status', text: personalState === 'loading' ? 'Loading personal events…' : 'Personal events could not be loaded.' }));
    if (personalState === 'error') content.append(button('Retry personal events', () => { personalRange = ''; paint(); }, 'pv2-calendar-control'));
    updateNoteIndicators();
    notes.preload(dates);
    if (focusedDate) section.querySelector(`[data-calendar-date="${focusedDate}"] .pv2-calendar-date-button`)?.focus({ preventScroll: true });
    if (monthly) {
      const selected = state.calendarSelected;
      const agenda = node('div', { className: 'pv2-calendar-agenda', 'aria-label': `Matter deadlines for ${label(selected, { month: 'long', day: 'numeric', year: 'numeric' })}` }, [
        node('h3', { text: label(selected, { weekday: 'long', month: 'long', day: 'numeric' }) }),
        ...(byDate.has(selected) || personalForDay(selected).length ? dayEvents(selected) : model.sources.dashboard.complete ? [node('p', { className: 'pv2-overview-empty', text: 'No Matter deadlines on this date.' })] : []),
      ]);
      content.append(agenda);
    } else if (model.sources.dashboard.complete && !dates.some(day => byDate.has(day) || personalForDay(day).length)) {
      content.append(node('p', { className: 'pv2-overview-empty pv2-calendar-empty', text: model.activeWork.length ? 'No Matter deadlines this week.' : 'No upcoming Matter deadlines.' }));
    }
  }
  section.updateModel = next => {
    model = next; personalRange = '';
    deadlines = model.activeWork.filter(matter => matter.deadline).map(matter => ({...matter,href:actions.calendarMatterHref ? actions.calendarMatterHref(matter) : matter.workspaceReady ? `/matter/${encodeURIComponent(matter.id)}?tab=deadlines` : '/work?section=active'}));
    byDate.clear(); deadlines.forEach(matter => byDate.set(matter.deadline,[...(byDate.get(matter.deadline)||[]),matter]));
    paint();
  };
  paint();
  if (state.calendarNotesDay) notes.open(state.calendarNotesDay);
  return section;
}
