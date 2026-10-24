(() => {
  let pinned = false;
  const button = () => document.querySelector('.signup-bar-info');
  function show(open) {
    const trigger = button(), tip = document.getElementById('barNumberHelp');
    if (!trigger || !tip) return;
    trigger.setAttribute('aria-expanded', String(open));
    tip.hidden = !open;
  }
  document.addEventListener('pointerover', e => {
    if (e.pointerType !== 'touch' && e.target.closest('.signup-bar-info, .signup-bar-tooltip')) show(true);
  });
  document.addEventListener('pointerout', e => {
    if (e.target.closest('.signup-bar-info, .signup-bar-tooltip') && !e.relatedTarget?.closest?.('.signup-bar-info, .signup-bar-tooltip') && !pinned && document.activeElement !== button()) show(false);
  });
  document.addEventListener('focusin', e => { if (e.target.matches('.signup-bar-info')) show(true); });
  document.addEventListener('focusout', e => { if (e.target.matches('.signup-bar-info') && !pinned) show(false); });
  document.addEventListener('click', e => {
    if (e.target.closest('.signup-bar-info')) { pinned = !pinned; show(pinned); }
    else if (!e.target.closest('.signup-bar-tooltip')) { pinned = false; show(false); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { pinned = false; show(false); } });
})();
