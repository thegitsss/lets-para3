(() => {
  const section = document.querySelector('.assistant-spotlight');
  if (!section) return;
  const examples = {
    deadlines: ['What’s my next deadline?', 'Your next deadline is August 23 for Henderson v. Walker.', 'Next deadline', 'August 23', 'Henderson v. Walker', 'Henderson v. Walker'],
    people: ['Who’s assigned to Henderson v. Walker?', 'Alexandra Reed is the paralegal assigned to Henderson v. Walker.', 'Assigned paralegal', 'Alexandra Reed', 'Henderson v. Walker', 'Henderson v. Walker'],
    review: ['Which matter has deliverables to review?', 'The paralegal submitted work for Northstar Ventures. Review the deliverables or request revisions.', 'Next step', 'Review deliverables', 'Northstar Ventures', 'Northstar Ventures'],
  };
  const fields = ['question', 'answer', 'fact-label', 'fact', 'detail', 'matter'];
  const buttons = [...section.querySelectorAll('[data-assistant-example]')];
  const card = section.querySelector('.assistant-demo');
  const mobile = matchMedia('(max-width: 767px)');
  // Reserve the tallest complete answer card, including its source and composer.
  // Measure a hidden copy so live answer text and announcements are untouched.
  function sizeMobileCards() {
    if (!mobile.matches) { card.style.removeProperty('--assistant-mobile-card-height'); return; }
    const copy = card.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    copy.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;inset:0 auto auto 0;width:${getComputedStyle(card).width};min-height:0;transform:none;`;
    card.after(copy);
    let tallest = 0;
    for (const example of Object.values(examples)) {
      fields.forEach((field, index) => { copy.querySelector(`[data-demo-${field}]`).textContent = example[index]; });
      tallest = Math.max(tallest, copy.getBoundingClientRect().height);
    }
    copy.remove();
    card.style.setProperty('--assistant-mobile-card-height', `${Math.ceil(tallest)}px`);
  }
  sizeMobileCards();
  const scheduleSizing = () => requestAnimationFrame(sizeMobileCards);
  document.fonts.ready.then(scheduleSizing);
  document.fonts.addEventListener('loadingdone', scheduleSizing);
  mobile.addEventListener('change', sizeMobileCards);
  // Accessibility mode changes inherited typography without changing card width.
  new MutationObserver(sizeMobileCards).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  let cardWidth = card.getBoundingClientRect().width;
  new ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    if (Math.abs(width - cardWidth) < .5) return;
    cardWidth = width;
    sizeMobileCards();
  }).observe(card);

  buttons.forEach(button => button.addEventListener('click', () => {
    const example = examples[button.dataset.assistantExample];
    if (!example) return;
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    fields.forEach((field, index) => { section.querySelector(`[data-demo-${field}]`).textContent = example[index]; });
    sizeMobileCards();
  }));
})();
