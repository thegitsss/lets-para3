// A row's empty space activates its existing primary control. Native controls
// keep their own keyboard targets, navigation, confirmations and save handlers.
const EXPLICIT_ROWS = '.v2-settings-preference-row,.av2-account-preference,.pv2-security-row,.av2-security-row,.pv2-security-password-section,.av2-security-password-section,.v2-settings-card-actions,.av2-account-actions,.pv2-blocked-row,.av2-blocked-row,.v2-settings-document-row,.av2-account-document,.lpc-profile-single,[data-lpc-action-row]';
const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="switch"],[role="checkbox"],[contenteditable]:not([contenteditable="false"])';
const CONTROLS = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="switch"],[role="checkbox"]';
const PRIMARY_RULES = [
  ['.v2-settings-document-row', '.v2-profile-document-primary'],
  ['.v2-notification', '.v2-notification-body'],
  ['.av2-matter-row', '.av2-matter-title-link'],
  ['.v2-work-record', '.v2-work-record-main h3 :is(a,button)'],
  ['.av2-task-row', ':scope > details > summary'],
  ['.v2-matter-file', '[data-v2-file-preview],[data-v2-file-download],[data-v2-file-security]'],
  ['.v2-browse-card', 'h2 a,h3 a,h2 button,h3 button'],
];
const visible = control => !control.closest('[hidden],[inert]') && control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden';
const enabled = control => !control.disabled && control.getAttribute('aria-disabled') !== 'true';
function isRow(element) {
  if (element.matches(EXPLICIT_ROWS)) return true;
  if (element.matches('tr,li,article,header,[role="row"],[role="listitem"]')) return true;
  const classes=[...element.classList];
  if (classes.some(name => /(?:^|[-_])(row|item|record)(?:$|[-_])/.test(name)
    && !/(?:^|[-_])(heading|header|toolbar|composer|actions|container|list|grid|body|copy|meta|tools)(?:$|[-_])/.test(name))) return true;
  // Cover ordinary horizontal control rows even when a page uses a custom name.
  if (classes.some(name=>/(?:^|[-_])(toolbar|composer|actions|list|grid|tools)(?:$|[-_])/.test(name))) return false;
  if (element.children.length<2 || !element.querySelector(CONTROLS)) return false;
  const style=getComputedStyle(element),box=element.getBoundingClientRect();
  const horizontalFlex=style.display==='flex' && style.flexDirection==='row';
  const horizontalGrid=style.display==='grid' && style.gridTemplateColumns.split(' ').length>1;
  return (horizontalFlex||horizontalGrid) && box.width>=160 && box.height<=180 && box.width>box.height;
}
function primaryAction(row) {
  // While editing or confirming, only the actual controls act on the draft.
  if (row.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea') &&
      [...row.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea')].some(visible)) return null;
  const controls = [...row.querySelectorAll(CONTROLS)].filter(visible);
  if (!controls.length) return null;
  for (const [selector, primary] of PRIMARY_RULES) {
    if (!row.matches(selector)) continue;
    const target = row.querySelector(primary);
    return target && visible(target) && enabled(target) ? target : null;
  }
  if (controls.length === 1) {
    const control=controls[0];
    const caption=(control.getAttribute('aria-label') || control.textContent || '').trim();
    if (!row.matches(EXPLICIT_ROWS) && /^(remove|delete|dismiss|decline|cancel|withdraw|close)\b/i.test(caption)) return null;
    return enabled(control) ? control : null;
  }
  // A named title is the main destination; trailing menus remain independent.
  const titles = controls.filter(control => control.matches('a,button') && control.closest('h2,h3,h4') && !control.closest('details,form'));
  if (titles.length === 1) return enabled(titles[0]) ? titles[0] : null;
  const links = controls.filter(control => control.matches('a[href]'));
  if (links.length && links.length === controls.length && links.every(link => link.href === links[0].href)) return links.find(enabled) || null;
  return null;
}
export function installRowActions(root) {
  if (!root || root.dataset.lpcRowActions === 'true') return;
  root.dataset.lpcRowActions = 'true';
  const rowFor = target => {
    if (!(target instanceof Element)) return null;
    for (let row = target; row && row !== root; row = row.parentElement) {
      if (row.matches('[data-lpc-row-static],form,nav,main,aside,[role="banner"],.v2-header,.av2-header')) break;
      if (isRow(row)) return root.contains(row) ? row : null;
    }
    return null;
  };
  root.addEventListener('pointerover', event => {
    const row = rowFor(event.target);
    if (row) row.toggleAttribute('data-lpc-row-clickable', Boolean(primaryAction(row)));
  });
  root.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element) || event.target.closest(INTERACTIVE)) return;
    if (String(window.getSelection() || '').trim()) return;
    const row = rowFor(event.target), control = row && primaryAction(row);
    if (!control) return;
    event.preventDefault();
    control.focus({ preventScroll: true });
    if (control.matches('select')) {
      try { control.showPicker?.(); } catch { /* Native keyboard selection remains available. */ }
    } else if (!control.matches('input[type="range"],textarea,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])')) {
      control.click();
    }
  });
}
