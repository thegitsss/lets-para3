(() => {
  const input = document.querySelector('#builder-date');
  if (!input || typeof HTMLDialogElement === 'undefined') return;
  const format = value => new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'draft-date-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'draft-calendar');
  trigger.innerHTML = '<span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v5M17 3v5M3 11h18M7 15h3M14 15h3"/></svg>';
  input.after(trigger);
  input.hidden = true;
  const label = document.querySelector('label[for="builder-date"]');
  trigger.id = 'draft-date-trigger';
  if (label) label.htmlFor = trigger.id;
  const dialog = document.createElement('dialog');
  dialog.id = 'draft-calendar';
  dialog.className = 'draft-calendar';
  dialog.setAttribute('aria-labelledby', 'draft-calendar-title');
  dialog.innerHTML = '<header><div><p>SUGGESTED DUE DATE</p><h2 id="draft-calendar-title">June</h2></div><button type="button" class="draft-calendar-close" aria-label="Close calendar">×</button></header><div class="draft-calendar-week" aria-hidden="true"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div><div class="draft-calendar-days" role="group" aria-label="Choose a June date"></div><footer>Choose June 6–27 for this example.</footer>';
  document.body.append(dialog);
  const grid = dialog.querySelector('.draft-calendar-days');
  grid.append(document.createElement('span'));
  for (let day = 1; day <= 30; day++) {
    const button = document.createElement('button');
    const value = `2026-06-${String(day).padStart(2, '0')}`;
    button.type = 'button';
    button.textContent = day;
    button.dataset.date = value;
    button.disabled = value < input.min || value > input.max;
    button.setAttribute('aria-label', format(value));
    button.addEventListener('click', () => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      sync();
      dialog.close();
    });
    grid.append(button);
  }
  function sync() {
    trigger.querySelector('span').textContent = format(input.value);
    trigger.setAttribute('aria-label', `Suggested due date: ${format(input.value)}. Change date`);
    grid.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.date === input.value)));
  }
  trigger.addEventListener('click', () => {
    sync(); dialog.showModal(); trigger.setAttribute('aria-expanded', 'true');
    grid.querySelector('[aria-pressed="true"]')?.focus();
  });
  dialog.querySelector('.draft-calendar-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus({ preventScroll: true }); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
  grid.addEventListener('keydown', event => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!step || !event.target.dataset.date) return;
    event.preventDefault();
    const day = Number(event.target.textContent) + step;
    const next = grid.querySelector(`[data-date="2026-06-${String(day).padStart(2, '0')}"]`);
    if (next && !next.disabled) next.focus();
  });
  input.addEventListener('input', sync);
  sync();
})();
