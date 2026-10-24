export function createAppliedFilters(fields, onChange) {
  const element = document.createElement('div');
  element.className = 'lpc-applied-filters';
  element.setAttribute('aria-label', 'Applied filters');
  function sync() {
    const focused = element.contains(document.activeElement) ? document.activeElement.dataset.filterKey : null;
    element.replaceChildren();
    const active = fields.filter(({control, defaultValue}) => control.value !== defaultValue);
    element.hidden = !active.length;
    for (const {control, defaultValue, label, key} of active) {
      const value = control.selectedOptions?.[0]?.textContent || control.value;
      const remove = document.createElement('button'); remove.type = 'button';
      remove.className = 'lpc-filter-chip'; remove.dataset.filterKey = key;
      remove.setAttribute('aria-label', `Remove ${label}: ${value}`);
      remove.textContent = `${value} ×`;
      remove.addEventListener('click', () => { control.value = defaultValue; control.dispatchEvent(new Event('lpc-select-sync')); onChange(); sync(); });
      element.append(remove);
    }
    if (active.length) {
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'lpc-filter-reset'; clear.dataset.filterKey = 'clear'; clear.textContent = 'Clear filters';
      clear.addEventListener('click', () => { fields.forEach(({control, defaultValue}) => { control.value = defaultValue; control.dispatchEvent(new Event('lpc-select-sync')); }); onChange(); sync(); });
      element.append(clear);
    }
    if (focused) (element.querySelector(`[data-filter-key="${focused}"]`) || element.querySelector('button'))?.focus({preventScroll:true});
  }
  fields.forEach(({control}) => control.addEventListener('change', sync));
  sync(); return {element, sync};
}
