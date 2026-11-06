import { createWeeklyNotes } from '../attorney-v2/weekly-notes.mjs';
import { weekKey, readWeek } from '../attorney-v2/private-state.mjs';

// Reuse the canonical private-note editor, including revision conflicts, undo,
// autosave and uncertain-write recovery. Only its selected-day presentation differs.
export function createCalendarNotes({ api, ownerId, weeks, ownsSession, signal, host, onChange, onClose, onAccessLost, role = 'paralegal' }) {
  let editor, controller, currentDay = '', active = true;
  const preloadController = new AbortController(), presentationController = new AbortController(), pending = new Map();
  const floating = typeof host.showPopover === 'function';
  if (floating) host.setAttribute('popover', 'auto');
  const position = () => {
    if (!floating || !editor?.isConnected || !host.matches(':popover-open')) return;
    const anchor = host.parentElement?.querySelector(`[data-calendar-date="${currentDay}"] .pv2-calendar-date-button`);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect(), gutter = 12;
    const viewport = window.visualViewport, viewportTop = viewport?.offsetTop || 0;
    const viewportHeight = viewport?.height || window.innerHeight;
    const width = Math.min(360, window.innerWidth - gutter * 2);
    host.style.maxHeight = `${Math.max(44, viewportHeight - gutter * 2)}px`;
    host.style.width = `${width}px`;
    const height = host.getBoundingClientRect().height;
    const below = rect.bottom + 8, above = rect.top - height - 8;
    const preferredTop = below + height <= viewportTop + viewportHeight - gutter ? below : above;
    const top = Math.max(viewportTop + gutter, Math.min(preferredTop, viewportTop + viewportHeight - height - gutter));
    host.style.left = `${Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter))}px`;
    host.style.top = `${top}px`;
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null;
  if (floating) {
    host.addEventListener('toggle', () => {
      if (!host.matches(':popover-open') && editor) { close(); onClose?.({ restoreFocus: false }); }
    }, { signal: presentationController.signal });
    window.addEventListener('resize', position, { signal: presentationController.signal });
    window.visualViewport?.addEventListener('resize', position, { signal: presentationController.signal });
    window.visualViewport?.addEventListener('scroll', position, { signal: presentationController.signal });
    document.addEventListener('scroll', position, { capture: true, signal: presentationController.signal });
  }

  const denied = () => {
    const current = ownsSession();
    weeks.clear(); editor?.replaceChildren(); if (current) onAccessLost?.();
    return Object.assign(new Error('Your signed-in account changed.'), { kind: 'authorization', status: 403 });
  };
  async function verifyOwner({ signal: requestSignal } = {}) {
    if (!ownsSession()) throw denied();
    let payload;
    try { payload = await api.get('/api/auth/me', { signal: requestSignal }); }
    catch (error) { if ([401, 403].includes(error.status)) throw denied(); throw error; }
    const user = payload?.user;
    if (!ownsSession() || String(user?.id || user?._id || '') !== ownerId || user.role !== role || user.status !== 'approved' || user.disabled || user.deleted) throw denied();
  }
  const protectedApi = {
    verifyOwner,
    async get(path, options = {}) {
      try { await verifyOwner(options); const result = await api.get(path, options); await verifyOwner(options); return result; }
      catch (error) { if ([401, 403].includes(error.status)) throw denied(); throw error; }
    },
    async saveWeeklyNotes(body, options = {}) {
      try {
        await verifyOwner(options);
        const result = await api.request('/api/users/me/weekly-notes', { method: 'PUT', body: JSON.stringify({ ...body, expectedOwnerId: ownerId }), signal: options.signal });
        await verifyOwner(options); return result;
      } catch (error) { if ([401, 403].includes(error.status)) throw denied(); throw error; }
    },
  };
  function close() {
    observer?.disconnect();
    controller?.abort(); controller = null; editor?.remove(); editor = null; currentDay = '';
    if (floating && host.matches(':popover-open')) host.hidePopover();
  }
  function open(day) {
    if (!ownsSession()) return;
    if (currentDay === day && editor?.isConnected) { editor.querySelector('textarea')?.focus(); return; }
    close(); currentDay = day; controller = new AbortController();
    const route = { query: new URLSearchParams({ week: weekKey(day), day }) };
    editor = createWeeklyNotes(route, { api: protectedApi, signal: controller.signal, ownerId, privateState: { weeks }, dayOnly: true, onChange, onClose: () => { close(); onClose?.(); } });
    editor.setAttribute('role', 'dialog');
    host.append(editor);
    if (floating) { host.showPopover(); position(); requestAnimationFrame(position); observer?.observe(editor); }
  }
  function preload(dates) {
    if (!active || !ownsSession()) return;
    for (const key of [...new Set(dates.map(day => weekKey(day)))].slice(0, 6)) {
      if (weeks.has(key) || pending.has(key)) continue;
      const read = protectedApi.get(`/api/users/me/weekly-notes?weekStart=${key}`, { signal: preloadController.signal })
        .then(value => {
          const saved = readWeek(value, key);
          if (!active || !ownsSession() || weeks.has(key)) return;
          weeks.set(key, { notes: [...saved.notes], baseline: [...saved.notes], revision: saved.revision, dirty: false, uncertain: false, undo: [], redo: [] });
          onChange?.();
        }).catch(() => { /* The selected editor provides explicit read recovery. */ })
        .finally(() => pending.delete(key));
      pending.set(key, read);
    }
  }
  const stop = () => { active = false; preloadController.abort(); presentationController.abort(); close(); };
  signal?.addEventListener('abort', stop, { once: true });
  return { open, close, preload, refreshAfterSessionCheck: options => editor?.refreshAfterSessionCheck?.(options), dispose() { signal?.removeEventListener('abort', stop); stop(); } };
}
