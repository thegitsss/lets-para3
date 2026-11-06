import { node, button } from '../attorney-v2/dom.mjs';
import { createConnectedApi } from './native-api.mjs';
import { guardDialogDraft } from '../utils/dialog-discard-guard.mjs';
import { activateDialogFocus, deactivateDialogFocus } from '../utils/dialog-focus.js';
export function createCalendarEvents({ ownerId, role, signal, onAccessLost, onChange }) {
  const api = createConnectedApi({ ownerId, role, signal, onAccessLost });
  let generation = 0, disposed = false;
  const dialogs = new Set();
  const alive = () => !disposed && !signal?.aborted;
  function edit(event, launcher) {
    if (!alive()) return;
    const headingId = `calendar-event-${event.id}`;
    const title = node('input', { id: headingId + '-title', required: '', maxlength: '500', value: event.title });
    const allDay = node('input', { type: 'checkbox', id: headingId + '-all-day' }); allDay.checked = event.isAllDay;
    const start = node('input', { id: headingId + '-start', required: '' }), end = node('input', { id: headingId + '-end', required: '' });
    const localTime = value => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16); };
    const configureDates = () => { start.type = end.type = allDay.checked ? 'date' : 'datetime-local'; start.value = allDay.checked ? event.start.slice(0,10) : localTime(event.start); end.value = allDay.checked ? event.end.slice(0,10) : localTime(event.end); };
    configureDates(); allDay.addEventListener('change', configureDates);
    const field = (label, control) => node('label', { className: 'lpc-calendar-field', for: control.id }, [node('span', { text: label }), control]);
    const feedback = node('p', { role: 'status' }), close = button('Cancel', () => dialog.close(), 'lpc-dialog__button lpc-dialog__button--secondary');
    const providers = (event.syncProviders || []).map(provider => provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook');
    const context = node('p', { className: 'lpc-calendar-event-context', text: providers.length ? `Synced with ${providers.join(' and ')}. This personal event stays private.` : 'This personal event stays private.' });
    const titleField = field('Title', title); titleField.classList.add('lpc-calendar-title-field');
    const endField = field(allDay.checked ? 'Ends (exclusive for all-day events)' : 'Ends', end);
    allDay.addEventListener('change', () => { endField.firstElementChild.textContent = allDay.checked ? 'Ends (exclusive for all-day events)' : 'Ends'; });
    const dates = node('div', { className: 'lpc-calendar-dates' }, [field('Starts', start), endField]);
    const form = node('form', {}, [titleField, context, field('All day', allDay), dates, feedback]);
    const save = button('Save event', () => form.requestSubmit(), 'lpc-dialog__button lpc-dialog__button--primary');
    const dialog = node('dialog', { className: 'lpc-calendar-dialog', 'aria-labelledby': headingId }, [node('header', { className: 'lpc-calendar-dialog-header' }, [node('h2', { id: headingId, text: 'Calendar event' })]), node('div', { className: 'lpc-calendar-dialog-body' }, [form]), node('footer', { className: 'lpc-calendar-dialog-footer' }, [close, save])]);
    let pending = false, saved = false;
    const snapshot = () => JSON.stringify([title.value, allDay.checked, start.value, end.value]); const initial = snapshot();
    dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
    close.addEventListener('click', event => { if (pending) { event.preventDefault(); return; } });
    // Native dialog cancellation retains the draft until the user explicitly
    // confirms discarding it through the established discard guard.
    const dirty = () => !saved && snapshot() !== initial;
    const finish = () => { deactivateDialogFocus(dialog, { restoreFocus: true }); dialogs.delete(dialog); dialog.remove(); };
    dialog.addEventListener('close', finish, { once: true });
    form.addEventListener('submit', async submitted => {
      submitted.preventDefault(); if (pending || !alive()) return;
      let values;
      try { values = { title: title.value.trim(), isAllDay: allDay.checked, start: new Date(start.value + (allDay.checked ? 'T00:00:00Z' : '')).toISOString(), end: new Date(end.value + (allDay.checked ? 'T00:00:00Z' : '')).toISOString() }; if (values.end < values.start || !values.title) throw new Error(); }
      catch { feedback.textContent = 'Enter a title and valid event dates.'; return; }
      pending = true; [save, close, title, allDay, start, end].forEach(control => { control.disabled = true; }); feedback.textContent = 'Saving…';
      try {
        const result = await api.write(`/api/integrations/calendars/events/${event.id}`, { expectedOwnerId: String(ownerId), revision: event.revision, values }, 'PATCH');
        if (result.saved !== true) throw new Error('The event save could not be confirmed.');
        if (alive()) { saved = true; dialog.close(); onChange(); }
      } catch (error) { if (alive()) feedback.textContent = error.message || 'The event could not be saved. Your changes are kept.'; }
      finally { pending = false; if (alive()) [save, close, title, allDay, start, end].forEach(control => { control.disabled = false; }); }
    });
    document.body.append(dialog); dialogs.add(dialog); dialog.showModal();
    activateDialogFocus(dialog, { initialFocus: title, returnFocus: launcher });
    // Keep scope local: the canonical discard helper owns dirty close behavior.
    guardDialogDraft(dialog, { buttons: [close], hasDraft: dirty, isBusy: () => pending, focusOnKeep: title });
  }
  return {
    async load(from, to) {
      const ticket = ++generation;
      const result = await api.read(`/api/integrations/calendars/events?${new URLSearchParams({ from: from + 'T00:00:00.000Z', to: to + 'T23:59:59.999Z' })}`);
      if (!alive() || ticket !== generation) return null;
      if (result.ownerId !== String(ownerId) || !Array.isArray(result.items) || result.items.some(item => !/^[a-f0-9]{24}$/i.test(item.id) || !/^[a-f0-9]{64}$/.test(item.revision) || !Number.isFinite(new Date(item.start).getTime()) || !Number.isFinite(new Date(item.end).getTime()) || item.syncProviders !== undefined && (!Array.isArray(item.syncProviders) || item.syncProviders.some(provider => !['google','microsoft'].includes(provider))))) throw new Error('Personal calendar events could not be verified.');
      return result.items;
    },
    control(event) {
      const control = button('', clicked => edit(event, clicked.currentTarget), 'pv2-calendar-event');
      const providers = (event.syncProviders || []).map(provider => provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook');
      const time = event.isAllDay ? 'All day' : new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(event.start));
      const contextId = `calendar-context-${crypto.randomUUID()}`;
      control.append(node('span', { className: 'lpc-calendar-event-time', id: contextId, text: `${time} · Private` }), node('span', { className: 'lpc-calendar-event-title', text: event.title }));
      control.setAttribute('aria-label', event.title + (providers.length ? ` · Synced with ${providers.join(' and ')}` : ''));
      control.setAttribute('aria-describedby', contextId);
      return control;
    },
    dispose() { disposed = true; generation++; for (const dialog of dialogs) dialog.close(); dialogs.clear(); },
  };
}
