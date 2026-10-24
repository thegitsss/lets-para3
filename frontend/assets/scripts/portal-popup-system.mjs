/* Presentation adapter for native LPC popups. Existing controls, form owners,
   listeners, focus handling, validation and network operations are untouched. */
// Crop framing owns its canvas geometry and compact Cancel/Done header.
const excluded = '.lpc-setup-dialog,.ri-dialog,.lpc-boot-screen,.av2-navigation-dialog,.v2-navigation-dialog,.v2-photo-crop-dialog,.v2-availability-dialog,.lpc-document-quick-look';
const layers = '.av2-creation-layer,.v2-onboarding-dialog';
const footers = 'footer,.av2-actions,.pv2-actions,.av2-delete-actions,.v2-settings-dialog-actions,.ph-dialog-footer,.lpc-dialog__actions,.lpc-invitation-dialog__actions,.lpc-engagement-dialog__actions,[class$="-dialog-actions"],[class$="-conflict-actions"]';
const primary = '.av2-button,.pv2-button,.v2-work-primary,.v2-settings-primary,.v2-browse-dialog-primary,.v2-matter-dialog-primary,.v2-profile-form-save,.lpc-dialog__button--primary,.ph-primary,[type="submit"],[class$="-primary"]';
const danger = '.av2-message-delete,[class*="danger"],[class*="--danger"]';
const set = (element, key, value = '') => { if (element && element.getAttribute(key) !== value) element.setAttribute(key, value); };
export function stylePortalPopup(dialog) {
  if (!(dialog instanceof HTMLDialogElement)) return;
  // An X has one visual treatment across ordinary, tour and résumé popups.
  dialog.querySelectorAll('button').forEach(button => {
    if (/^[×✕]$/.test(button.textContent.trim()) || button.matches('.av2-creation-close') || button.querySelector('.av2-close-glyph')) set(button, 'data-lpc-popup-x');
  });
  if (dialog.matches(excluded)) return;
  set(dialog, 'data-lpc-popup');
  if (dialog.matches(layers)) {
    set(dialog, 'data-lpc-popup-layer');
    dialog.querySelectorAll(primary).forEach(button => set(button, 'data-lpc-popup-action', button.matches(danger) ? 'danger' : 'primary'));
    return;
  }
  const card = dialog.querySelector(':scope > .lpc-dialog__card');
  if (card) set(card, 'data-lpc-popup-card');
  const titleId = dialog.getAttribute('aria-labelledby')?.split(/\s+/)[0];
  const title = (titleId && dialog.querySelector(`#${CSS.escape(titleId)}`)) || dialog.querySelector('h1,h2');
  if (title) {
    set(title, 'data-lpc-popup-title');
    const parent = title.closest('header') || title.parentElement;
    const row = parent !== dialog && parent !== card && parent.matches('header,[class$="-section-heading"],[class$="-card-heading"],[class$="-dialog-header"]');
    set(row ? parent : title, 'data-lpc-popup-header', row ? 'row' : 'title');
    if (row) parent.querySelectorAll('button').forEach(button => {
      if (button.matches('[class*="close"]') || /^[×✕]$/.test(button.textContent.trim()) || button.textContent.trim() === 'Close') set(button, 'data-lpc-popup-close', button.textContent.trim() === 'Close' ? 'text' : '');
      else if (button.matches('.v2-profile-form-cancel')) set(button, 'data-lpc-popup-action', 'secondary');
    });
  }
  dialog.querySelectorAll(':scope > [class$="-dialog-body"],:scope > form > [class$="-dialog-body"],:scope > .v2-browse-dialog-inner').forEach(body => set(body, 'data-lpc-popup-body'));
  const candidates = [...dialog.querySelectorAll(footers)].filter(node => !node.closest('[data-lpc-popup-header]') && !node.matches('.v2-photo-crop-footer') && !node.matches('nav'));
  const footer = candidates.at(-1);
  if (footer) {
    set(footer, 'data-lpc-popup-footer');
    footer.querySelectorAll('button').forEach(button => set(button, 'data-lpc-popup-action', button.matches(danger) || (dialog.dataset.tone === 'danger' && button.matches(primary)) ? 'danger' : button.matches(primary) ? 'primary' : 'secondary'));
  }
  // Photo crop saves live in the header; reveal buttons remain ordinary controls.
  dialog.querySelectorAll(primary).forEach(button => {
    if (!button.hasAttribute('data-lpc-popup-action')) set(button, 'data-lpc-popup-action', button.matches(danger) ? 'danger' : 'primary');
  });
  dialog.querySelectorAll('[class*="close"]').forEach(button => { if (button instanceof HTMLButtonElement) set(button, 'data-lpc-popup-close'); });
  const form = dialog.querySelector('input:not([type="hidden"]),textarea,select');
  const size = dialog.matches('.v2-work-confirm-dialog,.av2-message-delete-dialog,.av2-blocked-dialog,.pv2-blocked-dialog,.lpc-dialog,.v2-browse-confirmation') ? 'confirm' : dialog.matches('.v2-work-application-dialog,.v2-work-history-dialog') ? 'review' : form ? 'form' : 'review';
  set(dialog, 'data-lpc-popup-size', size);
  if (dialog.matches('.v2-availability-dialog')) set(dialog, 'data-lpc-popup-anchored');
}
function scan(root) {
  if (!(root instanceof Element)) return;
  const owner = root.closest('dialog');
  if (owner) stylePortalPopup(owner);
  root.querySelectorAll('dialog').forEach(stylePortalPopup);
}
if (document.body?.classList.contains('lpc-v2')) {
  // Programmatic focus can inherit :focus-visible on opening. Only the close
  // control uses input modality; its focus and keyboard behavior stay intact.
  document.addEventListener('keydown', event => {
    if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) document.body.setAttribute('data-lpc-popup-keyboard', '');
  }, true);
  document.addEventListener('pointerdown', () => document.body.removeAttribute('data-lpc-popup-keyboard'), true);
  scan(document.body);
  new MutationObserver(records => {
    const pending = new Set();
    for (const record of records) {
      if (record.type === 'attributes') pending.add(record.target);
      else { pending.add(record.target); record.addedNodes.forEach(node => { if (node instanceof Element) pending.add(node); }); }
    }
    pending.forEach(scan);
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
}
