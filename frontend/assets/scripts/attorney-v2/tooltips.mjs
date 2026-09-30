// Shared, viewport-bounded labels for secondary controls. Sidebar action labels
// retain their clickable pseudo-elements; ordinary hints never intercept input.
export function createTooltips() {
  const tip = document.createElement('div');
  tip.className = 'av2-tooltip'; tip.id = 'av2-control-tooltip'; tip.role = 'tooltip'; tip.hidden = true;
  document.body.append(tip);
  let active = null, priorDescription = null, pending = null, hoverTimer = null;
  function hide() {
    clearTimeout(hoverTimer); hoverTimer = null; pending = null;
    if (active) {
      if (priorDescription) active.setAttribute('aria-describedby', priorDescription);
      else active.removeAttribute('aria-describedby');
    }
    active = null; tip.hidden = true;
  }
  function position() {
    if (!active?.isConnected || !active.getClientRects().length) { hide(); return; }
    const box = active.getBoundingClientRect(), size = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(box.left + (box.width - size.width) / 2, innerWidth - size.width - 8))}px`;
    tip.style.top = `${box.bottom + size.height + 8 < innerHeight ? box.bottom + 6 : Math.max(8, box.top - size.height - 6)}px`;
  }
  function show(control) {
    if (!control || control.matches(':disabled,[aria-expanded=true]')) return;
    if (active === control) return;
    hide(); active = control; priorDescription = control.getAttribute('aria-describedby');
    (control.closest('dialog[open]') || document.body).append(tip);
    tip.textContent = control.dataset.av2Tooltip;
    control.setAttribute('aria-describedby', [priorDescription, tip.id].filter(Boolean).join(' '));
    tip.hidden = false; position();
  }
  function register(root) {
    const selector = 'button[title],a[title],summary[title],button[aria-label],summary[aria-label]';
    const elements = [...(root.matches?.(selector) ? [root] : []), ...(root.querySelectorAll?.(selector) || [])];
    for (const el of elements) {
      if (el.matches('[data-av2-nav-toggle],.av2-filter-toggle,.av2-creation-close,.av2-creation-rewind')) continue;
      const label = el.title || (el.textContent.trim().length <= 1 ? el.getAttribute('aria-label') : '');
      if (!label) continue;
      el.dataset.av2Tooltip = label; el.removeAttribute('title');
    }
  }
  register(document.body);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') register(record.target);
      else record.addedNodes.forEach(node => { if (node.nodeType === 1 && node !== tip) register(node); });
    }
    const control = pending || active;
    if (control && (!control.isConnected || control.matches(':disabled,[aria-expanded=true]'))) hide();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'aria-label', 'disabled', 'aria-expanded'] });
  document.addEventListener('pointerover', e => {
    const control = e.target.closest?.('[data-av2-tooltip]');
    if (!control || control === active || control === pending || e.pointerType === 'touch') return;
    hide(); pending = control;
    hoverTimer = setTimeout(() => { if (pending === control && control.isConnected && control.matches(':hover')) show(control); }, 400);
  });
  document.addEventListener('pointerout', e => { const control = pending || active; if (control?.contains(e.target) && !control.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', e => show(e.target.closest?.('[data-av2-tooltip]')));
  document.addEventListener('focusout', e => { if (active?.contains(e.target)) hide(); });
  document.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
