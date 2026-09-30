# Attorney V2 — Weekly notes and monthly calendar

September 5, 2026. The user's continuation after the recorded D3-01/D3-02 findings authorizes completing these notes dependencies. This work is a bounded addition to Phase 3, not completion or production release of the attorney rebuild.

## Result and scope

`#/tasks` owns the visible weekly editor. `#/tasks?calendar=month&month=YYYY-MM` adds a Monday-first monthly calendar with four, five or six weeks, adjacent-month dates, previous/next/current month and month jump. Selecting a date opens and focuses that day's weekly editor. Notes and unsaved-week indicators appear in the calendar; compact screens keep the date and note indicator accessible. All seven days remain editable in V2, including weekends.

Drafts remain only in the workspace's memory. Navigation between weeks, months and other V2 routes retains them. Explicit saves report confirmation; failed or uncertain writes retain text and require checking the saved version. A changed saved week opens a comparison with explicit choices to use saved notes or retain the draft for review. Access/session loss removes private drafts, calendar previews and conflict text. No note text is added to browser storage, URLs or telemetry.

The shared dependency is limited to `WeeklyNote`, a new weekly-notes service, the existing two `/api/users/me/weekly-notes` handlers, and the current attorney dashboard's weekly-note adapter and asset version. Existing approval/authentication/CSRF guards and user ownership remain authoritative; the existing approved-user role coverage is preserved. No other shared workflow or paralegal implementation is changed.

## Calendar identity and existing records — D3-01

The API now requires a valid Monday in exact `YYYY-MM-DD` form and returns that same calendar-week label. It never derives the response label from the UTC serialization of a server-local storage date. Invalid, missing and non-Monday dates return 400.

Existing untagged records are looked up using the exact previous server-local calculation. Reads do not write or migrate records. The first successful explicit save adds `calendarWeek` while preserving the existing `_id`, physical `weekStart`, seven note positions and unrelated fields. Tagged records are resolved by their logical week first, so their label survives a later runtime timezone change. New records retain the existing physical-key convention as well as the logical label. The physical-key unique index remains, with an additional partial unique index on user plus `calendarWeek`.

A conflicting physical key already tagged to a different week returns 409 without disclosing its notes. Ambiguous records are held for investigation; the client never guesses, shifts note positions or repairs records.

This compatibility strategy assumes the existing runtime timezone for untagged legacy lookups. Production's historical timezone and records have not been inspected. Before release, inventory that timezone and ambiguous legacy keys; do not change runtime timezone while untagged records depend on it. This is a deployment gate, not a claim that existing production data has been migrated or certified.

## Atomic saves and current-dashboard compatibility — D3-02

GET returns seven notes and an opaque `revision`. PUT requires that revision, seven strings of at most 2,000 characters, and the requested calendar week. The revision binds to the user/week or stored record snapshot. An atomic conditional update checks the loaded counter, notes and timestamp and increments the counter. Concurrent first creations are protected by unique indexes. A stale save returns 409, and an unversioned save returns 428 without writing.

V2 includes the revision in its fixed private mutation after rechecking the signed-in owner and CSRF token. The preflight comparison helps explain conflicts; the server's conditional update closes the race after that comparison. When the attorney keeps a draft, days they left unchanged adopt the newer saved notes; only their edited days retain the local choice. It never retries writes automatically. Even loss of access during the follow-up conflict read clears private editor and comparison text.

The current dashboard now awaits its explicit modal save and closes only after confirmation. A failed/conflicting save retains the draft, disables repeat saving, and offers a fresh saved-note review. Choosing to retain the edit adopts the reviewed week as its baseline, preserving newer notes on other days. A further concurrent change is rejected again. Read failures show retry instead of fabricated empty notes. Access loss clears the modal and calendar. A verified owner ID is retained from bootstrap and checked again before notes reads/saves; account-change events clear the draft, and a different signed-in account cannot inherit it. Pagehide invalidates late requests and clears the cache, with fresh loading after BFCache return. The saved-note comparison has a labeled, scrollable text region and 44-pixel review controls for long notes on mobile.

This requires coordinated deployment of the API and updated `attorney-tabs.js` asset. Already-open cached clients without revisions receive 428 and must reload. Their old modal may still optimistically close despite that rejected save, so release must require refreshed clients before editing resumes; unversioned writes are intentionally no longer supported. Validate the required indexes before accepting concurrent writes in a deployed environment. Disabling V2 does not undo this shared notes contract: a rollback must retain the compatible notes API and current-dashboard adapter together. No deployment or rollback was executed here.

## Verification

The full regression passed **219 suites and 1,689 tests** in 413.342 seconds. The final V2 conflict-choice, calendar recovery and comparison checks also passed **9/9** across the three browsers. P3-02 is accepted locally; the release gates below remain open.

- The initial focused database/model checks passed 34 tests. The full regression includes a further passing real-database, cross-timezone legacy-record case.
- Browser coverage now has **141 unique cases with a passing latest result**, recorded in `browser-coverage.json`. The broad run passed 131/132; Firefox restored 499.75 pixels where the old assertion required exactly 500. The assertion now allows less than one CSS pixel of difference. The subsequent 33-case run passed 32/33; a new V1 test clicked a loading placeholder before the real note button existed. It now selects the accessible note button. The final affected set passed **18/18** across Chromium, Firefox and WebKit, including the 320-pixel calendar and account-switch guard. A final 9/9 pass also verifies the V2 merge of untouched days and the existing conflict/calendar recovery behavior. Both original failures and their traces are retained; these are sequential explicit rechecks, not hidden automatic retries.
- Current source syntax, frontend hygiene/bindings, API-reference, no-theater and performance checks passed. The frontend has 108 reachable modules; V2 has 19 modules. The aggregate frontend budget is 5,727.1 KiB of 7,168 KiB.
- Desktop and mobile calendar screenshots and the long-note mobile comparison were visually inspected. The saved comparison text scrolls within the modal, while its review and save/cancel controls remain available.

Primary evidence: `browser-matrix.log`, `browser-final-recheck.log`, `browser-accepted.log`, `browser-merge-accepted.log`, `browser-coverage.json`, `jest-accepted.log`, `static-final.log`, `final-source-hashes.json`, `integrity.json` and `screenshots/` in the checkpoint's verification directory.

Checks use Node 24.18.0, isolated temporary MongoDB, synthetic accounts and loopback browser servers. Browser and full Jest runs execute sequentially. Cases cover legacy records and unknown-field preservation, exact week identity, DST/year/leap boundaries, multiple timezones, simultaneous creation/update, stale/missing revisions, owner/role isolation, malformed inputs, current/new dashboard conflicts, failed saves, access loss, month navigation and visible calendar accessibility/geometry. The historical hidden-Home Tasks assertion remains historical evidence; these tests select the actual Tasks route and visible notes.

## Checkpoint and remaining work

`backend/backups/attorney-v2-weekly-notes-start/` contains the pre-edit archive and 1,303-file SHA-256 manifest. Verification and before/after integrity evidence are retained below its `verification/` directory. Unrelated pre-existing changes are preserved.

The local release is `attorney-v2-weekly-notes-20260905`, remotely default-off with an empty cohort. There was no production access, migration, payment operation, messaging, deployment, commit or legacy retirement. Production timezone/index/client-release checks and the wider release/retirement gates remain open. P2-05 large-account paging and Phase 4 onward remain separate checklist work.
