import { createMatterPicker } from './matter-picker.mjs';

const changed = () => Object.assign(new Error('The signed-in account changed.'), { kind: 'authorization', code: 'ACCOUNT_CHANGED' });

export function createWorkspaceMatterSwitcher({ host, ownerId, role, currentId, api, onChoose, onAccountChanged }) {
  const lifecycle = new AbortController();
  const validOwner = /^[a-f0-9]{24}$/i.test(ownerId || '') && ['attorney', 'paralegal'].includes(role);
  const guardedApi = {
    async get(url, options) {
      const request = new AbortController();
      const abort = () => request.abort();
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      const timer = setTimeout(abort, 30000);
      const requestOptions = { ...options, signal: request.signal };
      const verify = async () => {
        if (lifecycle.signal.aborted) throw new DOMException('Workspace left.', 'AbortError');
        const { user } = await api.get('/api/auth/me', requestOptions);
        if (lifecycle.signal.aborted) throw new DOMException('Workspace left.', 'AbortError');
        if (!validOwner || String(user?.id || user?._id || '') !== ownerId || user?.role !== role || user?.status !== 'approved') throw changed();
      };
      try {
        await verify();
        const result = await api.get(url, requestOptions);
        await verify();
        return result;
      } catch (error) {
        if (error.code === 'ACCOUNT_CHANGED' || error.data?.code === 'ACCOUNT_CHANGED' || [401, 403].includes(error.status)) {
          lifecycle.abort(); onAccountChanged();
        }
        throw error;
      } finally {
        clearTimeout(timer); options.signal.removeEventListener('abort', abort);
      }
    },
  };
  const picker = createMatterPicker({
    label: 'Matter', triggerLabel: currentId ? 'Switch Matter' : 'Choose a Matter', dialogTitle: 'Choose a Matter',
    ownerId, api: guardedApi, signal: lifecycle.signal, endpoint: '/api/cases/workspace-choices',
    classPrefix: 'matter-switch', currentId, allowClear: false, scrollResults: true,
    emptyMessage: 'No current Matters are available.', formatStatus: record => {
      const status = record.status.trim().toLowerCase().replaceAll('_', ' ');
      return ['open', 'published', 'posted'].includes(status) ? 'Posted' : status ? status[0].toUpperCase() + status.slice(1) : '';
    },
  });
  picker.input.addEventListener('change', () => { if (!lifecycle.signal.aborted && picker.input.value) onChoose(picker.input.value); });
  host.replaceChildren(picker.element);
  return { open: picker.open, dispose: () => { lifecycle.abort(); host.replaceChildren(); } };
}
