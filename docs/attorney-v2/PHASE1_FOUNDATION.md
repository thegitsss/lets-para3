# Attorney V2 Phase 1 — local foundation

Recorded: September 4, 2026

Status: Implemented and verified locally. This is a navigation foundation, not completion of the attorney workflow migration.

## Scope and authority

The owner said “ok go for it” after the recommendation to checkpoint the existing work, build the attorney V2 shell/navigation, and then move workflows incrementally. That authorizes this isolated local foundation. The Phase 0 documents remain historical audit evidence; their earlier implementation restriction is superseded for this slice by the current instruction.

`docs/LPC_PRODUCT_NORTH_STAR.md` controls the product direction. The existing LPC fonts, white working surface, restrained borders, sidebar, header tools, and Matter terminology are retained. Local development works without browser flags or cohort enrollment.

## Checkpoint and protected dependencies

- Branch: `dashboard-redesign`.
- Comparison commit: `6cecc07a72a74d4bffd9cd5fa061f738db29d00c`.
- Dependency snapshot: `PHASE1_DEPENDENCY_MANIFEST.json` records SHA-256 hashes and deletions for all 1,276 existing tracked/non-ignored source and evidence paths.
- Recoverable source archive: `backend/backups/attorney-v2-phase1-20260904-214013/source.tar.gz`.
- Archive SHA-256: `69a9294ce7764f0d2c62dfea5d144b31204f00ccb589bb290453d2c1075705b0`.
- This is a filesystem checkpoint, not a Git commit. Existing work was not staged, reverted, or attributed to attorney V2. Ignored environment files, dependencies, local auth state, and Git internals were excluded.

The manifest is the explicit baseline dependency set for this local slice. Every pre-existing file is read-only. The full starting Jest run passed **213/213 suites, 1,645/1,645 tests** under Node **24.18.0**, using the existing ephemeral MongoDB harness.

## Owned additions

- `frontend/attorney-v2.html`
- `frontend/assets/scripts/attorney-v2/{app,api-client,session-boundary,release,routes,router,views,global-tools}.mjs`
- `frontend/assets/styles/attorney-v2.css`
- `backend/tests/attorneyV2Foundation.test.js`
- `backend/tests/playwright/attorney-v2/{playwright.config.js,foundation.spec.js}`
- This record and `PHASE1_DEPENDENCY_MANIFEST.json`.

There are no edits to attorney V1, paralegal V1/V2, shared runtime files, backend routes, models, schemas, payment behavior, or dependencies.

## Local entry and behavior

Open `/attorney-v2.html#/home` on the normal local LPC server while signed in as an approved attorney. The static entry and hash router follow the existing paralegal deployment shape without adding server rewrites. Production URL selection remains a rollout decision.

The sidebar, header, search/notification containers, Assistant host, and routed content container mount once. Navigation replaces only the content inside `main`. Direct entry, refresh, history, scroll restoration, focus management, responsive navigation, and route errors are handled by attorney-owned modules.

| Route | Current foundation behavior |
|---|---|
| `#/home` | Welcome and navigation shortcuts; link to current attorney Home |
| `#/matters` | Matter destination and Create a Matter handoff |
| `#/matters?view=active\|draft\|archived\|applications` | Preserves the corresponding V1 list selection |
| `#/matters/new` | Preserves draft/edit identity when opening the existing editor |
| `#/matters/:caseId/:tab` | Validated record/tab route with an explicit existing workspace handoff |
| `#/tasks`, `#/paralegals`, `#/payments` | Stable section navigation with current-screen links |
| `#/settings`, `#/profile`, `#/help` | Stable account/help destinations with current-screen links |
| Unknown route | Local page-not-found view with working navigation |

Preview copy explicitly identifies workflows that still open in the current workspace. No invented counts, money totals, Matter records, or nonfunctional mutation controls appear in these views. V1 bookmarks and link producers remain untouched.

## Authority and global integrations

- One session owner verifies `/api/auth/me` before revealing identity or tools. Cached browser identity is never an authorization source. Wrong roles, pending/restricted/deleted accounts, account replacement, expired sessions, and verification failures remain protected.
- Session checks run after focus/visibility restoration, storage changes, and BFCache restoration. Pagehide removes routed content. Session protection closes tools, cancels requests, and hides the Assistant independently of its async module work.
- Shared `auth.js` is loaded after DOMContentLoaded so its legacy boot listener does not create a second session owner. Existing persistence and secure logout helpers are consumed unchanged.
- The attorney API adapter is read-only, same-origin, cookie-authenticated, uncached, and cancellation-aware. Late responses are rejected even if a transport ignores abort. It neither retries requests nor exposes raw server error bodies.
- Search reads the existing authorized `/api/cases/search` contract on submission. Notifications read `/api/notifications` when opened. Their record links preserve V1 destinations after same-origin/path validation. Notifications are not marked read or dismissed by this slice. No new polling or realtime stream is started.
- The existing Assistant is loaded on demand into the persistent `data-support-v2-host`. The shared `lpc-v2` body marker selects its existing 1101px docking threshold; attorney-owned CSS reserves space beside the nested frame. This addresses A-22 for the new entry without editing shared code. Matter-specific Assistant capabilities remain with V1.
- Local health events contain release identity and allowlisted categories only, with no account IDs, query strings, titles, request payloads, or error bodies. The standard existing Core Web Vitals module is included and disables collection on localhost.
- Light/dark appearance is derived from the verified preference, including legacy mountain-dark presentation. There are no preference writes or theme migrations.

## Release boundary

The isolated entry works on loopback hosts without enrollment. The attorney release module defaults remote access off and has an empty approved-attorney cohort. This is a presentation gate only: all real access remains with existing backend authorization. V1 never redirects into V2 and does not load the new assets.

Changing the bundled remote gate requires a new artifact; this slice does **not** claim an operational remotely managed kill switch, a rollout rehearsal, or production readiness. Those require the later deployment/control boundary in the migration plan. Local rollback is to use the existing attorney URL; the checkpoint also preserves the exact prior filesystem state.

## Validation

- Starting full Jest baseline: **213/213 suites, 1,645/1,645 tests** passed.
- Attorney browser matrix: **33/33 tests** passed across Chromium, Firefox, and WebKit, without retries, skips, or flakes. Covers persistent node identity, real attorney login, direct routes/history/scroll, the eight required widths (320–1920), keyboard navigation, search/notification reads, stale-response suppression, role/account/session boundaries, simulated BFCache page events, automated WCAG A/AA checks, 200% text enlargement, dark appearance, and Assistant docking/toggling/tablet modal behavior.
- Focused foundation + existing release-runner recheck: **2/2 suites, 31/31 tests** passed; **9** of these are the new foundation behavior tests.
- Frontend hygiene, API contracts, frontend bindings, production no-theater, syntax (**669 JavaScript files**), and performance checks passed. Current frontend payload is **5,609.3 KiB**, within the unchanged 7,168.0 KiB budget.
- Pre-existing-file integrity comparison: **zero changes** against the checkpoint manifest.
- Final uninterrupted full Jest regression: **214/214 suites, 1,654/1,654 tests** passed under Node **24.18.0**, in **345.713 seconds**.

One attempted full Jest run overlapped the browser matrix and timed out in the existing `incidentRelease.test.js` suite, cascading into connection/teardown errors. That stalled run was stopped, not counted as passing. The affected suite then passed unchanged in isolation, and the final full run passed without concurrent browser work. No test timeout, assertion, or shared runtime was weakened. Baseline, browser, and final Jest logs are preserved beside the checkpoint archive in its `verification/` directory.

Browser coverage uses the existing synthetic attorney login and a fresh ephemeral local MongoDB instance. There is no production access or live Stripe use. The browser config fixes the base URL to loopback. Tests have no retries or skips, and use `--fail-on-flaky-tests`.

Manual owner visual/workflow review and operational rollout remain future release gates. The next implementation slice is read-only attorney Home and Matters; lifecycle/payment mutations remain in the existing screens.
