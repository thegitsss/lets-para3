# Attorney V2 — Private Tasks and discovery

**Follow-up:** Weekly notes and the monthly calendar are now verified locally, with D3-01/D3-02 addressed in [PHASE3_WEEKLY_NOTES.md](PHASE3_WEEKLY_NOTES.md). This document retains the initial Phase 3 checkpoint and its then-open findings as historical evidence.

Implementation date: September 5, 2026. Local frontend work under the user's instruction to continue the checklist. This is not production acceptance or completion of the attorney rebuild.

## Implemented scope

- `#/tasks` owns the visible Private Tasks list, creation form and weekly-note editor. Tasks have server paging (20 per page), open/completed/all/overdue filters, optional current or archived Matter association, private details, confirmed completion/reopen, and inline delete confirmation. They use ChecklistTask records, never Case.tasks. The existing Matter chooser limit remains 100 current plus 100 archived records, with partial/limit notices.
- `#/paralegals` has the existing state and practice choices, multiple selection, search, minimum experience, recent/name/experience sorting, ten profiles per server page, explicit empty/error states and persistent URL filters. Cards use the same validated canonical presentation as V1 plus availability and experience.
- `#/paralegals/:id` displays a deliberately selected profile field set, public-versus-member preview, professional experience/education/languages, approved photo routes and authorized document preparation. A signed document link is prepared only on request, with unavailable and expired-link recovery. A 404 may use V1's public fallback; a 403 never does. No KYC, contact email, Stripe fields, preferences, notification settings or unknown DTO fields are rendered.
- Candidate/Matter/applicant/application context is validated and retained. Return targets are reconstructed from allowed local routes and known parameters. Invitations, pre-engagement and hiring continue through the existing profile workflow, as Phase 5 work. The V1 monthly calendar remains accessible through **Open current task and calendar tools**; that handoff is not counted as a rebuilt calendar.
- Home's overdue-task link opens the new overdue list, the welcome tour's browse link opens the new directory, and Matter applicant summaries link to candidate previews with their Matter/applicant context.

## Private writes and recovery

Only four new, fixed operations are exposed by the attorney API client: create checklist task, toggle checklist task, delete checklist task, and save weekly notes. The client verifies an approved attorney session with the same owner ID before each operation, obtains CSRF, projects the permitted request fields, uses cookie credentials and never automatically retries a write. Server ownership and participation guards remain authoritative.

A task is not declared created/completed/deleted before a valid response. An uncertain create retains the draft and disables resubmission until the attorney checks the list. An uncertain toggle stays disabled until a fresh list read because a second toggle could undo a successful first request. Navigation/session generations suppress stale responses.

Unsaved task and weekly-note text stays in page memory only. Route/week changes and a successful same-account focus refresh recover it. There is no confidential browser-storage cache. A native leave/reload warning protects unsaved text; leaving anyway loses it. Session protection, account change, pagehide and logout clear the in-memory store. Notes-access denial also removes conflict comparisons from the DOM. This is not crash-proof or cross-device unsaved-draft recovery.

The weekly editor has explicit save, seven labeled days, previous/current/next week, date jump, server refresh, failure recovery and a comparison when notes changed elsewhere. It checks the saved notes immediately before writing and requires an explicit choice if they differ. Returned normalized text becomes the saved baseline only after confirmation.

## Open notes acceptance issues — P3-02 remains unchecked

**D3-01: existing server week normalization is timezone-dependent.** `backend/routes/users.js` parses a bare date with `new Date(value)` (UTC), then uses server-local `getDay`, `setDate` and `setHours`. On an America/New_York server, requesting `2026-08-31` normalizes to the storage week `2026-08-24`. The existing V1 code sends the bare Monday string and ignores the returned week label. Existing persistence tests checked text round-trip but did not assert the requested week identity.

V2 preserves the existing request format and refuses to show or save notes when the returned `weekStart` differs. The local New York server therefore shows an explicit unavailable state, not a functional accepted notes editor. Mocked matching-week browser fixtures verify the editor; the real-source browser case verifies mismatch detection. Neither result closes P3-02.

Do not change the request to a different day, reinterpret the record key, or rewrite existing WeeklyNote rows as a frontend workaround: those approaches can detach existing V1 notes from their intended weeks. Remediation needs a separately scoped backend compatibility decision: establish the deployed server timezone and intended week-key contract, characterize existing stored rows across timezone/DST/year boundaries, define legacy read/write compatibility and collision handling, then add migration/rollback evidence if a data transition is chosen. No production rows or server timezone were inspected or changed in this phase.

**D3-02: notes have no atomic version precondition.** The PUT replaces all seven notes with `findOneAndUpdate` and accepts no expected revision. The frontend comparison protects against an already-observed change, but another writer can still save between that comparison and the PUT. Two simultaneous saves can overwrite one another. An atomic revision/If-Match contract and cross-version acceptance are backend dependencies, not solved by the frontend preflight.

The monthly overview is retained in V1; V2 currently has week navigation and date jump. Full monthly calendar parity and acceptance follow resolution of the notes contract.

## Existing source contracts

| Feature | Authoritative sources | Preservation |
|---|---|---|
| Task list/details | `GET /api/checklist?status=…&page=…&limit=20`, optional `caseId` and `overdue=true` | Owner-filtered records, total/pages, server ordering; no invented detail endpoint |
| Task actions | `POST /api/checklist`, `POST /api/checklist/:id/toggle`, `DELETE /api/checklist/:id` | Approved attorney, CSRF, owner scope, optional Matter participant check; no task-edit capability invented |
| Matter choices | Current and archived `/api/cases/my?limit=100` | Existing bounded lists, deduplicated choices, no unknown-record repair |
| Weekly notes | `GET/PUT /api/users/me/weekly-notes` | Seven notes, 2,000 characters per day, server cleaning, user scope, explicit week identity check |
| Directory | `GET /api/public/paralegals` | Same router mounted at V1 `/public/paralegals`; canonical presentation, filters/sort/paging/readiness and active blocks |
| Member profile | `GET /api/paralegals/:id` | Existing relationship/hidden-profile/block checks; profile-view audit side effect remains server-owned |
| Public fallback | `GET /api/public/paralegals/:id` after member 404 only | Public readiness/visibility; no member documents or authenticated-only fields |
| Photos | Approved `/api/public/paralegals/:id/photo?v=…` or `/api/users/profile-photo/:id?v=…` | Same-origin, matching ID, version query only; pending/original variants never requested |
| Documents | `GET /api/uploads/signed-get?key=…` | Matching candidate's permitted document key; server access check; safe HTTP(S) URL, no raw key as a download destination |

The authenticated legacy DTO includes preference/notification settings that are not needed for candidate display; V2 drops them at projection. This frontend projection does not alter or certify the broader shared endpoint's DTO policy.

## Verification record

The complete attorney browser matrix passed **108/108 checks** across Chromium, Firefox and WebKit in **4.0 minutes**, with no retries or skips. That is the existing 72 checks plus 12 new journeys run in three engines. New checks cover task actions/paging/uncertain submission, weekly save/recovery/conflict/access-loss/week mismatch, directory filtering/paging/return context, profile projection/documents/blocks/public fallback, visible Tasks geometry across eight widths, and automated light/dark accessibility. Browser engines are not physical-device or manual screen-reader certification.

The full repository regression passed **218/218 suites and 1,677/1,677 tests** under Node **24.18.0** in **587.004 seconds**, without concurrent browser tests. After the final return-filter/context refinement, the focused model/source check passed **11/11 tests** in **15.289 seconds**, and the three-engine Phase 3 recheck passed **36/36 checks** in **3.3 minutes**. Those checks overlap the 108-check matrix rather than adding distinct scenarios. P3-01, P3-03 and P3-04 are checked for this bounded local implementation; P3-02 remains open.

Frontend hygiene, bindings, API-contract, production-copy and performance gates passed. The static check parsed **675 JavaScript files**; explicit checks covered all **18 attorney ES modules**. Final frontend payload is **5,710.7 KiB**, within the unchanged **7,168.0 KiB** limit. Source census found **zero protected implementation changes**. Checklist coverage retains **99 IDs**, now with **1,386 mapped references** and unchanged original inventory source hashes.

The first focused source/model run passed 10/11; its only failure compared per-request `projectedAt` timestamps across API aliases. The comparison now excludes only that generated timestamp, and all 11 source/model tests passed. The first Chromium run passed 6/12; five candidate fixtures violated the strict canonical source schema and one test assumed the login fixture already owned a Matter. Corrected synthetic fixtures passed all 12 journeys.

The first full browser matrix passed 107/108 and exposed a timing race in the filter test: it inspected the previous request before hash navigation committed. It now waits for the new request's filter before checking all query fields. A further notes-access review removed saved-note comparisons on a 403 and added a corresponding regression check. Tests retain their assertions, browser projects, no-retry policy and existing timeout. No shared runtime change was made to accommodate a test.

Local preview stays default-off remotely with an empty cohort, release `attorney-v2-phase3-20260905`. Before edits, `backend/backups/attorney-v2-phase3-start/` saved the exact attorney sources and a 1,293-path source hash manifest. Backend/runtime/shared/paralegal/V1 sources and dependency locks are preserved. There is no deployment, payment operation, database migration or legacy retirement.

Commands ran from `backend` with `/Users/samanthasider/.nvm/versions/node/v24.18.0/bin` first on PATH:

```sh
node node_modules/jest/bin/jest.js --runInBand
node node_modules/jest/bin/jest.js --runInBand tests/attorneyV2PrivateModel.test.js tests/attorneyV2PrivateSources.test.js
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5051 node node_modules/playwright/cli.js test -c tests/playwright/attorney-v2/playwright.config.js --fail-on-flaky-tests
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5051 node node_modules/playwright/cli.js test -c tests/playwright/attorney-v2/playwright.config.js private-discovery.spec.js --fail-on-flaky-tests
```

Completed logs, earlier failures, static checks, synthetic screenshots, 30 exact source/test hashes, and protected-file integrity results are retained under `backend/backups/attorney-v2-phase3-start/verification/`. The primary logs end in `jest-accepted.log`, `browser-accepted.log`, `focused-final.log`, `browser-final-recheck.log` and `static-final.log`. The local test server was torn down by the harness; this record does not advertise it as still running.
