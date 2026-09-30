# Attorney V2 — saved Matter views

September 5, 2026. This continuation implements the saved-view create, restore and delete portion of P4-03 in both attorney dashboards. Restoring a view applies its saved filters. The remaining management menus and flag/request-edit/resolution actions keep P4-03 open. Remote V2 access remains disabled with an empty cohort.

## Behavior and compatibility

The current and V2 Matter lists share one controller. A view retains category, search, practice area, deadline, last-updated range, sorting and archive status. Applying a saved view does not mutate any Matter or saved preset. The current dashboard also restores search and archive status from its URL after reload, and retains saved practice filters even when no loaded Matter uses that practice.

Creating a view presents its applied filters and a name field. The existing limit remains twelve views per account scope, with unique names up to 48 characters. Duplicate names and capacity errors retain the draft. The V2 form explicitly asks users to apply filter changes before saving the resulting view. Deletion shows the named preset and filters for review; successful deletion leaves the applied filters unchanged.

Both clients read existing presets, including legacy IDs. The API retains the paralegal request contract and its existing filter normalization; neither paralegal saved-view client was changed. Search now supports the attorney list's existing 200-character limit. Archive status was previously dropped by saved-view normalization and now survives persistence.

## Persistence, conflicts and interrupted requests

GET `/api/account/dashboard-views` returns the scope, verified account ID, normalized views and opaque revisions with no-store caching. New attorney writes require the expected account, a stable client UUID and an explicit creation revision; changing or deleting an existing view requires its reviewed revision. The shared API client verifies the session again and obtains CSRF before each write. Cached older attorney writers without account/revision context fail closed and need a page refresh.

Persistence compares the raw saved-view collection atomically and writes only its preferences leaf. Concurrent creates, duplicate-name checks and capacity checks share that comparison. Updates and deletions preserve other views, other scopes, unknown legacy metadata and unrelated account preferences. The general account-preferences endpoint now writes only validated requested fields: regression testing demonstrated that Mongoose defaults on an older account could otherwise erase a concurrently created view even with apparent per-field assignments.

A create retry with the same UUID and contents returns the existing view. The browser does not automatically retry mutations. Unconfirmed creates/deletions require a read to determine whether the intended result exists. Changed presets require renewed deletion review. An unsuccessful creation retains its name and applied filters for an explicit retry.

Unfinished work and pending request identities live only in page memory. They survive V2 route navigation, trigger unload protection and are cleared at account changes. Draft names are not written to browser storage. Applied list filters retain their existing URL representation. Late responses cannot repopulate cleared account state. Initial read failures disable saving and deletion while keeping built-in filter navigation available.

## Verification

Evidence lives in `backend/backups/attorney-v2-phase4-saved-views-start/`. The pre-edit checkpoint hashes 1,421 existing files and archives 63 selected sources. Verification results and owned-file hashes are recorded there. The final change is bounded to 24 owned files (16 existing and 8 new); no pre-existing file outside those paths changed during this continuation. The reviewed patch is against the checkpoint, preserving the already-dirty workspace.

- Targeted Jest regression: **79/79 tests across 11 suites passed**. Coverage includes stable create identities, atomic duplicate/capacity handling, stale updates/deletes, raw legacy metadata, older-account settings races, cross-scope/owner/revision guards, private state/API behavior, account settings, notes and attorney foundation/read models.
- Saved-view browser checks: **27/27 passed** across Chromium, Firefox and WebKit. The nine scenarios cover all-filter current/V2 restoration, creation in each dashboard, deletion without changing filters, lost/failed creation with route recovery, stale and lost deletion, initial-read failure, duplicate/capacity handling, account-change late-response suppression, and mobile/desktop review controls.
- Existing Matter-list and notes browser regression: **69/69 passed** across the same browsers. Combined with saved views, this continuation has **96/96 passing browser checks across two sequential runs**, not one combined run.
- Scoped AA checks and overflow checks pass for review controls at 390 and 1366 pixels; existing Matter-list checks also cover 320, 768, 1024, 1440 pixels and enlarged text. Chromium current-desktop/V2-mobile, Firefox V2-desktop and WebKit current-mobile screenshots were visually inspected.
- JavaScript syntax, runtime bindings, frontend hygiene/bindings, frontend API contracts, route-security inventory and performance budgets pass. Application source hashes remained unchanged throughout both browser runs.
- The earlier full Jest run remains incomplete due to incident-suite timeout/teardown cascades and documented paralegal regressions. This continuation does not claim a passing full repository regression.

Release identifier: `attorney-v2-saved-views-20260905`; no remote rollout, migration, commit or deployment is included.
