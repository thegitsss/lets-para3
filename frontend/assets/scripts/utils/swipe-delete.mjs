// Mobile row presentation only. The caller keeps its existing deletion contract.
const controllers = new WeakMap();
let active = null, media, installed = false, sequence = 0;
const WIDTH = 80;
function install() {
  if (installed) return;
  installed = true;
  media = matchMedia('(max-width:700px), (pointer:coarse)');
  const style = document.createElement('link');
  style.rel = 'stylesheet'; style.href = new URL('../../styles/swipe-delete.css', import.meta.url).href;
  style.dataset.lpcSwipeStyles = ''; document.head.append(style);
  document.addEventListener('pointerdown', event => {
    if (active && !active.row.contains(event.target)) active.close(false);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); active.close(true); }
  }, true);
  document.addEventListener('focusin', event => {
    // WebKit may focus the scroll container when a pointer clicks its button.
    if (active && !active.row.contains(event.target) && !event.target.contains(active.row)) active.close(false);
  });
  const refresh = () => {
    active?.close(false);
    document.querySelectorAll('[data-lpc-swipe-delete]').forEach(row => controllers.get(row)?.sync());
  };
  media.addEventListener('change', refresh);
  window.addEventListener('resize', refresh);
  window.addEventListener('hashchange', () => active?.close(false));
  new MutationObserver(() => { if (active && !active.row.isConnected) active.close(false); })
    .observe(document.documentElement, { childList:true, subtree:true });
}

export function enableSwipeDelete(row, { label, onDelete, trigger = null, canDelete = () => true, preserveLabel = false } = {}) {
  install();
  const existing = controllers.get(row);
  if (existing) return existing;
  row.dataset.lpcSwipeDelete = '';
  row.classList.toggle('lpc-swipe-keep-label',preserveLabel);
  const rail = document.createElement('span'); rail.dataset.swipeUi = ''; rail.className = 'lpc-swipe-delete-rail';
  rail.id = `lpc-swipe-delete-${++sequence}`; rail.hidden = true;
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'lpc-swipe-delete-action';
  remove.setAttribute('aria-label', `Delete ${label}`);
  remove.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg><span>Delete</span>';
  rail.append(remove);
  const fallback = trigger || document.createElement('button');
  if (!trigger) { fallback.type = 'button'; fallback.textContent = `Show delete action for ${label}`; fallback.dataset.swipeUi = ''; row.append(fallback); }
  fallback.classList.add('lpc-swipe-delete-trigger');
  fallback.setAttribute('aria-controls', rail.id); fallback.setAttribute('aria-expanded', 'false');
  row.append(rail);
  let pointer = null, offset = 0, opened = false, suppressClick = false;
  const enabled = () => media.matches && canDelete();
  function paint(value) {
    offset = Math.max(0, Math.min(WIDTH, value));
    row.style.setProperty('--lpc-swipe-offset', `${-offset}px`);
    row.style.setProperty('--lpc-swipe-reveal', `${WIDTH-offset}px`);
  }
  function close(restore = false) {
    opened = false; pointer = null; paint(0); delete row.dataset.swipeDragging;
    delete row.dataset.swipeOpen; rail.hidden = true; fallback.setAttribute('aria-expanded', 'false');
    if (active === control) active = null;
    if (restore && fallback.isConnected) fallback.focus({ preventScroll:true });
  }
  function open(focus = false) {
    if (!enabled()) return;
    if (active && active !== control) active.close(false);
    row.classList.toggle('lpc-swipe-short',row.clientHeight<64);
    active = control; opened = true; rail.hidden = false; row.dataset.swipeOpen = '';
    fallback.setAttribute('aria-expanded', 'true'); paint(WIDTH);
    if (focus) remove.focus({ preventScroll:true });
  }
  const control = { row, open, close, sync() {
    row.classList.toggle('lpc-swipe-enabled', media.matches);
    if (!trigger) fallback.hidden = !media.matches;
    if (!media.matches) { close(false); fallback.removeAttribute('aria-controls'); fallback.removeAttribute('aria-expanded'); }
    else { fallback.setAttribute('aria-controls',rail.id); fallback.setAttribute('aria-expanded',String(opened)); }
  }};
  controllers.set(row, control); control.sync();
  fallback.addEventListener('click', event => {
    // Programmatic clicks still reach the caller's original handler.
    if (media.matches && (!trigger || event.isTrusted)) {
      event.preventDefault(); event.stopImmediatePropagation(); open(true);
    }
  }, true);
  remove.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (!enabled() || !opened || suppressClick) return;
    close(false); onDelete?.();
  });
  row.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (event.pointerType !== 'touch' || !enabled() || event.target.closest('[data-lpc-swipe-delete]') !== row) return;
    suppressClick = false;
    if (!event.isPrimary) { close(false); return; }
    if (event.target.closest('input,textarea,select,[contenteditable=true]')) return;
    const ui = event.target.closest('[data-swipe-ui]');
    if (ui && (!opened || !ui.classList.contains('lpc-swipe-delete-rail'))) return;
    pointer = { id:event.pointerId, x:event.clientX, y:event.clientY, initial:opened?WIDTH:0, locked:false };
  });
  row.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX-pointer.x, dy = event.clientY-pointer.y;
    if (!pointer.locked) {
      if (Math.abs(dy)>10 && Math.abs(dy)>Math.abs(dx)) { pointer=null; return; }
      if (Math.abs(dx)<10 || Math.abs(dx)<Math.abs(dy)*1.3 || (!opened && dx>0)) return;
      pointer.locked = true;
      if (active && active !== control) active.close(false);
      row.classList.toggle('lpc-swipe-short',row.clientHeight<64);
      active = control; rail.hidden = false; row.dataset.swipeDragging = '';
      try { if (event.isTrusted) row.setPointerCapture(event.pointerId); } catch { /* Synthetic/accessibility pointer without capture. */ }
    }
    if (event.cancelable) event.preventDefault();
    paint(pointer.initial-dx);
  }, { passive:false });
  function finish(event, cancelled = false) {
    if (!pointer || pointer.id !== event.pointerId) return;
    const moved = pointer.locked;
    pointer = null; delete row.dataset.swipeDragging;
    try { if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId); } catch {}
    if (!moved) return;
    suppressClick = true; setTimeout(() => { suppressClick=false; }, 400);
    if (cancelled || offset<WIDTH*.45) close(false); else open(false);
  }
  row.addEventListener('pointerup', event => finish(event));
  row.addEventListener('pointercancel', event => finish(event, true));
  row.addEventListener('click', event => {
    if (suppressClick && !event.target.closest('[data-swipe-ui]')) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressClick=false;
    } else if (opened && !event.target.closest('[data-swipe-ui]')) {
      event.preventDefault(); event.stopImmediatePropagation(); close(false);
    }
  }, true);
  return control;
}
