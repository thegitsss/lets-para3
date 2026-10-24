export const READING_SIZES = Object.freeze([
  ['xs', 'Extra small', '14px'], ['sm', 'Small', '15px'], ['md', 'Default', '16px'],
  ['lg', 'Large', '18px'], ['xl', 'Extra large', '20px'],
]);
export function normalizeAppearance(value) {
  const theme = String(value || '').trim().toLowerCase();
  return theme === 'system' ? 'system' : /dark$/.test(theme) ? 'dark' : 'light';
}
let preference = 'light', clockInstalled = false, clockTimer, lastResolved, activeTransition, transitionTimer, appearanceRevision = 0;
function appearanceTransitionStyle() {
  if (document.getElementById('lpc-appearance-transition-style')) return;
  const style = document.createElement('style');
  style.id = 'lpc-appearance-transition-style';
  style.textContent = `
    :root[data-lpc-appearance-transition="crossfade"]::view-transition-group(root) { animation:none; }
    :root[data-lpc-appearance-transition="crossfade"]::view-transition-old(root) { animation:lpc-appearance-fade 240ms cubic-bezier(.25,.1,.25,1) both; mix-blend-mode:normal; z-index:1; }
    :root[data-lpc-appearance-transition="crossfade"]::view-transition-new(root) { animation:none; mix-blend-mode:normal; }
    @keyframes lpc-appearance-fade { to { opacity:0; } }
    :root[data-lpc-appearance-transition="colors"],
    :root[data-lpc-appearance-transition="colors"] body,
    :root[data-lpc-appearance-transition="colors"] body * {
      transition:background-color 240ms ease,color 240ms ease,border-color 240ms ease,fill 240ms ease,stroke 240ms ease !important;
    }
    @media(prefers-reduced-motion:reduce) {
      :root[data-lpc-appearance-transition]::view-transition-old(root),
      :root[data-lpc-appearance-transition]::view-transition-new(root) { animation:none!important; }
      :root[data-lpc-appearance-transition="colors"],:root[data-lpc-appearance-transition="colors"] body,:root[data-lpc-appearance-transition="colors"] body * { transition:none!important; }
    }
  `;
  document.head.append(style);
}
export function applyAppearance(value) {
  preference = normalizeAppearance(value);
  if (typeof window === 'undefined' || typeof document === 'undefined') return preference;
  if (!clockInstalled) {
    clockInstalled = true;
    const refresh = () => { if (preference === 'system') applyAppearance(preference); };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
  }
  clearTimeout(clockTimer);
  const now = new Date();
  if (preference === 'system') {
    const next = new Date(now);
    const hour = now.getHours();
    next.setHours(hour < 7 ? 7 : hour < 19 ? 19 : 31, 0, 0, 0);
    clockTimer = setTimeout(() => applyAppearance(preference), Math.max(1, next - now));
  }
  const resolved = preference === 'system' ? (now.getHours() >= 7 && now.getHours() < 19 ? 'light' : 'dark') : preference;
  // Initial paint and unchanged projections stay immediate. Animate only a real
  // appearance change, without delaying preference saving or changing layout.
  if (lastResolved === resolved && (activeTransition || document.documentElement.dataset.lpcAppearanceTransition)) return preference;
  const animate = lastResolved !== undefined && lastResolved !== resolved
    && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  lastResolved = resolved;
  const revision = ++appearanceRevision;
  activeTransition?.skipTransition(); activeTransition = null;
  clearTimeout(transitionTimer);
  const root = document.documentElement;
  delete root.dataset.lpcAppearanceTransition;
  const commit = () => {
    if (revision !== appearanceRevision) return;
    for (const target of [root, document.body].filter(Boolean)) {
      target.classList.toggle('theme-light', resolved === 'light');
      target.classList.toggle('theme-dark', resolved === 'dark');
    }
    root.style.colorScheme = resolved;
  };
  if (!animate) commit();
  else {
    appearanceTransitionStyle();
    if (typeof document.startViewTransition === 'function') {
      root.dataset.lpcAppearanceTransition = 'crossfade';
      const transition = document.startViewTransition(commit);
      activeTransition = transition;
      transition.finished.catch(error => {
        // Reversing a transition intentionally cancels its finished promise.
        if (error?.name !== 'AbortError') console.warn('Theme transition did not finish.', error);
      }).finally(() => {
        if (revision === appearanceRevision) { delete root.dataset.lpcAppearanceTransition; activeTransition = null; }
      });
    } else {
      root.dataset.lpcAppearanceTransition = 'colors';
      // Establish the transition before changing the color variables.
      void getComputedStyle(root).backgroundColor;
      commit();
      transitionTimer = setTimeout(() => { if (revision === appearanceRevision) delete root.dataset.lpcAppearanceTransition; }, 280);
    }
  }
  return preference;
}

export function createReadingSizeControl(value, { onPreview = () => {} } = {}) {
  const element = document.createElement('div'); element.className = 'lpc-reading-size';
  element.innerHTML = '<div class="lpc-reading-size-heading">Text size</div><div class="lpc-reading-size-track"><span class="lpc-reading-size-small" aria-hidden="true">A</span><div class="lpc-reading-size-rail"><input type="range" min="0" max="4" step="1" aria-label="Text size"><div class="lpc-reading-size-ticks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><output aria-hidden="true"></output></div><span class="lpc-reading-size-large" aria-hidden="true">A</span></div>';
  const range = element.querySelector('input'), output = element.querySelector('output');
  const control = document.createElement('select'); control.hidden = true; control.tabIndex = -1; control.setAttribute('aria-hidden', 'true');
  for (const [key, label] of READING_SIZES) { const option = document.createElement('option'); option.value = key; option.textContent = label; control.append(option); }
  element.append(control);
  function sync(next) {
    const found = READING_SIZES.findIndex(([key]) => key === next);
    const index = found < 0 ? 2 : found;
    const [key, label] = READING_SIZES[index]; control.value = key; range.value = String(index);
    range.setAttribute('aria-valuetext', label); output.textContent = label;
    // Keep end labels inside the rail as reading text grows.
    output.style.left = index === 4 ? 'auto' : `${index * 25}%`;
    output.style.right = index === 4 ? '0' : 'auto';
    output.style.transform = index === 0 || index === 4 ? 'none' : 'translateX(-50%)';
  }
  range.addEventListener('input', () => { const [key] = READING_SIZES[Number(range.value)]; sync(key); onPreview(key); });
  range.addEventListener('change', () => { sync(READING_SIZES[Number(range.value)][0]); control.dispatchEvent(new Event('change', { bubbles: true })); });
  new MutationObserver(() => { range.disabled = control.disabled; }).observe(control, { attributes: true, attributeFilter: ['disabled'] });
  sync(READING_SIZES.some(([key]) => key === value) ? value : 'md');
  return { element, control, sync };
}
