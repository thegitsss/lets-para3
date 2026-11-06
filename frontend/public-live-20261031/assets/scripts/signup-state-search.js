/* Keep the original select values and styling, with native typing suggestions. */
(() => {
  const enhanced = new WeakSet();
  const normalize = value => value.trim().toLowerCase();

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
    input.className = select.className;
    input.placeholder = select.options[0].textContent;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', select.getAttribute('aria-label') || 'State');
    const suggestions = document.createElement('datalist');
    suggestions.id = `${select.id}Options`;
    for (const state of states) {
      const option = document.createElement('option');
      option.value = state.label;
      option.label = state.value;
      suggestions.append(option);
    }
    input.setAttribute('list', suggestions.id);
    select.before(wrapper);
    wrapper.append(select, input, suggestions);
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.stateCombobox = { input };
    document.querySelector(`label[for="${select.id}"]`)?.setAttribute('for', input.id);
    let notifying = false;
    let committed = select.value;
    const selectedLabel = () => states.find(state => state.value === select.value)?.label || '';
    const match = () => states.find(state => [state.value, state.label].some(value => normalize(value) === normalize(input.value)));

    function notify() {
      notifying = true;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      notifying = false;
    }
    function sync() {
      input.disabled = select.disabled;
      input.setAttribute('aria-required', String(select.required));
      for (const attribute of ['aria-invalid', 'aria-describedby']) {
        if (select.hasAttribute(attribute)) input.setAttribute(attribute, select.getAttribute(attribute));
        else input.removeAttribute(attribute);
      }
    }
    function commit() {
      const state = match();
      select.value = state?.value || '';
      if (state) {
        committed = state.value;
        input.value = state.label;
      }
      notify();
    }
    input.value = selectedLabel();
    sync();
    input.addEventListener('click', () => {
      try { input.showPicker?.(); } catch { /* Native keyboard suggestions remain available. */ }
    });
    input.addEventListener('input', () => {
      select.value = match()?.value || '';
      notify();
    });
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing) return;
      select.value = committed;
      input.value = selectedLabel();
      notify();
    });
    select.addEventListener('change', () => {
      if (notifying) return;
      committed = select.value;
      input.value = selectedLabel();
    });
    new MutationObserver(sync).observe(select, {
      attributes: true, attributeFilter: ['disabled', 'required', 'aria-invalid', 'aria-describedby'],
    });
  }
  const scan = () => document.querySelectorAll('select#signupState, select#barState').forEach(enhance);
  scan();
  new MutationObserver(scan).observe(document.getElementById('signupForm'), { childList: true, subtree: true });
})();
