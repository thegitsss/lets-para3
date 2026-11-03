import { node } from './dom.mjs';

export const ATTORNEY_TOUR_VERSION = 'attorney-welcome-v1';
export const ATTORNEY_TOUR_STEPS = Object.freeze([
  { title: 'Welcome. We’re glad you’re here.', copy: 'Take a quick tour of the platform to get familiar with your workspace.', scene: 'welcome', path: '/home' },
  { title: 'Build your profile.', copy: 'Add your firm, practice areas, and introduction so paralegals can get to know your practice.', scene: 'profile', path: '/settings?tab=profile', rows: ['Your firm', 'Practice areas', 'About your practice'] },
  { title: 'Find a Paralegal', copy: 'Browse profiles and review practice areas, skills, and availability before inviting a paralegal to your Matter.', scene: 'browse', path: '/paralegals', rows: ['Practice areas', 'Skills', 'Availability'] },
  { title: 'Manage your matters.', copy: 'Open Matters to review applications, message your paralegal, share files, and review submitted work.', scene: 'workspace', path: '/matters', rows: ['Messages', 'Files & submissions', 'Review work'] },
]);

function illustration(step) {
  if (step.scene === 'welcome') {
    return node('div', { className: 'lpc-tour-demo lpc-welcome-demo lpc-welcome-demo-welcome', 'aria-hidden': 'true' }, [
      node('div', { className: 'lpc-welcome-landscape' }, [
        node('img', { className: 'lpc-welcome-mountain', src: '/hero-mountain-restored.jpg', alt: '', width: '1536', height: '1024' }),
        ...['left', 'right'].map(side => node('img', { className: `lpc-welcome-cloud lpc-welcome-cloud-${side}`, src: '/assets/images/homepage-capacity/cloud.webp', alt: '', width: '1800', height: '764' })),
        node('div', { className: 'lpc-welcome-landscape-brand' }, [node('img', { src: '/assets/images/homepage-capacity/lpc-filled-wordmark.svg', alt: '', width: '196', height: '28' })]),
      ]),
    ]);
  }
  return node('div', { className: `lpc-tour-demo lpc-tour-demo-${step.scene}`, 'aria-hidden': 'true' }, [
    node('div', { className: 'lpc-demo-window' }, [
      node('div', { className: 'lpc-demo-toolbar' }, [node('span'), node('span'), node('span'), node('i')]),
      node('div', { className: 'lpc-demo-body' }, step.rows.map((text, index) => node('div', { className: `lpc-demo-row lpc-demo-row-${index}` }, [
        node('span', { className: 'lpc-demo-dot' }), node('span', { text }), node('i'),
      ]))),
    ]),
  ]);
}

// Completion is supplied by the workspace's existing owner-checked account API.
// The review page uses this same renderer without making account requests.
export function createAttorneyTour({ getIdentity, navigate, complete, startMatter, readFirstVisit, hasUnfinishedWork = () => false, onBlocked, storage } = {}) {
  if (!storage) { try { storage = window.sessionStorage; } catch { storage = null; } }
  let current = null;
  const storageKey = id => `lpc_attorney_v2_onboarding:${id}`;
  function readProgress(id) {
    try { return JSON.parse(storage.getItem(storageKey(id)) || '{}') || {}; } catch { return {}; }
  }
  function storeProgress(id, value) {
    try { storage.setItem(storageKey(id), JSON.stringify({ ...readProgress(id), ...value, tourVersion: ATTORNEY_TOUR_VERSION })); } catch { /* Storage never authorizes a tour or account write. */ }
  }
  function stop() {
    if (!current) return;
    const active = current;
    current = null;
    active.events.abort();
    if (active.dialog.open) active.dialog.close();
    active.dialog.remove();
    if (active.returnFocus?.isConnected) active.returnFocus.focus({ preventScroll: true });
  }
  function open({ resume = false, origin = '/home', trigger = document.activeElement } = {}) {
    const identity = getIdentity?.();
    if (!identity?.id || identity.role !== 'attorney' || current) return false;
    if (hasUnfinishedWork()) { onBlocked?.(); return false; }
    const ownerId = identity.id;
    const events = new AbortController();
    const prior = readProgress(ownerId);
    let index = resume && Number.isInteger(prior.tour) ? Math.max(0, Math.min(ATTORNEY_TOUR_STEPS.length - 1, prior.tour)) : 0;
    let moving = false, navigationFailed = false, completionUncertain = false;
    const title = node('h2', { id: 'attorney-tour-title', tabindex: '-1' });
    const copy = node('p', { id: 'attorney-tour-copy', 'data-v2-onboarding-copy': '' });
    const art = node('div', { className: 'lpc-tour-art' });
    const progress = node('p', { className: 'v2-onboarding-progress', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const feedback = node('p', { className: 'attorney-tour-feedback', role: 'status', hidden: true });
    const segments = node('div', { className: 'lpc-tour-steps', 'aria-hidden': 'true' }, ATTORNEY_TOUR_STEPS.map(() => node('span')));
    const skip = node('button', { type: 'button', className: 'lpc-tour-dismiss', text: 'Skip tour' });
    const back = node('button', { type: 'button', className: 'lpc-tour-back', text: 'Back' });
    const next = node('button', { type: 'button', className: 'lpc-tour-next', 'data-attorney-tour-next': '' });
    const brand = node('img', { src: '/assets/images/homepage-capacity/lpc-filled-wordmark.svg', alt: 'Let’s-ParaConnect', width: '112', height: '18' });
    const meta = node('header', { className: 'lpc-tour-meta' });
    const card = node('section', { className: 'lpc-tour-card' }, [
      meta,
      art, node('div', { className: 'lpc-tour-copy' }, [title, copy]), segments, feedback,
      node('footer', {}, [skip, node('div', { className: 'lpc-tour-actions' }, [back, next])]),
    ]);
    const dialog = node('dialog', { className: 'v2-onboarding-dialog attorney-workspace-tour', 'data-tour-kind': 'welcome', 'aria-labelledby': title.id, 'aria-describedby': copy.id, 'data-attorney-tour': '' }, [card]);
    const active = { dialog, events, ownerId, returnFocus: trigger, path: ATTORNEY_TOUR_STEPS[index].path };
    current = active;
    const valid = () => current === active && !events.signal.aborted && getIdentity?.()?.id === ownerId && getIdentity?.()?.role === 'attorney';
    function render() {
      const step = ATTORNEY_TOUR_STEPS[index];
      active.path = step.path;
      meta.replaceChildren(...(index === 0 ? [progress] : [brand, progress]));
      if (index === 0) title.replaceChildren('Welcome.', node('br'), 'We’re glad you’re here.');
      else title.textContent = step.title;
      copy.textContent = index === 0 && startMatter ? 'Start your first Matter, or take a quick look around.' : step.copy;
      progress.textContent = `${index + 1} of ${ATTORNEY_TOUR_STEPS.length}`;
      art.replaceChildren(illustration(step));
      card.dataset.scene = step.scene;
      [...segments.children].forEach((part, position) => { part.dataset.state = position < index ? 'complete' : position === index ? 'current' : 'upcoming'; });
      back.hidden = index === 0; back.disabled = moving;
      next.disabled = moving;
      skip.textContent = index === 0 ? startMatter ? 'Show me around' : 'Explore on my own' : 'Skip tour';
      next.textContent = moving ? 'One moment…' : navigationFailed || completionUncertain ? 'Try again' : index === 0 ? startMatter ? 'Post a Matter' : 'Show me around' : index === ATTORNEY_TOUR_STEPS.length - 1 ? 'Make myself at home' : 'Next';
      storeProgress(ownerId, { tour: index, dismissed: false });
    }
    async function show(position) {
      if (!valid() || moving) return;
      index = position; moving = true; navigationFailed = false; feedback.hidden = true;
      render();
      try {
        await navigate?.(ATTORNEY_TOUR_STEPS[index].path, { signal: events.signal });
        if (!valid()) return;
      } catch (error) {
        if (!valid() || error?.name === 'AbortError') return;
        navigationFailed = true; feedback.textContent = 'This page couldn’t open. Try again or skip the tour.'; feedback.hidden = false;
      } finally {
        if (valid()) { moving = false; render(); title.focus({ preventScroll: true }); }
      }
    }
    async function dismiss() {
      if (!valid()) return;
      storeProgress(ownerId, { tour: index, dismissed: true });
      stop();
      try { await navigate?.(origin); } catch { /* The current page remains available. */ }
    }
    skip.addEventListener('click', () => {
      if (index === 0 && startMatter) { void show(1); return; }
      void dismiss();
    });
    back.addEventListener('click', () => { if (index > 0) void show(index - 1); });
    next.addEventListener('click', async () => {
      if (!valid() || moving) return;
      if (navigationFailed) { await show(index); return; }
      if (index === 0 && startMatter) {
        if (hasUnfinishedWork()) { onBlocked?.(); return; }
        // Choosing a Matter skips the tour; it does not claim the tour was completed.
        storeProgress(ownerId, {tour:index, dismissed:true});
        stop();
        await startMatter({ownerId});
        return;
      }
      if (index < ATTORNEY_TOUR_STEPS.length - 1) { await show(index + 1); return; }
      moving = true; feedback.hidden = true; render();
      try {
        await complete?.({ ownerId, signal: events.signal, checkFirst: completionUncertain });
        if (!valid()) return;
        storeProgress(ownerId, { tour: index, tourCompleted: true, dismissed: false });
        stop();
        await navigate?.('/home');
      } catch (error) {
        if (!valid() || error?.name === 'AbortError') return;
        completionUncertain = true;
        feedback.textContent = 'The tour is complete, but saving your preference wasn’t confirmed.';
        feedback.hidden = false;
      } finally { if (valid()) { moving = false; render(); } }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
    dialog.addEventListener('close', () => { if (current === active) stop(); });
    dialog.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); next.click(); }
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); back.click(); }
    });
    document.body.append(dialog); render(); dialog.showModal(); next.focus({ preventScroll: true });
    if (index > 0) void show(index);
    return true;
  }
  function consider(route) {
    if (!route) return;
    const query = new URLSearchParams(route.query); query.delete('replayTour');
    const origin = `${route.path}${query.size ? `?${query}` : ''}`;
    if (current) {
      if (origin !== current.path) stop();
      return;
    }
    let requested = route?.query?.get('replayTour') === '1' || new URLSearchParams(location.search).get('replayTour') === '1';
    try { requested ||= storage?.getItem('lpc_attorney_replay_tour') === '1'; } catch { /* Explicit guide links remain available. */ }
    if (!requested) return;
    if (hasUnfinishedWork()) { onBlocked?.(); return; }
    const url = new URL(location.href); url.searchParams.delete('replayTour'); url.hash = origin;
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    try { storage?.removeItem('lpc_attorney_replay_tour'); } catch { /* Optional legacy replay hint. */ }
    const user = getIdentity?.();
    const progress = user?.id ? readProgress(user.id) : {};
    open({ origin, resume: progress.tourVersion === ATTORNEY_TOUR_VERSION && !progress.tourCompleted && Number.isInteger(progress.tour) });
  }
  async function considerFirstVisit(route) {
    const user = getIdentity?.();
    if (!readFirstVisit || !user?.isFirstLogin || route?.name !== 'home' || current || hasUnfinishedWork()) return;
    const ownerId = user.id, origin = location.href, progress = readProgress(ownerId);
    if (progress.dismissed || progress.tourCompleted || Number.isInteger(progress.tour)) return;
    try {
      const allowed = await readFirstVisit({ownerId});
      if (!allowed || current || getIdentity?.()?.id !== ownerId || location.href !== origin || hasUnfinishedWork() || document.querySelector('dialog[open]')) return;
      const latest = readProgress(ownerId);
      if (latest.dismissed || latest.tourCompleted || Number.isInteger(latest.tour)) return;
      open({origin:route.path});
    } catch { /* Home and its existing actions stay available when readiness cannot be confirmed. */ }
  }
  return { open, consider, considerFirstVisit, stop, get active() { return Boolean(current); } };
}
