# Paralegal V2 Phase 6 — Global tools

Date: 2026-09-03  
Status: Complete locally; uncommitted and not deployed

## Scope completed

- Added authenticated Help as a routed V2 view while preserving `paralegalhelp.html` as the separate public Help surface.
- Preserved the existing Help subjects, substantive guidance, issue-report endpoint, validation/retry/success behavior, confidential-information warning, and resource destinations.
- Connected one compact Search controller to the persistent header. The actual input expands inline from the header icon on hover or focus; the results surface stays closed until a query begins.
- Preserved the current paralegal search authority: server-filtered Matter results only. The existing backend does not expose application or message result types to paralegals; profile results remain attorney-only.
- Added V2 adapters for trusted legacy destinations so Search, notifications, and Assistant actions use client-side routes without remounting the shell.
- Connected one notification center to the existing authorized notification projection, read/read-all/dismiss mutations, SSE stream, polling fallback, and cross-tab synchronization.
- Kept unread state authoritative: local counts do not change until the corresponding server mutation succeeds.
- Reused the existing LPC Assistant behavior and backend permission model instead of creating a second Assistant implementation.
- Passed explicit V2 route and Matter identifiers to the Assistant; the backend continues to re-fetch the Matter and enforce current membership, block, restriction, revoked-access, and closed-workspace rules.
- Kept the Assistant mounted and open across V2 route changes, with the approved mistake notice, working feedback controls, no initial loading bubble, no disallowed ghost text, and no shadow.
- Desktop opens the Assistant pinned by default. Tablet and mobile use a modal drawer so the content is never covered by a non-modal pinned panel.

## Source-of-truth contracts retained

- Search: `GET /api/cases/search?q=...&types=matter` and `backend/services/authenticatedSearch.js`.
- Notifications: `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`, `DELETE /api/notifications/:id`, and `GET /api/notifications/stream`.
- Notification visibility and destinations: `backend/services/notificationPresentation.js`.
- Issue reporting: `POST /api/incidents` with authenticated server-side classification.
- Assistant: existing support conversation, message, feedback, live-update, context-resolution, and paralegal tool services.

No schema, status, lifecycle, payment, recommendation, or authorization rule changed in Phase 6.

## Verification

- JavaScript syntax checks: passed for all Phase 6 scripts and the browser contract.
- Targeted Jest: 12/12 suites and 236/236 tests passed under Node 24.18.0.
- Complete Jest: 200/200 suites and 1,525/1,525 tests passed under Node 24.18.0.
- Complete V2 browser acceptance matrix: 90/90 passed across Chromium, Firefox, and WebKit.
- Phase 6 global-tool matrix: 15/15 passed across Chromium, Firefox, and WebKit (included in the 90 total).
- Required responsive coverage includes 320px, 390px, 768px, and 1440px for Help and every global overlay; the foundation suite also covers 360px, 375px, 430px, 1024px, and 1920px.
- Automated WCAG A/AA checks passed for the Help view, shell states, Assistant, and all three Settings categories.
- Performance budget: passed, 193 files and 5,348.0 KiB total.
- Manual screenshot review completed for Help, Search, Notifications, and the pinned Assistant using the isolated local test server.

## Next authorized phase

Phase 7 is the Matter workspace read-only foundation. It must begin with a fresh authorization and characterization pass; Phase 6 does not connect or alter Matter-workspace mutations.
