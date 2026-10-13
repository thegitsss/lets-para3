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
  buttons.forEach(button => button.addEventListener('click', () => {
    const example = examples[button.dataset.assistantExample];
    if (!example) return;
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    fields.forEach((field, index) => { section.querySelector(`[data-demo-${field}]`).textContent = example[index]; });
  }));
})();
