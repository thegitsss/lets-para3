import { createNotificationCenter } from './notification-center.mjs';

// Shared presentation; transports and destination authorization stay role-owned.
export function createUpdatesFeed({ api, identity, destinationFor, navigate, signal, showToast, role }) {
  const make = (tag, className = '', text = '') => { const el = document.createElement(tag); if (className) el.className = className; if (text) el.textContent = text; return el; };
  const page = make('section', 'lpc-updates-page'); page.setAttribute('aria-labelledby', 'lpc-updates-title');
  const back = make('a', 'lpc-updates-back', '← Back to Home'); back.href = '#/home';
  const title = make('h1', '', 'Updates'); title.id = 'lpc-updates-title'; title.tabIndex = -1;
  const toolbar = make('div', 'lpc-updates-toolbar');
  const records = make('div', 'lpc-updates-records'); records.setAttribute('aria-label', 'Updates');
  page.append(back, title, toolbar, records);
  let ready; page.readiness = new Promise(resolve => { ready = resolve; });
  const controller = createNotificationCenter({ api, panel: page, actions: toolbar, content: records,
    badge: make('span'), trigger: make('button'), refinePresentation: true, feed: true, background: false,
    destinationFor, navigate, showToast, onRefresh: () => ready(),
  });
  page.dataset.updatesRole = role;
  page.destroy = () => { controller.destroy(); page.replaceChildren(); ready(); };
  if (signal?.aborted) page.destroy();
  else { signal?.addEventListener('abort', page.destroy, { once: true }); controller.start(identity); }
  return page;
}
