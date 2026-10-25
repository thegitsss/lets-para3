// Presentation helpers only: callers retain native controls and their handlers.
const paths = Object.freeze({
  sort: 'M3 3h10M3 8h7M3 13h4',
  filter: 'M2 5h3m4 0h5M2 11h7m4 0h1M9 5a2 2 0 1 1-4 0a2 2 0 1 1 4 0M13 11a2 2 0 1 1-4 0a2 2 0 1 1 4 0',
  chevron: 'm6 4 4 4-4 4',
  down: 'm4 6 4 4 4-4',
  more: 'M3 8h.01M8 8h.01M13 8h.01',
});

export function portalIcon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `portal-icon ${className}`.trim() })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name] || paths.chevron);
  svg.append(path);
  return svg;
}

export function nativeSelectControl(select, { toolbar = false, iconOnly = false } = {}) {
  const wrapper = document.createElement('span');
  wrapper.className = `portal-native-select${toolbar ? ' portal-toolbar-select' : ''}`;
  if (iconOnly) {
    wrapper.classList.add('portal-icon-select');
    const label = select.getAttribute('aria-label') || 'Sort';
    const describe = () => { select.title = `${label}: ${select.selectedOptions[0]?.textContent || ''}`; wrapper.title = select.title; };
    select.addEventListener('change', describe); describe();
    wrapper.append(select, portalIcon('sort'));
  } else wrapper.append(select, portalIcon('down'));
  return wrapper;
}
