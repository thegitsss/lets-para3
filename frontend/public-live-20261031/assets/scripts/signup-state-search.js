/* Enhance the existing state selects; their option values remain authoritative. */
(() => {
  const enhanced = new WeakSet();
  const normalize = value => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

  function enhance(select) {
    if (enhanced.has(select)) return;
    enhanced.add(select);
    const states = [...select.options].filter(option => option.value).map(option => ({
      value: option.value, label: option.textContent.trim(),
    }));
    const wrapper = document.createElement('div');
    wrapper.className = 'signup-state-search';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `${select.id}Search`;
    input.className = 'select-field';
    input.placeholder = select.options[0].textContent;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-label', select.getAttribute('aria-label') || 'State');
    const list = document.createElement('div');
    list.id = `${select.id}Options`;
    list.className = 'signup-state-options';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', input.getAttribute('aria-label'));
    list.hidden = true;
    input.setAttribute('aria-controls', list.id);
    const status = document.createElement('span');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    select.before(wrapper);
    wrapper.append(select, input, status);
    document.body.append(list);
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.stateCombobox = { input };
    document.querySelector(`label[for="${select.id}"]`)?.setAttribute('for', input.id);
    let committed = select.value;
    let matches = states;
    let active = -1;

    const selectedLabel = () => states.find(state => state.value === select.value)?.label || '';
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function position() {
      if (list.hidden) return;
      const rect = input.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop || 0;
      const bottom = top + (viewport?.height || innerHeight);
      if (rect.bottom <= top || rect.top >= bottom || !input.getClientRects().length) {
        close();
        return;
      }
      const below = bottom - rect.bottom - 8;
      const above = rect.top - top - 8;
      const upwards = below < Math.min(list.scrollHeight, 220) && above > below;
      list.style.width = `${rect.width}px`;
      list.style.left = `${rect.left}px`;
      list.style.maxHeight = `${Math.max(0, Math.min(264, upwards ? above : below))}px`;
      list.style.top = `${upwards ? rect.top - 4 - list.getBoundingClientRect().height : rect.bottom + 4}px`;
    }
    function activate(index) {
      active = index;
      [...list.children].forEach((row, i) => row.classList.toggle('is-active', i === active));
      const row = list.children[active];
      if (row && matches.length) {
        input.setAttribute('aria-activedescendant', row.id);
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
        }
      } else input.removeAttribute('aria-activedescendant');
    }
    function render(query = '') {
      const needle = normalize(query);
      matches = states.filter(state => normalize(state.label).includes(needle) || state.value.toLowerCase().startsWith(needle));
      matches.sort((a, b) => Number(normalize(b.value) === needle) - Number(normalize(a.value) === needle));
      list.replaceChildren();
      for (const state of matches) {
        const row = document.createElement('div');
        row.id = `${list.id}-${state.value}`;
        row.className = 'signup-state-option';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(select.value === state.value));
        row.textContent = state.label;
        row.addEventListener('mousedown', event => event.preventDefault());
        row.addEventListener('click', () => choose(state));
        list.append(row);
      }
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'signup-state-empty';
        empty.setAttribute('role', 'option');
        empty.setAttribute('aria-disabled', 'true');
        empty.textContent = 'No matching states.';
        list.append(empty);
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      position();
      const selected = matches.findIndex(state => state.value === select.value);
      activate(matches.length ? Math.max(0, selected) : -1);
      status.textContent = matches.length ? `${matches.length} states available.` : 'No matching states.';
    }
    function notify() {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function choose(state) {
      select.value = state.value;
      committed = select.value;
      input.value = state.label;
      notify();
      close();
    }
    function sync() {
      input.disabled = select.disabled;
      input.setAttribute('aria-required', String(select.required));
      for (const attribute of ['aria-invalid', 'aria-describedby']) {
        if (select.hasAttribute(attribute)) input.setAttribute(attribute, select.getAttribute(attribute));
        else input.removeAttribute(attribute);
      }
      if (input.disabled) close();
    }
    input.value = selectedLabel();
    sync();
    input.addEventListener('focus', () => render(select.value ? '' : input.value));
    input.addEventListener('click', () => { if (list.hidden) render(select.value ? '' : input.value); });
    input.addEventListener('input', () => {
      select.value = '';
      notify();
      render(input.value);
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) render(select.value ? '' : input.value);
        else if (matches.length) activate((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      } else if (event.key === 'Enter' && !list.hidden) {
        event.preventDefault();
        event.stopPropagation();
        if (matches[active]) choose(matches[active]);
      } else if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        event.stopPropagation();
        select.value = committed;
        input.value = selectedLabel();
        notify();
        close();
      }
    });
    input.addEventListener('blur', () => {
      const needle = normalize(input.value);
      const exact = states.find(state => normalize(state.value) === needle || normalize(state.label) === needle);
      if (exact) choose(exact);
      close();
    });
    select.addEventListener('change', () => {
      if (select.value) {
        committed = select.value;
        input.value = selectedLabel();
      }
    });
    new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled', 'required', 'aria-invalid', 'aria-describedby'] });
    document.addEventListener('pointerdown', event => {
      if (!wrapper.contains(event.target) && !list.contains(event.target)) close();
    });
    window.addEventListener('resize', position);
    document.addEventListener('scroll', event => { if (!list.contains(event.target)) position(); }, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
  }
  const scan = () => document.querySelectorAll('select#signupState, select#barState').forEach(enhance);
  scan();
  new MutationObserver(scan).observe(document.getElementById('signupForm'), { childList: true, subtree: true });
})();
