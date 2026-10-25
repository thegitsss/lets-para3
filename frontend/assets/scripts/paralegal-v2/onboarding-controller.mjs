import { createProfileTourSnippet } from './profile-tour-snippet.mjs';
import { documentIsLeaving } from '../utils/document-navigation.mjs';

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === 'className') element.className = value;
    else if (name === 'text') element.textContent = String(value);
    else element.setAttribute(name, value === true ? '' : String(value));
  });
  children.flat().filter(Boolean).forEach(child => element.append(child instanceof Node ? child : document.createTextNode(String(child))));
  return element;
}

// These IDs are versioned persisted preferences, not page-visit markers.
export const PORTAL_TOURS = Object.freeze({
  'welcome-v1': { label: 'Welcome', steps: [
    { title: 'Welcome. We’re glad you’re here.', copy: 'Take a quick tour of the platform to get familiar with your workspace.', scene: 'welcome' },
    { title: 'Build your profile.', copy: 'Add your experience, education, and skills so attorneys can see what you bring to their matters.', scene: 'profile', path: '/settings?tab=profile', target: '.v2-profile-identity-summary' },
    { title: 'Find work and apply.', copy: 'Browse available matters in Find Work. Review the scope and requirements, then apply to the ones that fit your experience.', scene: 'browse', path: '/browse', target: '#v2-browse-title' },
    { title: 'Manage your matters.', copy: 'Once you’re hired, open Matters to message the attorney, share files, and submit completed work for review.', scene: 'workspace', path: '/work?section=active', target: '.v2-work-titlebar' },
  ] },
  'profile-v1': { label: 'Profile', route: 'settings', steps: [
    { title: 'Your experience, in view.', copy: 'Select a profile detail to edit it. Changes save automatically.', target: '.v2-profile-identity-summary', scene: 'profile' },
    { title: 'A photo that’s you.', copy: 'New photos need your confirmation before submission for approval. Editing the crop saves directly.', target: '.v2-settings-photo', scene: 'profile' },
  ] },
  'browse-v1': { label: 'Find Work', route: 'browse', steps: [
    { title: 'Narrow the possibilities.', copy: 'Use Filters to find matters that fit your experience and practice areas.', target: '.v2-browse-filter-toggle', scene: 'browse' },
    { title: 'Start with the scope.', copy: 'Open a matter to review its requirements before choosing to apply.', target: '[data-browse-detail-id]', scene: 'browse' },
  ] },
  'matters-v1': { label: 'Matters', route: 'work', steps: [
    { title: 'Keep track of each step.', copy: 'Switch between active work, applications, invitations, and history here.', target: '.v2-work-titlebar', scene: 'workspace' },
    { title: 'Choose your view.', copy: 'Use List or Board to see your matters in the layout you prefer.', target: '.pv2-work-display', scene: 'workspace' },
  ] },
  'workspace-v1': { label: 'Matter workspace', route: 'matter', steps: [
    { title: 'Ready for review.', copy: 'Use Files & submissions to send work for attorney review when submission is available.', target: '[data-matter-tab="files"]', scene: 'files' },
    { title: 'Follow the record.', copy: 'Activity keeps the matter’s record together as the work moves forward.', target: '[data-matter-tab="activity"]', scene: 'workspace' },
  ] },
});
const validStatus = value => value === 'completed' || value === 'dismissed';
function normalizedState(value = {}) {
  return {
    paralegalTourCompleted: value.paralegalTourCompleted === true,
    paralegalProfileTourCompleted: value.paralegalProfileTourCompleted === true,
    paralegalWelcomePending: value.paralegalWelcomePending === true,
    paralegalTours: Object.fromEntries(Object.keys(PORTAL_TOURS).filter(id => validStatus(value.paralegalTours?.[id])).map(id => [id, value.paralegalTours[id]])),
  };
}

function recordedDemonstration(scene) {
  const base = `assets/media/paralegal-tour/${scene}`;
  const poster = node('img', { src: `${base}.png`, alt: '', width: '580', height: '326' });
  const video = node('video', { poster: `${base}.png`, muted: '', playsinline: '', preload: 'none', tabindex: '-1', 'aria-hidden': 'true' });
  video.muted = true;
  const demo = node('div', { className: 'lpc-tour-demo lpc-welcome-recording', 'aria-hidden': 'true' }, [poster, video]);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  const play = () => {
    if (motion.matches) { video.pause(); video.style.opacity = '0'; return; }
    if (document.visibilityState === 'hidden') { video.pause(); return; }
    if (!video.getAttribute('src')) video.src = `${base}.mp4`;
    if (!video.ended) void video.play().catch(() => { video.style.opacity = '0'; });
  };
  video.addEventListener('playing', () => { video.style.opacity = '1'; }, { signal: events.signal });
  video.addEventListener('error', () => { video.style.opacity = '0'; }, { signal: events.signal });
  motion.addEventListener('change', play, { signal: events.signal });
  document.addEventListener('visibilitychange', play, { signal: events.signal });
  demo.__tourCleanup = () => { events.abort(); video.pause(); video.removeAttribute('src'); video.load(); };
  queueMicrotask(() => { if (demo.isConnected) play(); });
  return demo;
}

function welcomeDemonstration(scene) {
  if (scene === 'profile') return createProfileTourSnippet();
  if (scene !== 'welcome') return recordedDemonstration(scene);
  const landscape = node('div', { className: 'lpc-welcome-landscape' }, [
    node('img', { className: 'lpc-welcome-mountain', src: 'hero-mountain-restored.jpg', alt: '', width: '1536', height: '1024' }),
    ...['left', 'right'].map(side => node('img', { className: `lpc-welcome-cloud lpc-welcome-cloud-${side}`, src: 'assets/images/homepage-capacity/cloud.webp', alt: '', width: '1800', height: '764' })),
    node('div', { className: 'lpc-welcome-landscape-brand' }, [node('img', { src: 'assets/images/homepage-capacity/lpc-filled-wordmark.svg', alt: '', width: '196', height: '28' })]),
  ]);
  return node('div', { className: 'lpc-tour-demo lpc-welcome-demo lpc-welcome-demo-welcome', 'aria-hidden': 'true' }, [landscape]);
}

function demonstration(scene, { welcome = false } = {}) {
  if (welcome) return welcomeDemonstration(scene);
  const row = (label, index) => node('div', { className: `lpc-demo-row lpc-demo-row-${index}` }, [node('span', { className: 'lpc-demo-dot' }), node('span', { text: label }), node('i')]);
  const labels = {
    welcome: ['Your profile', 'Find Work', 'Your matters'],
    profile: ['Experience', 'Education', 'Skills'],
    browse: ['Review the scope', 'Check requirements', 'Choose your next matter'],
    workspace: ['Work', 'Messages', 'Files'],
    files: ['Choose a file', 'Review your submission', 'Send for review'],
  };
  return node('div', { className: `lpc-tour-demo lpc-tour-demo-${scene}`, 'aria-hidden': 'true' }, [
    node('div', { className: 'lpc-demo-window' }, [
      node('div', { className: 'lpc-demo-toolbar' }, [node('span'), node('span'), node('span'), node('i')]),
      node('div', { className: 'lpc-demo-body' }, (labels[scene] || labels.workspace).map(row)),
    ]),
    node('span', { className: 'lpc-demo-cursor' }, [node('i')]),
  ]);
}

export function createOnboardingController({ api, dialogHost, getIdentity, updateIdentity, showToast, getRoute, navigateTour, hasUnfinishedWork = () => false, setupFlow } = {}) {
  let state = normalizedState(), userId = '', dialog = null;
  let loading = null, readController = null, suspended = false, ready = false;
  let generation = 0, stateRevision = 0, timer = null, lastInputAt = -Infinity;
  const idleClock = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  let returnFocus = null, suppressedRoute = null, currentRouteKey = null;
  const dismissed = new Set();
  const outbox = new Map();

  function cancelRead() { readController?.abort(); readController = null; loading = null; }
  function suspendRead() { suspended = true; cancelRead(); clearTimeout(timer); closeDialog(); }
  function resumeRead(event) {
    if (!suspended || documentIsLeaving() || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    if (event.type !== 'pageshow' && event.isTrusted !== true) return;
    if (event.type === 'pageshow' && !event.persisted) return;
    const identity = getIdentity?.();
    if (!userId || String(identity?.id || identity?._id || '') !== userId) return;
    suspended = false;
    void start(identity);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', suspendRead);
    window.addEventListener('pagehide', suspendRead);
    window.addEventListener('pageshow', resumeRead);
    window.addEventListener('pointerdown', resumeRead, true);
    window.addEventListener('keydown', resumeRead, true);
    window.addEventListener('input', () => { lastInputAt = idleClock(); }, true);
    window.addEventListener('focusout', () => schedule(), true);
  }

  const storageKey = owner => `lpc_portal_tour_pending_v1:${owner}`;
  function storeOutbox() {
    try {
      if (outbox.size) localStorage.setItem(storageKey(userId), JSON.stringify(Object.fromEntries(outbox)));
      else localStorage.removeItem(storageKey(userId));
    } catch { /* Server persistence remains the primary record. */ }
  }
  function readOutbox() {
    outbox.clear();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(userId)) || '{}');
      Object.entries(saved).forEach(([id, status]) => { if (PORTAL_TOURS[id] && validStatus(status)) outbox.set(id, status); });
    } catch { /* Storage may be unavailable. */ }
  }
  function syncIdentity() {
    const identity = getIdentity?.() || {};
    updateIdentity?.({ ...identity, onboarding: { ...(identity.onboarding || {}), ...state } });
  }
  async function saveProgress(id, status) {
    const owner = userId, ticket = generation;
    if (String(getIdentity?.()?.id || getIdentity?.()?._id || '') !== owner) return false;
    stateRevision++;
    outbox.set(id, status); storeOutbox();
    try {
      const result = await api.request('/api/users/me/onboarding', { method: 'PATCH', body: JSON.stringify({ expectedOwnerId: owner, paralegalTours: { [id]: status } }) });
      if (userId !== owner || generation !== ticket || String(getIdentity?.()?.id || getIdentity?.()?._id || '') !== owner) return false;
      if (result?.onboarding?.paralegalTours?.[id] !== status) throw new Error('Tour progress was not confirmed.');
      state = normalizedState(result.onboarding); stateRevision++;
      if (outbox.get(id) === status) outbox.delete(id);
      storeOutbox(); syncIdentity();
      return true;
    } catch {
      if (userId === owner && generation === ticket) showToast?.('Your tour is closed on this device. Progress couldn’t sync; we’ll retry when you return.');
      return false;
    }
  }
  function closeDialog() {
    if (!dialog) return;
    const current = dialog; dialog = null;
    current.__tourCleanup?.();
    if (current.open) current.close();
    current.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function visibleTarget(selector) {
    if (!selector) return null;
    return [...document.querySelectorAll(selector)].find(target => {
      const rect = target.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
        && !target.closest('[inert], [hidden], [aria-hidden="true"]');
    }) || null;
  }
  function isBusy() {
    const active = document.activeElement;
    if (hasUnfinishedWork() || document.visibilityState === 'hidden' || idleClock() - lastInputAt < 1600
        || active?.matches?.('input, textarea, select, [contenteditable="true"]')
        || document.querySelector('dialog[open], [aria-busy="true"], input[type="file"][data-uploading]')) return true;
    try { if (document.querySelector(':popover-open, details[open]:not(.v2-sidebar-disclosure)')) return true; } catch { /* Older engines may not support :popover-open. */ }
    return false;
  }
  function isEligible(id) {
    return !state.paralegalTours[id] && !outbox.has(id) && !dismissed.has(id)
      && !(id === 'welcome-v1' && state.paralegalTourCompleted)
      && !(id === 'profile-v1' && state.paralegalProfileTourCompleted);
  }
  function tourForRoute(route) {
    if (!route) return null;
    if (route.name === 'settings' && (route.query?.get('tab') || 'profile') !== 'profile') return null;
    if (route.name === 'browse' && route.query?.get('matterId')) return null;
    return Object.keys(PORTAL_TOURS).find(id => PORTAL_TOURS[id].route === route.name) || null;
  }
  function schedule(delay = 700) {
    clearTimeout(timer);
    if (!ready || suspended || !userId || typeof document === 'undefined' || dialog || documentIsLeaving()) return;
    const route = getRoute?.();
    if (!route || route.key === suppressedRoute) return;
    const welcome = state.paralegalWelcomePending && isEligible('welcome-v1');
    const id = welcome ? 'welcome-v1' : setupFlow ? null : tourForRoute(route);
    if (!id || !isEligible(id)) return;
    timer = setTimeout(() => {
      if (route.key !== getRoute?.()?.key || suspended || dialog) return;
      if (!openTour(id)) schedule(1200);
    }, delay);
  }

  function openTour(id, { force = false, trigger = null } = {}) {
    const tour = PORTAL_TOURS[id];
    const identity = getIdentity?.();
    if (!tour || !userId || String(identity?.id || identity?._id || '') !== userId || !ready || identity?.role !== 'paralegal' || identity?.status !== 'approved'
        || dialog || (!force && !isEligible(id))) return false;
    if (!force && isBusy()) return false;
    const isWelcome = id === 'welcome-v1';
    if(isWelcome && setupFlow) {
      clearTimeout(timer);
      const opened=setupFlow.showWelcome(trigger,status=>{dismissed.add(id);void saveProgress(id,status);});
      if(opened)dismissed.add(id);
      return opened;
    }
    const routeKey = getRoute?.()?.key;
    const replayAway = force && tour.route !== getRoute?.()?.name;
    const steps = tour.steps.filter(step => isWelcome || replayAway || visibleTarget(step.target));
    if (!steps.length) return false;
    clearTimeout(timer);
    let index = 0, moving = false;
    const originRoute = getRoute?.();
    const originQuery = new URLSearchParams(originRoute?.query);
    originQuery.delete('tour'); originQuery.delete('profilePrompt');
    const origin = `${originRoute?.pathname || originRoute?.key?.split('?')[0] || '/home'}${originQuery.size ? `?${originQuery}` : ''}`;
    const scrollOwner = document.querySelector('[data-v2-route-outlet]');
    const originScroll = scrollOwner?.scrollTop || 0;
    const title = node('h2', { id: 'v2-onboarding-title', tabindex: '-1' });
    const copy = node('p', { 'data-v2-onboarding-copy': '', id: 'v2-onboarding-copy' });
    const art = node('div', { className: 'lpc-tour-art' });
    const progress = node('p', { className: 'v2-onboarding-progress', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const segments = node('div', { className: 'lpc-tour-steps', 'aria-hidden': 'true' }, steps.map(() => node('span')));
    const dismiss = node('button', { className: 'lpc-tour-dismiss', type: 'button', text: 'Explore on my own' });
    const back = node('button', { className: 'lpc-tour-back', type: 'button', text: 'Back' });
    const next = node('button', { className: 'lpc-tour-next', 'data-tour-next': '', type: 'button' });
    const card = node('section', { className: 'lpc-tour-card' }, [
      node('header', { className: 'lpc-tour-meta' }, [isWelcome ? null : node('img', { src: 'assets/images/homepage-capacity/lpc-filled-wordmark.svg', alt: 'Let’s-ParaConnect', width: '112', height: '18' }), progress]),
      art, node('div', { className: 'lpc-tour-copy' }, [title, copy]), segments,
      node('footer', {}, [dismiss, node('div', { className: 'lpc-tour-actions' }, [back, next])]),
    ]);
    const current = node('dialog', { className: 'v2-onboarding-dialog', 'aria-labelledby': 'v2-onboarding-title', 'aria-describedby': 'v2-onboarding-copy', 'data-v2-onboarding-dialog': id, 'data-tour-kind': isWelcome ? 'welcome' : 'page' }, [card]);
    const ring = node('div', { className: 'lpc-tour-ring', 'aria-hidden': 'true', hidden: true });
    current.prepend(ring);
    function positionTarget() {
      const target = (isWelcome || !replayAway) && visibleTarget(steps[index]?.target);
      ring.hidden = !target;
      if (target) {
        const rect = target.getBoundingClientRect();
        Object.assign(ring.style, { left: `${Math.max(2, rect.left - 4)}px`, top: `${Math.max(2, rect.top - 4)}px`, width: `${Math.min(rect.width + 8, innerWidth - Math.max(2, rect.left - 4) - 2)}px`, height: `${rect.height + 8}px` });
      }
    }
    function render() {
      const step = steps[index];
      title.textContent = step.title; copy.textContent = step.copy;
      art.firstElementChild?.__tourCleanup?.();
      const pageStop = isWelcome && index > 0;
      current.dataset.tourKind = pageStop ? 'guided' : isWelcome ? 'welcome' : 'page';
      art.hidden = pageStop;
      art.replaceChildren(...(pageStop ? [] : [demonstration(step.scene, { welcome: isWelcome })]));
      progress.textContent = `${index + 1} of ${steps.length}`;
      [...segments.children].forEach((segment, at) => segment.dataset.state = at === index ? 'current' : at < index ? 'complete' : 'upcoming');
      back.hidden = index === 0;
      next.textContent = index === steps.length - 1 ? (isWelcome ? 'Make myself at home' : 'Got it') : isWelcome && index === 0 ? 'Show me around' : 'Next';
      dismiss.textContent = isWelcome && index === 0 ? 'Explore on my own' : 'Skip tour';
      positionTarget();
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        card.querySelector('.lpc-tour-copy').animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(.2,.7,.3,1)' });
      }
    }
    async function move(to) {
      if (moving || dialog !== current) return;
      moving = true; current.__tourNavigating = true;
      next.disabled = back.disabled = dismiss.disabled = true;
      try {
        if (isWelcome && navigateTour) await navigateTour(steps[to].path || origin, {preview:true, scrollTop:to === 0 ? originScroll : 0});
        if (dialog !== current) return;
        index = to; render(); title.focus({preventScroll:true});
      } catch { showToast?.('This tour page couldn’t open. Try again or skip the tour.'); }
      finally { moving = false; current.__tourNavigating = false; next.disabled = back.disabled = dismiss.disabled = false; }
    }
    async function finish(status) {
      if (moving) return;
      moving = true; current.__tourNavigating = true;
      next.disabled = back.disabled = dismiss.disabled = true;
      try {
        if (isWelcome && navigateTour) await navigateTour(origin, {restore:true, scrollTop:originScroll});
      } catch { showToast?.('The tour is closed. Use navigation to return to your page.'); }
      if (dialog !== current) return;
      dismissed.add(id); suppressedRoute = getRoute?.()?.key || routeKey;
      void saveProgress(id, status);
      closeDialog();
    }
    dismiss.addEventListener('click', () => { void finish('dismissed'); });
    next.addEventListener('click', () => { void (index === steps.length - 1 ? finish('completed') : move(index + 1)); });
    back.addEventListener('click', () => { void move(Math.max(0,index - 1)); });
    current.addEventListener('cancel', event => { event.preventDefault(); void finish('dismissed'); });
    // A page tour never activates the highlighted product control.
    current.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); next.click(); }
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); back.click(); }
    });
    window.addEventListener('resize', positionTarget);
    document.addEventListener('scroll', positionTarget, true);
    current.__tourTargetAvailable = () => isWelcome || replayAway || Boolean(visibleTarget(steps[index]?.target));
    current.__tourCleanup = () => { art.firstElementChild?.__tourCleanup?.(); window.removeEventListener('resize', positionTarget); document.removeEventListener('scroll', positionTarget, true); };
    returnFocus = trigger || document.activeElement;
    (dialogHost || document.body).append(current); dialog = current;
    render(); current.showModal(); next.focus({ preventScroll: true });
    return true;
  }

  function routeChanged(route) {
    if (!userId || !route) return;
    if (dialog?.__tourNavigating) { currentRouteKey = route.key; return; }
    if (currentRouteKey && currentRouteKey !== route.key) { closeDialog(); suppressedRoute = null; }
    currentRouteKey = route.key;
    if (dialog && !dialog.__tourTargetAvailable?.()) { closeDialog(); }
    if (route.query?.get('tour') === '1' || route.query?.get('profilePrompt') === '1') {
      const id = route.query.get('profilePrompt') === '1' ? 'profile-v1' : 'welcome-v1';
      if (ready && openTour(id, { force: true })) consumeReplayFlags(route);
      return;
    }
    schedule();
  }
  function consumeReplayFlags(route) {
    route.query?.delete('tour'); route.query?.delete('profilePrompt');
    const url = new URL(window.location.href);
    const [path, rawQuery = ''] = url.hash.split('?');
    const query = new URLSearchParams(rawQuery); query.delete('tour'); query.delete('profilePrompt');
    url.hash = `${path}${query.size ? `?${query}` : ''}`;
    window.history.replaceState(window.history.state, '', url);
  }
  async function start(identity) {
    const nextUserId = String(identity?.id || identity?._id || '');
    if (!nextUserId || suspended || documentIsLeaving()) return;
    if (nextUserId !== userId) {
      generation++; stateRevision++; cancelRead(); clearTimeout(timer); closeDialog();
      dismissed.clear(); ready = false; suppressedRoute = null; currentRouteKey = null;
      userId = nextUserId; state = normalizedState(identity?.onboarding || {}); readOutbox();
    }
    const owner = userId, ticket = generation;
    if (!loading) {
      const revision = stateRevision;
      const reader = new AbortController(); readController = reader;
      const pending = api.get('/api/users/me/onboarding', { signal: reader.signal })
        .then(result => {
          if (reader.signal.aborted || readController !== reader || suspended || documentIsLeaving() || String(getIdentity?.()?.id || getIdentity?.()?._id || '') !== owner || userId !== owner || generation !== ticket || stateRevision !== revision) return;
          state = normalizedState(result?.onboarding || state); ready = true; syncIdentity();
        })
        .catch(error => {
          if (reader.signal.aborted || readController !== reader || suspended || documentIsLeaving() || userId !== owner || generation !== ticket) return;
          showToast?.(error?.message || 'We couldn’t load your tour progress. Please try again.');
        })
        .finally(() => { if (loading === pending) loading = null; if (readController === reader) readController = null; });
      loading = pending;
    }
    await loading;
    if (suspended || documentIsLeaving() || userId !== owner || generation !== ticket) return;
    for (const [id, status] of [...outbox]) { if (userId !== owner || generation !== ticket) return; await saveProgress(id, status); }
    routeChanged(getRoute?.());
  }
  function stop() {
    setupFlow?.stop();
    generation++; stateRevision++; cancelRead(); clearTimeout(timer); suspended = false; ready = false;
    closeDialog(); userId = ''; state = normalizedState(); dismissed.clear(); outbox.clear(); suppressedRoute = null; currentRouteKey = null;
  }
  return Object.freeze({ start, stop, routeChanged, replay: (trigger, id = 'welcome-v1') => openTour(id, { force: true, trigger }) });
}
