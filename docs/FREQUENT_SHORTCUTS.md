# Learned sidebar shortcuts

Both V2 portals use `frontend/assets/scripts/utils/frequent-shortcuts.mjs`. A Shortcuts section appears beneath the main sidebar links once a supported secondary page has four visits within 30 days. It shows up to four pages, ordered by visit count, then recency. Visits to the same page less than ten minutes apart do not add to its count, and route refreshes without navigation do not add visits.

History is saved locally in the browser, keyed by verified account ID and portal role. It is not synchronized between devices, ports, or browsers. No prior navigation history is backfilled. When storage is unavailable, the current session can still learn shortcuts. Signing out or changing identity clears the rendered section and in-memory state; another account never reads the previous account's history.

Recognized secondary destinations and validated individual Matter routes can appear. Labels and URLs are generated from that catalog, never from stored arbitrary links. Main navigation destinations, search queries, other users’ profile URLs, document URLs, account closure, creation and editor actions are excluded. Individual Matter tabs share one counter and link to the overview. Matter IDs are stored as canonical routes, but Matter names are resolved through the existing authorized `/api/cases/:id` read and held only in memory; inaccessible Matters are omitted. No Matter names or document names are retained in storage. The feature does not change server permissions; shortcut links use the existing portal routers and authorization behavior.

Keep the same ranking and storage logic for both roles. The sidebar uses each portal's existing text styling, full-row hover surfaces and mobile navigation. Collapsed desktop sidebars hide the section; mobile links retain 44px targets.

Focused checks: `node --test backend/tests/unit/frequent-shortcuts.test.mjs` and `backend/tests/playwright/paralegal-support/frequent-shortcuts.spec.js`. Local 5050 render evidence is in `outputs/lpc-frequent-shortcuts-20261016/` and uses synthetic identities and intercepted API responses.
