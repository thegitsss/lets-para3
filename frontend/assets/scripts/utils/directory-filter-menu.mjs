const make = (tag, attrs = {}, children = []) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') element.textContent = value;
    else if (key === 'className') element.className = value;
    else element.setAttribute(key, value);
  }
  element.append(...children);
  return element;
};

const menuIcon = pathData => {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('aria-hidden', 'true');
  icon.classList.add('ldf-row-icon');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', pathData); icon.append(path); return icon;
};

export function fitDirectoryPopover(menu, trigger) {
  if (!menu || !trigger || menu.hidden) return;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
  const header = document.querySelector('[data-public-header], .av2-header');
  const h = header?.getBoundingClientRect();
  const headerBottom = h?.height && (['fixed', 'sticky'].includes(getComputedStyle(header).position) || header.matches('.av2-header')) && h.top <= top + 12 ? h.bottom : top;
  const minimumTop = Math.max(top, headerBottom) + 12, bottom = top + height - 12;
  Object.assign(menu.style, { position: 'fixed', right: 'auto', bottom: 'auto', maxWidth: `${Math.max(1, width - 24)}px`, maxHeight: `${Math.max(1, bottom - minimumTop)}px` });
  const bounds = menu.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(left + 12, Math.min(anchor.right - bounds.width, left + width - bounds.width - 12))}px`;
  const below = anchor.bottom + 8, above = anchor.top - 8 - bounds.height;
  const menuTop = below + bounds.height <= bottom ? below : above >= minimumTop ? above : bottom - bounds.height;
  menu.style.top = `${Math.max(minimumTop, Math.min(menuTop, bottom - bounds.height))}px`;
}

export function createDirectoryFilterMenu({ states, specialties, value = {}, onChange, onClose, onResize = () => {} }) {
  const selected = { location: new Set(value.location || []), practice: new Set(value.practice || []), minYears: String(value.minYears || '') };
  const instance = String(createDirectoryFilterMenu.nextId = (createDirectoryFilterMenu.nextId || 0) + 1);
  const element = make('section', { className: 'lpc-directory-filter-menu', 'aria-label': 'Filter paralegals' });
  const clear = make('button', { type: 'button', className: 'ldf-clear', text: 'Reset', 'aria-label': 'Clear all filters' });
  const done = make('button', { type: 'button', className: 'ldf-done', text: 'Done', 'data-filter-close': '' });
  const body = make('div', { className: 'ldf-body' });
  element.append(body, make('footer', { className: 'ldf-header' }, [clear, done]));
  element.addEventListener('click', event => event.stopPropagation());
  const snapshot = () => ({ location: [...selected.location], practice: [...selected.practice], minYears: selected.minYears });
  const count = () => selected.location.size + selected.practice.size + (selected.minYears ? 1 : 0);
  const groups = new Map();
  function sync() {
    clear.disabled = !count();
    for (const [key, group] of groups) {
      const amount = selected[key].size;
      group.amount.textContent = amount === 1 ? [...selected[key]][0] : amount ? `${amount} selected` : key === 'practice' ? 'Any specialty' : 'Any state';
      group.toggle.title = amount ? [...selected[key]].join(', ') : group.amount.textContent;
      group.toggle.setAttribute('aria-label', `${group.label}${amount ? `, ${amount} selected` : ''}`);
    }
  }
  function notify() { sync(); onChange(snapshot()); onResize(); }
  function setExpanded(group, open) {
    group.panel.hidden = !open;
    group.toggle.setAttribute('aria-expanded', String(open));
    group.section.classList.toggle('is-expanded', open);
    onResize();
  }
  function renderChoices(key) {
    const group = groups.get(key), choices = key === 'location' ? states : specialties;
    const all = [...new Set([...choices, ...selected[key]])];
    const query = group.search.value.toLocaleLowerCase();
    const matches = all.filter(text => text.toLocaleLowerCase().includes(query));
    group.list.replaceChildren(...matches.map(text => {
      const input = make('input', { type: 'checkbox', value: text, 'data-filter-choice': key });
      input.checked = selected[key].has(text);
      input.addEventListener('change', () => {
        if (input.checked) selected[key].add(text); else selected[key].delete(text);
        notify();
      });
      return make('label', { className: 'ldf-choice' }, [input, make('span', { text })]);
    }));
    if (!matches.length) group.list.append(make('p', { className: 'ldf-empty', role: 'status', text: 'No matching choices.' }));
    onResize();
  }
  function category(key, label) {
    const section = make('section', { className: 'ldf-filter-section' });
    const panel = make('div', { className: 'ldf-filter-values', id: `directory-${instance}-${key}` });
    const amount = make('span', { className: 'ldf-group-count' });
    const toggle = make('button', { type: 'button', className: 'ldf-category', 'data-directory-category': key, 'aria-label': label, 'aria-controls': panel.id, 'aria-expanded': 'false' }, [amount, make('span', { className: 'ldf-chevron', 'aria-hidden': 'true' })]);
    const search = make('input', { type: 'search', className: 'ldf-search', 'aria-label': `Search ${key === 'location' ? 'states' : 'specialties'}`, placeholder: key === 'location' ? 'Find a state…' : 'Find a specialty…', autocomplete: 'off' });
    const list = make('div', { className: 'ldf-options', role: 'group', 'aria-label': `${label} choices` });
    const group = { section, panel, toggle, amount, search, list, label };
    groups.set(key, group);
    const icon = menuIcon(key === 'practice' ? 'M7 5V3h6v2M3 5h14v11H3ZM3 9l7 3 7-3M8 11v2h4v-2' : 'M15.5 8c0 4-5.5 9-5.5 9S4.5 12 4.5 8a5.5 5.5 0 0 1 11 0ZM12 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z');
    section.append(make('div', { className: 'ldf-section-heading' }, [make('span', { className: 'ldf-field-label' }, [icon, make('span', { text: label })]), toggle]), panel);
    panel.append(make('div', { className: 'ldf-search-row' }, [menuIcon('M12.5 12.5 17 17M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z'), search]), list);
    toggle.addEventListener('click', () => setExpanded(group, panel.hidden));
    search.addEventListener('input', () => renderChoices(key));
    search.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('input')?.focus(); } });
    list.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const inputs = [...list.querySelectorAll('input')], index = inputs.indexOf(document.activeElement);
      if (!inputs.length) return;
      event.preventDefault();
      inputs[event.key === 'Home' ? 0 : event.key === 'End' ? inputs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + inputs.length) % inputs.length].focus();
    });
    section.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden && panel.contains(event.target)) {
        event.preventDefault(); event.stopPropagation(); setExpanded(group, false); toggle.focus();
      }
    });
    renderChoices(key); return section;
  }
  body.append(category('practice', 'Specialty'), category('location', 'State'));
  const years = make('select', { className: 'ldf-filled-select', 'aria-label': 'Minimum experience' });
  const thresholds = [...new Set(['', '1', '3', '5', '10', selected.minYears])].sort((a,b) => Number(a) - Number(b));
  thresholds.forEach(value => years.append(make('option', { value, text: value ? `${value}+ years` : 'Any experience' })));
  years.value = selected.minYears;
  years.addEventListener('change', () => { selected.minYears = years.value; notify(); });
  body.append(make('div', { className: 'ldf-experience' }, [make('label', { className: 'ldf-control-row' }, [make('span', { className: 'ldf-field-label' }, [menuIcon('M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM10 6v4l3 2'), make('span', { text: 'Experience' })]), years])]));
  const resetView = () => {
    for (const [key, group] of groups) {
      group.search.value = ''; setExpanded(group, false); renderChoices(key);
    }
    years.value = selected.minYears; sync();
  };
  clear.addEventListener('click', () => {
    selected.location.clear(); selected.practice.clear(); selected.minYears = '';
    resetView(); notify();
  });
  done.addEventListener('click', onClose);
  resetView();
  return { element, value: snapshot, count, resetView, setValue(value) {
    selected.location = new Set(value.location || []); selected.practice = new Set(value.practice || []); selected.minYears = String(value.minYears || '');
    if (![...years.options].some(option => option.value === selected.minYears)) years.append(make('option', { value: selected.minYears, text: `${selected.minYears}+ years` }));
    resetView();
  } };
}

export function createDirectoryOrderingMenu({ value = 'alpha', onChange }) {
  const element = make('section', { className: 'lpc-directory-sort-menu', role: 'dialog', 'aria-label': 'Sort paralegals', hidden: '' });
  const select = make('select', { className: 'ldf-filled-select', 'aria-label': 'Order paralegals' }, [make('option', { value: 'alpha', text: 'Name A–Z' }), make('option', { value: 'experience', text: 'Most experience' })]);
  select.value = value;
  const label = make('label', { className: 'ldf-control-row ldf-ordering-row' }, [make('span', { className: 'ldf-control-label' }, [menuIcon('M6 3v14m-3-3 3 3 3-3M14 17V3m-3 3 3-3 3 3'), make('span', { text: 'Ordering' })]), select]);
  element.append(label);
  select.addEventListener('change', () => onChange(select.value));
  return { element, select };
}

export function renderDirectoryFilterChips(target, value, onChange, fallback) {
  const entries = [...value.practice.map(v => ['practice', v, `Specialty: ${v}`]), ...value.location.map(v => ['location', v, `State: ${v}`]), ...(value.minYears ? [['minYears', value.minYears, `Experience: ${value.minYears}+ years`]] : [])];
  target.hidden = !entries.length;
  target.replaceChildren(...entries.map(([key, val, label], index) => {
    const button = make('button', { type: 'button', className: 'ldf-chip', 'aria-label': `Remove ${label}` }, [make('span', { text: label }), make('span', { text: '×', 'aria-hidden': 'true' })]);
    button.addEventListener('click', () => { const next = { ...value, [key]: key === 'minYears' ? '' : value[key].filter(item => item !== val) }; onChange(next); (target.querySelectorAll('button')[Math.max(0, index - 1)] || fallback)?.focus(); });
    return button;
  }));
}

export function createDirectorySortControl({ value = 'alpha', onChange, signal }) {
  const control = make('div', { className: 'lpc-directory-sort-control' });
  const label = key => `Sort paralegals: ${key === 'experience' ? 'Most experience' : 'Name A–Z'}`;
  const trigger = make('button', { type: 'button', className: 'lpc-directory-icon', 'aria-label': label(value), 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: label(value) });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d','M7 3v18m-4-4 4 4 4-4M17 21V3m-4 4 4-4 4 4'); svg.append(path); trigger.append(svg);
  const close = (restoreFocus = false) => { menu.hidden = true; trigger.setAttribute('aria-expanded','false'); if (restoreFocus) trigger.focus(); };
  const ordering = createDirectoryOrderingMenu({ value, onChange: key => { trigger.setAttribute('aria-label',label(key)); trigger.title=label(key); close(true); onChange(key); } });
  const menu = ordering.element;
  const fit = () => fitDirectoryPopover(menu, trigger);
  const open = () => { menu.hidden=false; trigger.setAttribute('aria-expanded','true'); fit(); ordering.select.focus(); };
  trigger.addEventListener('click', () => menu.hidden ? open() : close());
  trigger.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } });
  menu.addEventListener('keydown', event => { if (event.key==='Escape') { event.preventDefault(); close(true); } });
  document.addEventListener('click', event => { if (!control.contains(event.target) && !menu.contains(event.target)) close(); }, {signal});
  window.addEventListener('resize',fit,{signal}); window.addEventListener('scroll',fit,{signal,passive:true}); window.visualViewport?.addEventListener('resize',fit,{signal});
  control.append(trigger); document.body.append(menu);
  signal?.addEventListener('abort',()=>menu.remove(),{once:true});
  return control;
}
