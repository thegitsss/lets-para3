import { node, button } from '../attorney-v2/dom.mjs';
const BASE = '/api/integrations/calendars';
export function createCalendarConnections({ ownerId, api, signal }) {
  const root = node('section', { className: 'lpc-calendar-connections lpc-connection-group', 'aria-label': 'Calendar connections', 'data-calendar-connections': '' });
  const heading = node('h2', { text: 'Calendars' });
  const body = node('div');
  const feedback = node('p', { role: 'status', 'aria-live': 'polite' });
  const alive = () => !signal?.aborted;
  let busy = false;
  const retry = button('Retry calendar connections', () => void operate(load), 'lpc-connected-button is-secondary'); retry.hidden = true;
  const control = (label, action, primary = false) => button(label, action, primary ? 'lpc-connected-button' : 'lpc-connected-button is-secondary');
  async function operate(action) {
    if (busy || !alive()) return; const restoreFocus = document.activeElement === retry; busy = true; root.setAttribute('aria-busy', 'true'); feedback.textContent = ''; retry.hidden = true;
    root.querySelectorAll('button').forEach(item => { item.disabled = true; });
    try { await action(); }
    catch (error) { if (alive()) { feedback.textContent = action === load ? 'Calendar connection status could not be loaded. Try again.' : error.message || 'Calendar access could not be confirmed. Try again.'; retry.hidden = false; } }
    finally { busy = false; if (alive()) { root.setAttribute('aria-busy', 'false'); root.querySelectorAll('button').forEach(item => { item.disabled = item.dataset.unavailable === 'true'; }); if (restoreFocus) { const target = retry.hidden ? heading : retry; if (target === heading) heading.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); } } }
  }
  async function load() {
    feedback.textContent = 'Loading calendar connections…';
    const value = await api.read(`${BASE}/status`);
    if (!alive()) return;
    if (value.ownerId !== String(ownerId) || !Array.isArray(value.providers) || value.providers.length !== 2) throw new Error('Calendar connection status could not be verified.');
    body.replaceChildren();
    for (const connection of value.providers) {
      if (!['google','microsoft'].includes(connection.provider) || typeof connection.connected !== 'boolean' || typeof connection.configured !== 'boolean') throw new Error('Calendar connection status could not be verified.');
      const name = connection.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
      const state = !connection.configured ? 'Provider setup required' : connection.connected ? 'Connected' : connection.needsReconnect ? 'Reconnect required' : 'Not connected';
      const copy = node('div', { className: 'lpc-connection-copy' }, [node('h3', { text: name }), node('p', { text: 'Sync events and Matter deadlines in both directions.' }), node('span', { className: 'lpc-connection-state', text: state, 'data-connected': String(connection.connected) })]);
      const section = node('section', { className: 'lpc-calendar-provider lpc-connection-provider', 'data-provider': connection.provider, 'aria-label': name }, [node('div', { className: 'lpc-connection-identity' }, [node('img', { className: 'lpc-connection-logo', src: `/assets/brand/${connection.provider === 'google' ? 'google-calendar.png' : 'microsoft-outlook.svg'}`, alt: '', width: '40', height: '40' }), copy])]);
      const providerActions = node('div', { className: 'lpc-connected-actions lpc-connection-controls' });
      if (connection.connected) copy.append(node('p', { className: 'lpc-connection-sync', text: connection.lastSyncedAt ? 'Last synced ' + new Date(connection.lastSyncedAt).toLocaleString() : 'Waiting for first sync' }));
      if (!connection.connected) { const connect = control(`${connection.needsReconnect ? 'Reconnect' : 'Connect'} ${name}`, () => void operate(async () => {
        const result = await api.write(`${BASE}/${connection.provider}/connect`, { expectedOwnerId: String(ownerId) });
        const url = new URL(result.authorizationUrl);
        if (connection.provider === 'google' ? url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' : url.origin !== 'https://login.microsoftonline.com' || url.pathname !== '/common/oauth2/v2.0/authorize') throw new Error('The calendar authorization link is invalid.');
        if (alive()) window.location.assign(url.href);
      }), true); connect.dataset.unavailable = String(!connection.configured); connect.disabled = !connection.configured; providerActions.append(connect); }
      if (connection.connected) {
        providerActions.append(control(`Sync ${name}`, () => void operate(async () => {
          const result = await api.write(`${BASE}/${connection.provider}/sync`, { expectedOwnerId: String(ownerId), revision: connection.revision });
          if (result?.synced !== true) throw new Error('Calendar sync could not be confirmed.');
          await load(); feedback.textContent = result.conflicts ? 'Sync finished with conflicts. Review the affected events.' : `${name} synced.`;
        })));
      }
      if (connection.connected || connection.needsReconnect) { const options = node('details', { className: 'lpc-calendar-options' }, [node('summary', { text: 'Connection options', 'aria-label': `${name} connection options` })]); options.append(control(`Disconnect ${name}`, () => void operate(async () => {
        const result = await api.write(`${BASE}/${connection.provider}/connection`, { expectedOwnerId: String(ownerId) }, 'DELETE');
        if (result?.disconnected !== true) throw new Error('Disconnect could not be confirmed.');
        await load(); feedback.textContent = `${name} disconnected. Existing events are kept.`;
      }))); providerActions.append(options); }
      if (providerActions.childElementCount) section.append(providerActions);
      if (connection.error) section.append(node('p', { text: connection.error }));
      if (connection.connected && connection.error) {
        const conflicts = await api.read(`${BASE}/${connection.provider}/conflicts`);
        if (!alive()) return;
        if (!Array.isArray(conflicts.items)) throw new Error('Sync conflicts could not be read.');
        for (const item of conflicts.items) {
          const choices = node('div', { className: 'lpc-connected-actions' });
          const row = node('div', { className: 'lpc-calendar-conflict' }, [node('strong', { text: item.title }), choices]);
          for (const [prefer, label] of [['local','Keep LPC version'], ['remote',`Use ${name} version`]]) choices.append(control(label, () => void operate(async () => {
            const result = await api.write(`${BASE}/${connection.provider}/sync`, { expectedOwnerId: String(ownerId), revision: connection.revision, linkId: item.id, prefer });
            if (result?.synced !== true) throw new Error('Conflict resolution could not be confirmed.');
            await load(); feedback.textContent = result.conflicts ? 'Some events still require review.' : 'Calendar versions reconciled.';
          })));
          section.append(row);
        }
      }
      body.append(section);
    }
    feedback.textContent = '';
  }
  root.append(heading, node('p', { text: 'Personal events stay private.' }), body, node('details', { className: 'lpc-calendar-sync-details' }, [node('summary', { text: 'What syncs' }), node('p', { text: 'Events and Matter deadlines sync both ways with your primary calendar about every five minutes. Simultaneous edits require review.' }), node('p', { text: 'External deadline edits apply during sync within your Matter permissions. Imports cover the previous 90 days and next year, including individual recurring occurrences.' }), node('p', { text: 'Disconnecting stops future sync and keeps existing events in both calendars.' })]), feedback, retry);
  root.readiness = operate(load);
  return root;
}
