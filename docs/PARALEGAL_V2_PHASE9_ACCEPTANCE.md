# Paralegal V2 Phase 9 — Acceptance candidate audit

## Outcome

The rebuilt paralegal experience is a verified local acceptance candidate. The persistent V2 shell, Home, Browse, My Matters & Applications, Profile/Security/Preferences, authenticated Help, global Search, Notifications, LPC Assistant, and Matter workspace passed the complete paralegal browser matrix in Chromium, Firefox, and WebKit.

No deployment, production mutation, schema change, migration, payment action, Stripe access, or user-data change was performed.

## Acceptance and parity corrections

The first full browser attempt exposed two obsolete selectors in `v2-global-tools.spec.js`:

- Search is correctly an ARIA `combobox` because it controls selectable Matter and destination results.
- Two assertions still queried the input by its former `searchbox` role: the Escape/focus assertion and the multi-width overlay assertion.
- Both assertions now use the persistent `[data-v2-search-input]` contract. Product markup and Search behavior were not changed.
- Each correction passed in isolation across Chromium, Firefox, and WebKit before the uninterrupted full matrix was restarted.

No timeout was increased, no product failure was hidden, and no browser was skipped.

The later V1-to-V2 capability audit then corrected the remaining parity and reliability gaps without introducing new lifecycle states or replacing existing authorities:

- Home/Work now recognizes the retained active-Matter participant alias and `funded_in_progress` state.
- Profile readiness recognizes the retained `resumeKey` field.
- Failed profile autosave remains recoverable without looping the same unchanged revision.
- Message read watermarks survive Matter-tab remounts and retry only after a failed acknowledgement.
- Matter/Assistant recomposition is bounded at the affected desktop breakpoint.
- Persisted cross-process changes publish opaque refresh signals through a MongoDB change-stream bridge, while SSE, cross-tab reconciliation, focus/online refresh, and polling remain fallbacks.
- Onboarding refresh and realtime-heartbeat failures are observable instead of silently swallowed.

## Acceptance coverage

- State-adaptive Home: setup, populated, recommendation, application, availability, loading, partial failure, full failure, refresh, and access-loss states.
- Discovery: server-projected recommendation history, Browse eligibility, filters, details, direct links, reports, and application submission.
- Work: active Matters, invitations, applications, completed history, saved views, filtering, pagination, pre-engagement, withdrawal, and block confirmation.
- Settings: Profile, Security, Preferences, autosave, stale drafts, profile photo, themes, destructive confirmations, mobile scrolling, and Assistant-open recomposition.
- Matter workspace: overview, task review/completion handoff, messages, files, submissions, revisions, deadlines, private reminders, history, financial presentation, stale access, and completed-history boundaries.
- Global shell: stable initial markup, one content anchor, internal route transitions, browser history, header/sidebar identity, search, notifications, Help, Assistant, fixed-sidebar scroll bridging, and empty-page scroll feedback.
- Responsive and accessible presentation at the required phone, tablet, desktop, and wide widths, including drawer/overlay containment, keyboard operation, focus, WCAG A/AA scans, and reduced-motion behavior.

## Final verification

- Complete paralegal Playwright matrix: 381/381 passed in one uninterrupted run across Chromium, Firefox, and WebKit with `--fail-on-flaky-tests`; no skips or flakes.
- Complete Jest suite: 213/213 suites and 1,645/1,645 tests passed under Node 24.18.0/npm 11.16.0.
- Focused backend parity/realtime/lifecycle verification: 6/6 suites and 70/70 tests passed.
- Focused Matter regression: 30/30 passed across Chromium, Firefox, and WebKit.
- Focused foundation/onboarding regression: 27/27 passed across Chromium, Firefox, and WebKit.
- Complete browser-contract bundle passed: authentication fetch handling, public session navigation, dialogs, global Search, Matter experience, object context, and profile photo.
- Passed: JavaScript syntax (666 files), frontend hygiene (37 entry points, 500 asset references, 89 modules, 42 stylesheets), frontend API contract (284 literals / 359 mounted patterns), frontend bindings (65 scripts), runtime bindings (405 modules), route uniqueness (375 registrations), no-theater (507 production/operator files and 6 historical files), and performance (202 files, 5,562.8 KiB).

Two earlier complete-Jest attempts surfaced different non-repeating harness symptoms. The affected test and its complete domain file each passed ten consecutive isolated runs, and the final complete suite passed. No timeout, auth rule, payment behavior, or production behavior was changed to mask them.

## Known repository-wide exception

`check:focus` still reports the two pre-existing, intentional conditional skips in the public-site accessibility evidence suites:

- `playwright/accessibility/public-accessibility-phase-nine.spec.js`
- `playwright/accessibility/public-certification-phase-ten.spec.js`

Both skip non-Chromium duplicate evidence because those particular checks are browser-independent. Phase 9 added no skip, and the paralegal acceptance matrix ran every one of its 381 scenarios in all three browsers. This public-suite policy mismatch remains outside the paralegal rebuild and should be reconciled separately before a repository-wide release gate is claimed fully green.

## Checkpoint status

The acceptance candidate remains uncommitted. A dedicated checkpoint should be created only after the owner finishes visual review and explicitly requests the commit. Existing unrelated worktree changes remain preserved.
