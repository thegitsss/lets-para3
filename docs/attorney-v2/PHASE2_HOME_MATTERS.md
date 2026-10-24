# Attorney V2 — Home and read-only Matters

Implementation date: September 4, 2026. Local implementation and verification record; not production acceptance or completion of the attorney migration.

The user authorized beginning the next checklist phase. This slice replaces the Home and Matters navigation previews with account-backed views. It preserves the existing stack, API contracts, branding, and isolated attorney entry. No backend, paralegal, shared runtime, dependency, production configuration, or V1 implementation changes are part of this slice.

## Local behavior

Open `/attorney-v2.html#/home` on the normal local LPC server while signed in as an approved attorney. Remote entry remains disabled with an empty cohort. Existing attorney URLs continue to work.

- Home shows authoritative active/completed/open-posting metrics, recent and completed records, file-review and withdrawal attention items, overdue private tasks, applications, unread messages and conversation previews, business-date deadlines, and payment-method readiness.
- Payments summary values are integer cents. The Home aggregate must agree with `/api/payments/summary` before it appears. The copy describes pending Stripe payments. It does not infer funding, payout, refund, or release success.
- Matters has Active, Drafts, Archived, and Applications categories; 15 rows per local page; search; practice, deadline, update-time, archive-status filters; sorting; built-in and account-saved view reads; expandable read-only matter/application summaries; invitation status; file/unread summaries; and archive highlighting.
- Filters, page, category, and incoming matter/applicant/preview context stay addressable in the hash query. Saved-view selection does not save or delete a view. Create/edit, candidate review, files, messages, billing, and lifecycle actions use contextual links to the current authorized screens.
- Readiness uses the same profile-evidence rules, actual default payment method, and presence of a current or historical matter as V1. Drafts do not count as a posted first matter. Incomplete setup and a new user's tour appear first on Home. Skip, replay, four welcome-tour targets, per-account tab progress, and returning completion notices are supported without a modal navigation trap. Skip also clears the pending V1 onboarding/tour step so returning to an existing screen does not resurrect that prompt.
- The four tour destinations remain profile, payment-method setup, Matter creation, and paralegal discovery. Explicit **Finish guide** sends only `{ attorneyTourCompleted: true }` to the existing onboarding endpoint with CSRF protection. Completion is displayed only after an affirmative response; failure stays recoverable without an automatic retry. V1 marked the tour completed when first displaying it; V2 records the explicit Finish action instead. Profile completion and payment readiness are never set by the tour.

## Read-source decisions

| Surface | Existing source and scope | Handling |
|---|---|---|
| Home metrics and weekly deadlines | `GET /api/attorney/dashboard` | Use server metrics, not counts from a limited display list. Active work, open Job postings, and completed Case counts have different predicates. |
| Current matters | `GET /api/cases/my?withFiles=true&limit=100&archived=false` | Preserve owner-filtered server records and Case applicant counts. Files come from the existing CaseFile projection. |
| Archived matters | `GET /api/cases/my?archived=true&withFiles=true&limit=100` | Preserve membership in the server archive list, including paused withdrawal records whose settlement metadata alone does not establish relisting. Deduplicate overlap by identity without rewriting server fields. |
| Drafts | `GET /api/case-drafts?limit=200` | Preserve draft identity and continue-editor URL. Do not treat the draft dollar string as server cents. |
| Applications | `GET /api/applications/my-postings` | Preserve canonical server reconciliation and V1 eligibility filtering. Missing/unlinked records are named. Case versus Application count differences remain visible; no browser repair. |
| Money | `GET /api/payments/summary` and dashboard `metrics.escrowTotal` | Require agreement for Home aggregate; format server cents. Never sum truncated case rows. |
| Payment readiness | `GET /api/payments/payment-method/default` | Actual `paymentMethod` presence, matching V1. Failure is unavailable rather than “no card.” |
| Profile readiness and tour acknowledgment | `GET /api/users/me`; fixed `PATCH /api/users/me/onboarding` after `GET /api/csrf` | Existing profile evidence plus server-confirmed tour completion; no generic business mutation API. |
| Unread | `GET /api/messages/unread-count`, `/summary`, and `/threads?limit=100` | Compare global count to the unpaginated summary and corresponding loaded thread rows. Never sum a paginated thread subset to produce a global count. Suppress disagreement. Matter list uses per-matter summary counts. |
| Overdue private tasks | `GET /api/checklist?overdue=true&limit=1` | Use `total`; these are attorney-private checklist tasks, separate from matter scope and shared deadlines. |
| Saved views | `GET /api/account/dashboard-views?scope=attorney_matters` | Read/apply existing filters; preserve the V1 `inquiries` alias. Writes remain with existing tools. |

### Newly confirmed list limitation

The current Case list API returns at most **100 records per request**, ignores a `page` query, and returns no total. The draft API returns at most **200 records**, with no total/paging. An isolated test seeds 101 Cases and 201 drafts and proves those limits. V2 preserves the contracts and displays a limit notice and qualified counts when reached. Search and filters cover the loaded records. This is not an exhaustive account-wide list for larger accounts; full server paging is a separate backend dependency before large-account rollout. The current V1 handoff does not remove this limit.

Message thread previews also have a 100-record cap, but their endpoint provides a total. V2 names the preview scope; global unread remains derived from the unpaginated summary/count contracts.

### Earlier ambiguity register

- **A-01:** Not reproduced for the tested current sources. Both dashboard and Payments use `getAttorneyPaymentSummary`. The populated lifecycle fixture confirms equal values and isolation from another attorney’s larger balance. This does not close all payment/lifecycle rollout requirements.
- **A-02:** Count/summary/loaded-thread equivalence passes populated and empty fixtures. Client disagreement handling is tested. Realtime and every mutation/race combination remain Phase 7 work.
- **A-04:** V2 does not overwrite a Case applicant count using another response. It identifies disagreement and directs the user to applicant review. Full mutation/reconciliation acceptance remains Phase 5.
- **A-06/A-07:** Private checklist totals, date-only Matter deadlines, status aliases, paid/paused/relisted buckets, and funded-workspace predicates are separately characterized. Unknown statuses are visible and do not invent workspace eligibility.
- **A-18:** Weekly notes stay with Private Tasks; Home does not mount a hidden editor. The visible Tasks implementation/test correction remains Phase 3.
- **A-19:** New readiness and tour content use attorney tokens and automated AA checks. Historical V1 failures remain in the baseline.

## Lifecycle of the new views

The shell still mounts once. Each read region has loading, error/restricted, populated, and empty states and an explicit refresh control. A failed refresh clears old values in that region. No failed request becomes a fabricated zero or “all caught up.” Successful independent regions and categories remain available.

Navigation aborts the preceding view’s requests. Session protection also suspends the router, erases confidential outlet content, closes global tools, and invalidates pending responses. Same-account focus/visibility restoration rechecks authority and refreshes views without hiding the shell. Account replacement or invalid authorization retains the existing fail-closed redirect. Reconnection revalidates; offline state announces that displayed information may be stale. No extra polling timer, realtime owner, read acknowledgment, search history store, or confidential local-storage cache is introduced.

Back/Forward and refresh preserve URL state. Scroll restores after asynchronous content expands, unless the user has already begun interacting. Responsive layouts use container width, including the existing Assistant dock, and keep the main region as the scroll owner.

## Verification

The complete initial acceptance matrix passed **72/72 browser checks** across Chromium, Firefox, and WebKit with no retries or skips. After the final onboarding-return and archive-membership refinements, all new views plus the relevant accessibility/dark states passed another **42/42 checks** across the same browsers. These rechecks overlap the matrix; they are not 114 distinct scenarios.

The source/model/foundation checks passed **21/21 tests**; an additional run including the existing full lifecycle suite passed **23/23**. The final full repository regression passed **216/216 suites and 1,666/1,666 tests** under Node **24.18.0**, in **331.597 seconds**, without a concurrent browser suite.

Frontend hygiene, bindings, API contracts, production-copy checks, standard syntax (**672 JavaScript files**), explicit syntax checks for all **12 attorney ES modules**, and unchanged performance budgets passed. The measured frontend payload is **5,661.4 KiB**, within the existing **7,168.0 KiB** limit. Final screenshot review corrected category-heading grammar; syntax, copy, and budget checks passed again after that text-only correction. The final protected-file comparison reports zero changes outside the attorney-owned scope.

Acceptance logs, earlier failures, source hashes, static-check output, and synthetic browser screenshots are preserved in `backend/backups/attorney-v2-phase2-start/verification/`. The final evidence files include `accepted-jest.log`, `attorney-v2-phase2-accepted-browser.log`, `refinement-browser.log`, `lifecycle-recheck.log`, `static-checks.txt`, `final-source-hashes.json`, and `integrity.json`.

- Read model: malformed counts; integer cents and multiple currency formatting; date-only/DST filters; status aliases and unknown state; archive deduplication; inquiry/paused/relisted/paid buckets; profile readiness; application disagreement without mutation; and global unread reconciliation with partial thread pagination.
- Real source integration: populated owner lifecycle records, zero/one-matter accounts, nonowner exclusion, wrong role, disabled session, CaseFile counts, applicant mirrors, dates, shared payment totals, unread equivalence, no Case mutations or message read effects, and capped list contracts.
- Browser: real session and V1 summary comparison; populated/empty/capped lists; filters/saved views/paging/history; drafts and archive preview context; partial failure/restriction/recovery; exact money/dates/links; disagreement suppression; onboarding skip/replay/return and confirmed tour completion; late-response/session protection; shell persistence; global tools; light/dark AA; responsive and enlarged text.

Automated browser checks are not manual VoiceOver/NVDA, physical iOS/Android, owner visual approval, a full two-role hiring/completion rehearsal, or operational rollout proof. Those checklist gates remain open.

Earlier verification results are retained, not counted as passing: the initial Chromium run had a saved-view test locator failure (fixed by selecting the actual named combobox); a later WebKit run exceeded the combined three-scan accessibility test timeout. Each accessibility state now has its own test and trace, with the same assertions and unchanged 45-second timeout. The complete resulting 72-check matrix passed. One full Jest attempt passed 1,665 tests and failed the unchanged `phase2Lifecycle.test.js` on an HTTP 400 with an empty body from recommendation exclusions. That failure did not reproduce in the 23-test isolated run or the final 1,666-test full run. Its root cause is not established; the failed log remains available. No shared runtime, shared test assertion, or timeout was changed in response.

## Checkpoint and boundaries

Before edits, `backend/backups/attorney-v2-phase2-start/` received `attorney-sources.tar.gz` and a 1,293-path source hash manifest. The full earlier source checkpoint remains under `backend/backups/attorney-v2-phase1-20260904-214013/`. The Phase 2 checkpoint contains the exact prior attorney files; its manifest distinguishes this slice from the many pre-existing shared/paralegal edits.

Owned changes are attorney V2 modules/styles, attorney V2 tests, and attorney V2 documentation. No protected production implementation is edited. Test output and verification logs contain synthetic data only. There is no deployment, V1 retirement, live Stripe action, or database migration.
