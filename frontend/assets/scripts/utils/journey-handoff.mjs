const kinds = new Set(['action', 'waiting', 'information', 'unavailable']);
const owners = new Set(['you', 'attorney', 'paralegal', 'lpc', 'none', 'unknown']);
const copy = value => typeof value === 'string' && value.length <= 700 ? value : '';

// A server-projected explanation, never a new permission or lifecycle decision.
export function createJourneyHandoff(value, { currentTab, hrefForTab, onAsk, sections = [] } = {}) {
  if (!value || !kinds.has(value.kind) || !owners.has(value.responsible) || !copy(value.title) || !copy(value.detail)) return null;
  const root = document.createElement('section');
  root.className = 'lpc-journey-handoff'; root.setAttribute('aria-label', 'What happens next');
  root.dataset.journeyKind = value.kind;
  const owner = document.createElement('p'); owner.className = 'lpc-journey-owner';
  owner.textContent = ({ you: 'Your next step', attorney: 'With the attorney', paralegal: 'With the paralegal', lpc: 'With LPC', none: 'Current record', unknown: 'Status to review' })[value.responsible];
  const title = document.createElement('h2'); title.textContent = value.title;
  const detail = document.createElement('p'); detail.textContent = value.detail;
  root.append(owner, title, detail);
  const actions = document.createElement('div'); actions.className = 'lpc-journey-actions';
  if (value.action && sections.includes(value.action.tab) && value.action.tab !== currentTab && copy(value.action.label)) {
    const href = hrefForTab?.(value.action.tab);
    if (typeof href === 'string' && (href.startsWith('#/') || href.startsWith('paralegal-v2.html#/'))) {
      const link = document.createElement('a'); link.href = href; link.textContent = value.action.label; actions.append(link);
    }
  }
  if (onAsk) {
    const ask = document.createElement('button'); ask.type = 'button'; ask.textContent = 'Ask Assistant about this step';
    ask.addEventListener('click', () => {
      Promise.resolve().then(() => onAsk({ launcher: ask, promptText: 'Explain the current next step for this Matter, who is responsible, and what is still unconfirmed. Use the current saved records.', submitPrompt: false, preserveDraft: true })).catch(() => {
        if (!root.isConnected) return;
        let feedback = root.querySelector('[data-journey-assistant-error]');
        if (!feedback) { feedback = document.createElement('p'); feedback.dataset.journeyAssistantError = ''; feedback.setAttribute('role', 'status'); root.append(feedback); }
        feedback.textContent = 'Assistant could not open. You can still use the Matter links above or try again.';
      });
    });
    actions.append(ask);
  }
  if (actions.childElementCount) root.append(actions);
  return root;
}
