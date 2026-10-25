// Mirror page-level return actions into one persistent header location.
// The original action remains the owner of its route, filters, and local state.
export function installHeaderBack(outlet, { headerSelector = '.v2-header', toolsSelector = '.v2-header-tools' } = {}) {
  const header = document.querySelector(headerSelector);
  if (!header || !outlet) return;
  const slot = document.createElement('nav');
  slot.className = 'v2-header-back';
  slot.setAttribute('aria-label', 'Return navigation');
  slot.hidden = true;
  header.insertBefore(slot, header.querySelector(toolsSelector));
  let source = null, label = '';
  function sync() {
    const candidates = [...outlet.querySelectorAll('a,button')].filter(item => {
      if (item.closest('dialog,[hidden]')) return false;
      const name = item.getAttribute('aria-label') || item.textContent.trim();
      return /^←?\s*(?:Back(?:\s|$)|Return to\s)/i.test(name);
    });
    // A selected record's return action takes priority over the page's origin.
    const next = candidates.find(item => item.matches('[data-ld-tool="back"],.lc-back,.lc-updates-back,.v2-browse-back'))
      || candidates.find(item => item.matches('[data-v2-context-back]'))
      || candidates.find(item => !item.matches('.lpc-workspace-back')) || candidates[0];
    candidates.forEach(item => item.setAttribute('data-v2-header-return-source', ''));
    const name = next ? (next.getAttribute('aria-label') || next.textContent.trim()).replace(/^←\s*/, '').replace(/^Return to /i, 'Back to ') : '';
    if (source === next && label === name) return;
    const hadFocus = slot.contains(document.activeElement);
    source = next; label = name; slot.replaceChildren(); slot.hidden = !source;
    if (!source) return;
    const action = document.createElement(source.tagName === 'A' ? 'a' : 'button');
    if (source.tagName === 'A') action.href = source.href;
    else action.type = 'button';
    action.className = 'v2-header-back-action';
    action.setAttribute('aria-label', label); action.title = label;
    const arrow = document.createElement('span'); arrow.textContent = '←'; arrow.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'v2-header-back-label'; text.textContent = label;
    action.append(arrow, text);
    action.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); source?.click();
    });
    slot.append(action);
    if (hadFocus) action.focus({ preventScroll: true });
  }
  new MutationObserver(sync).observe(outlet, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden','aria-label'] });
  sync();
}
