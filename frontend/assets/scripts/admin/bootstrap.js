import '../admin-dashboard.js';
import '../admin/workspace.js';
import '../admin/accounts.js';
import '../admin/finance.js';
import '../admin/operations.js';
import '../admin/experience.js';
import '../admin/flow.js';
import '../admin/live.js';
import '../admin/menu.js';
import '../admin-matter-archive.mjs';
import '../utils/support-drawer.js';

// Module dependencies finish before evaluation. Keep all shell transformations
// in this evaluation/DOMContentLoaded turn, without waiting for network data.
const ready = () => {
  document.documentElement.classList.add('admin-layout-ready');
  document.dispatchEvent(new Event('admin:layout-ready'));
};
if (document.readyState === 'loading' || document.readyState === 'interactive') {
  document.addEventListener('DOMContentLoaded', ready, { once: true });
} else ready();
