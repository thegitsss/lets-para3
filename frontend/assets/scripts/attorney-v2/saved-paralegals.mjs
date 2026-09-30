import { profilePhoto, candidateHref } from './candidate-model.mjs';
import { availabilityDot } from "./availability-dot.mjs";
import { node, button, link } from './dom.mjs';
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
function styles() {
  if (!document.querySelector('[data-saved-paralegals-style]')) document.head.append(node('link', { rel: 'stylesheet', href: '/assets/styles/saved-paralegals.css', 'data-saved-paralegals-style': '' }));
}
function readState(value, id, ownerId) {
  if (value?.ownerId !== ownerId || value.paralegalId !== id || typeof value.saved !== 'boolean' || typeof value.decided !== 'boolean') throw new Error('Invalid saved paralegal');
  return value;
}
export function createSaveParalegal(id, { api, signal, ownerId, prompt = false, iconOnly = false, onDecision = () => {} }) {
  styles();
  const section = node('section', { className: 'lpc-save-paralegal', 'data-save-paralegal': id, 'aria-label': 'Save paralegal' });
  const status = node('p', { role: 'status', tabindex: '-1', text: 'Checking saved paralegal…' }), actions = node('div', { className: 'lpc-saved-actions' });
  section.append(status, actions);
  let state = null, busy = false;
  function render() {
    actions.replaceChildren();
    if (!state) return;
    if (prompt && (state.decided || !state.available)) { section.hidden = true; return; }
    if (state.available === false && !state.saved) { section.hidden = true; return; }
    section.hidden = false;
    status.classList.toggle('lpc-save-status-quiet', iconOnly && !prompt);
    status.textContent = prompt ? 'Save this paralegal for future work?' : state.saved ? 'Saved to your paralegals.' : '';
    const yes = button(prompt ? 'Yes, save' : state.saved ? 'Remove from saved' : 'Save paralegal', () => void save(!state.saved), 'lpc-saved-button');
    if (iconOnly && !prompt) {
      const label = state.saved ? 'Remove from saved' : 'Save paralegal';
      yes.classList.add('lpc-save-star');
      yes.setAttribute('aria-label', label);
      yes.setAttribute('aria-pressed', String(state.saved));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', 'M6 3h12v18l-6-4-6 4V3Z');
      svg.append(path);
      yes.replaceChildren(svg, node('span', { className: 'lpc-save-star-tooltip', 'aria-hidden': 'true', text: label }));
    }
    actions.append(yes);
    if (prompt) actions.append(button('No, thanks', () => void save(false), 'lpc-saved-button lpc-saved-secondary'));
  }
  async function load() {
    if (signal.aborted) return;
    try {
      const value = readState(await api.readSavedParalegal(id, { signal, ownerId }), id, ownerId);
      if (signal.aborted) return;
      if (typeof value.available !== 'boolean') throw new Error('Invalid availability');
      state = value; render();
    } catch { if (!signal.aborted) { status.classList.remove('lpc-save-status-quiet'); status.textContent = 'Saved paralegal details couldn’t load.'; actions.replaceChildren(button('Retry', () => void load(), 'lpc-saved-button')); } }
  }
  async function save(saved) {
    if (busy || signal.aborted) return;
    busy = true; actions.querySelectorAll('button').forEach(control => control.disabled = true);
    try {
      const value = readState(await api.saveParalegal(id, saved, { signal, ownerId }), id, ownerId);
      if (signal.aborted) return;
      state = { ...state, ...value }; render();
      if (prompt) { section.hidden = false; actions.replaceChildren(); status.textContent = saved ? 'Saved. Find them in Saved paralegals whenever you need them.' : 'No problem. You can save their profile later.'; if (saved) actions.append(link('View saved paralegals', location.pathname.endsWith('/attorney-v2.html') ? '#/paralegals?view=saved' : '/browse-paralegals.html?view=saved')); }
      (actions.querySelector('button, a') || status).focus({ preventScroll: true });
      onDecision(saved);
    } catch {
      if (!signal.aborted) { status.classList.remove('lpc-save-status-quiet'); status.textContent = 'Your choice couldn’t be confirmed. Check its status before trying again.'; actions.replaceChildren(button('Check status', () => void load(), 'lpc-saved-button')); actions.firstChild.focus({ preventScroll: true }); }
    } finally { busy = false; }
  }
  signal.addEventListener('abort', () => section.replaceChildren(), { once: true });
  section.readiness = load(); return section;
}
export function createSavedParalegals({ api, signal, ownerId, legacy = false, context = new URLSearchParams(), returnTo = '#/paralegals?view=saved' }) {
  styles();
  const profileContext = new URLSearchParams(context); profileContext.set('returnTo', returnTo);
  const section = node('section', { className: 'lpc-saved-paralegals', 'aria-label': 'Saved paralegals', 'data-saved-paralegals': '' });
  const status = node('p', { role: 'status' }), content = node('div', { className: 'lpc-saved-grid' }), controls = node('nav', { className: 'lpc-saved-actions', 'aria-label': 'Saved paralegal pages' });
  section.append(...(legacy ? [node('p', { text: 'Only you can see your saved paralegals.' })] : []), status, content, controls);
  let page = 1, sequence = 0;
  async function load() {
    const ticket = ++sequence;
    status.textContent = 'Loading saved paralegals…'; content.replaceChildren(); controls.replaceChildren();
    try {
      const value = await api.readSavedParalegals(page, { signal, ownerId });
      if (signal.aborted || ticket !== sequence) return;
      if (value?.ownerId !== ownerId || !Array.isArray(value.items) || !Number.isSafeInteger(value.total) || value.total < 0 || value.page !== page || !Number.isSafeInteger(value.pages) || value.pages < 0 || value.items.some(item => !validId(item.id) || item.profile !== null && (typeof item.profile?.name !== 'string' || !Array.isArray(item.profile.practiceAreas)))) throw new Error('Invalid saved list');
      if (!value.items.length && page > 1) { page--; return load(); }
      status.textContent = value.total ? `${value.total} saved ${value.total === 1 ? 'paralegal' : 'paralegals'}` : 'No saved paralegals yet. Save someone from their profile or after completing a matter together.';
      for (const item of value.items) {
        const profile = item.profile, notice = node('p', { role: 'status' });
        const card = node('article', { className: 'lpc-saved-card', 'data-saved-profile': item.id }, [node(legacy ? 'h3' : 'h2', { text: profile?.name || 'Profile currently unavailable' })]);
        if (profile) {
          card.querySelector('h2,h3').replaceChildren(link(profile.name, legacy ? `/profile-paralegal.html?id=${item.id}` : candidateHref(item.id, profileContext)));
          card.append(node('p', { text: [profile.location, profile.practiceAreas.join(', ')].filter(Boolean).join(' · ') }));
        }
        if (profile) card.querySelector('h2,h3').append(...availabilityDot(profile));
        card.querySelectorAll('p').forEach(element => { if (!element.textContent.trim()) element.remove(); });
        const remove = button('Remove from saved', async () => {
          remove.disabled = true;
          try { readState(await api.saveParalegal(item.id, false, { signal, ownerId }), item.id, ownerId); if (!signal.aborted) await load(); }
          catch { if (!signal.aborted) { notice.textContent = 'Removal couldn’t be confirmed. Reload the list to check.'; remove.disabled = false; } }
        }, 'lpc-saved-button lpc-saved-secondary');
        if (!legacy) {
          const info = node('div', { className: 'lpc-saved-info' });
          info.append(...card.childNodes);
          const initials = (profile?.name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
          const avatar = node('span', { className: 'lpc-saved-avatar', 'aria-hidden': 'true', text: initials || '—' });
          if (profile?.avatarURL) {
            const image = node('img', { src: profilePhoto(profile.avatarURL, item.id, location.origin), alt: '', width: '38', height: '38', loading: 'lazy' });
            image.addEventListener('error', () => avatar.replaceChildren(initials || '—'), { once: true });
            avatar.replaceChildren(image);
          }
          remove.className = 'lpc-saved-remove-icon';
          remove.setAttribute('aria-label', `Remove ${profile?.name || 'paralegal'} from saved`);
          remove.setAttribute('title', 'Remove from saved');
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS(svg.namespaceURI, 'path');
          path.setAttribute('d', 'M6 3h12v18l-6-4-6 4V3Z'); svg.append(path); remove.replaceChildren(svg);
          card.append(avatar, info, remove, notice);
        } else card.append(remove, notice);
        content.append(card);
      }
      if (page > 1) controls.append(button('Previous', () => { page--; void load(); }, 'lpc-saved-button'));
      if (page < value.pages) controls.append(button('Next', () => { page++; void load(); }, 'lpc-saved-button'));
    } catch { if (!signal.aborted && ticket === sequence) { content.replaceChildren(); status.textContent = 'Saved paralegals couldn’t load.'; controls.replaceChildren(button('Retry', () => void load(), 'lpc-saved-button')); } }
  }
  signal.addEventListener('abort', () => { sequence++; section.replaceChildren(); }, { once: true });
  section.readiness = load(); return section;
}

export async function showSaveParalegalDialog(id, options) {
  const controller = new AbortController();
  const dialog = node('dialog', { className: 'lpc-saved-dialog', 'aria-label': 'Save paralegal for future work' });
  const content = createSaveParalegal(id, { ...options, signal: controller.signal, prompt: true });
  const done = button('Continue', () => dialog.close(), 'lpc-saved-button lpc-saved-secondary');
  dialog.append(content, done); document.body.append(dialog);
  await content.readiness;
  if (content.hidden) { controller.abort(); dialog.remove(); return; }
  await new Promise(resolve => { dialog.addEventListener('close', resolve, { once: true }); dialog.showModal(); });
  controller.abort(); dialog.remove();
}
