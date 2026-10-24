# Attorney V2 — admin edit requests and review recovery

September 5, 2026. This continuation implements attorney review of admin-requested posting edits in both dashboards. It adds a V2 Matter action disclosure for posting review/editing, notes/history, admin feedback and the Matter destination. P4-03 remains open for full menu parity, including invitation, archive/restore and download/receipt entry points and their later lifecycle dependencies. This is local implementation; the remote cohort remains empty and disabled.

## User-facing behavior

The current dashboard's flagged/pending-review Matter menu opens “Review admin edit request” in its existing modal. V2 exposes the same workflow from the Matter action disclosure and the notes/history page. The shared screen names the Matter, displays the latest admin feedback, links to the supported posting editor and notes, shows the current review status and provides a separate submission confirmation.

Submitting requests admin review; it does not clear a flag. Admin request-edits and resolution remain under their existing admin-only permissions. Notes and history continue to have independent load and error boundaries. A full Matter note blocks appending a review request without truncating private notes or admin feedback, and the screen explains how to recover.

The current modal keeps its title and Close action visible while its content scrolls. The shared notes modal receives the same bounded layout correction.

## Actual posting-edit evidence

The former eligibility check compared Case.updatedAt with the admin request date. Unrelated Matter activity could therefore qualify as an edit. New admin edit requests now capture a fingerprint of the public posting: title, description, practice, jurisdiction, experience, amount, business deadline and task titles. Notes, task completion, applications and unrelated timestamps do not count. Changing the posting back to its original contents removes eligibility again.

Older flags have no trustworthy content baseline. They remain readable and explicitly require a new actual edit through either supported posting editor. The posting transaction captures their original content before that first real edit. No-op saves do not qualify and no background record migration is performed. Existing generic posting writers still compare correctly for flags that already have a baseline.

The additional Case fields retain the latest admin edit request, posting baseline and last accepted review receipt. Raw snapshots preserve absent/legacy values, unknown note/report metadata and unrelated Matter fields. Owner-visible review projections exclude reporter identities, report details and private notes.

## Stale requests, retries and access changes

GET `/api/cases/:caseId/flags/review` returns a verified actor/Matter projection, current eligibility, revision and last review receipt with no-store caching. POST `/api/cases/:caseId/flags/mark-resolved` requires the expected account, reviewed revision and a client request UUID. The browser verifies the session and obtains CSRF before one submission. Old cached attorney writers must refresh because requests without review/account context fail closed.

A changed posting or new admin request invalidates the old confirmation. The database compares the relevant raw content, ownership and moderation fields before atomically appending to the latest note and recording the receipt. Concurrent note edits survive; conflicting public-content changes prevent submission even if a general timestamp was not advanced. A replay of the exact recorded request returns the receipt without repeating the append or notification dispatch.

The browser never automatically retries a review mutation. Lost or failed responses retain the request identity in account-scoped page memory. A status check can confirm that exact request, including after an admin has already cleared the flag. Otherwise, the user must review the current state before a new submission. Pending requests survive V2 navigation and current-modal reopening, trigger unload protection and are cleared on account changes. Late responses cannot restore a closed/cleared modal. Private feedback and pending requests are not stored in localStorage, sessionStorage or URLs.

Notification/audit dispatch retains its existing post-persistence behavior. A receipt proves that the request was recorded, not that a notification was delivered or an admin has reviewed it.

## Verification and checkpoint

Evidence is in `backend/backups/attorney-v2-phase4-flag-review-start/`. The checkpoint hashes 1,420 pre-existing files and archives 76 selected source paths. Final owned-file hashes, the bounded patch and browser artifacts are recorded there. The stylesheet was omitted from the selected source archive; its recovered original bytes were independently verified against the pre-edit manifest hash. Ownership is bounded to 24 paths (17 existing and seven new). No pre-existing file outside those paths changed during this continuation.

- Initial flag-review browser run: **27/27 passed** across Chromium, Firefox and WebKit. Visual inspection then identified the mobile Close-button placement, prompting the shared modal scrolling correction and a final browser recheck.
- The initial new backend suite was moved to the replica-set test harness required by real posting transactions. In a later combined regression the existing posting suite lost its database connection after a hook timeout; its isolated recheck passed **23/23**. The final combined backend regression passed **71/71 tests across seven suites** in 64 seconds, covering moderation, notes, posting transactions, client models and attorney read sources.
- Final combined browser run after the modal correction: **93/96 passed**. The same archived-preview test failed in all three browsers because its generic `details` selector matched both the new action disclosure and the preview. The test now identifies the actual preview and separately verifies that the action disclosure remains closed. Its targeted recheck passed **3/3**. Thus **96 distinct browser scenarios have passing latest results across these sequential runs**; this is not one clean 96-test run.
- The combined run includes 27 flag-review, 39 Matter-notes and 30 Matter-list/Home scenarios across Chromium, Firefox and WebKit. Flag-review tests cover actual editor round trips, new admin feedback, failed/lost responses, route/modal recovery, account changes, full-note limits, already-resolved receipts, accessibility and mobile/desktop geometry. The final modal check explicitly verifies that Close remains inside the viewport.
- Scoped AA and overflow checks pass at 390 and 1366 pixels for review controls; existing read-view checks also cover narrower/tablet sizes and enlarged text. Initial and corrected current-mobile screenshots and V2 desktop screenshots were visually reviewed.
- Syntax, runtime/frontend bindings, frontend hygiene, API contracts, route-security inventory and performance checks pass. No application source changed during the final combined run or targeted preview recheck.
- The earlier full repository Jest result remains incomplete; this continuation does not claim full repository acceptance.

Release identifier: `attorney-v2-flag-review-20260905`. No commit, deployment, remote cohort enablement, production migration or live-data changes are included.
