# Paralegal V2 Cleanup Checklist

## Purpose

Track the cleanup and consolidation work required to complete the paralegal V2 experience without changing verified lifecycle, payment, authorization, or recommendation behavior unintentionally.

This checklist covers the authenticated paralegal journey:

- Home
- Browse Matters and search results
- Recommendations
- Applications and invitations
- Active and completed Matters
- Matter workspaces, messages, files, deadlines, and submissions
- Profile, Account Settings, Security, and Preferences
- Notifications, unread counts, badges, global search, Help, and LPC Assistant

## Status legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete and verified
- `[!]` Blocked or requires a product/data decision

## Baseline rules

- [x] Preserve all currently verified production behavior unless a separately approved change explicitly replaces it.
- [x] Do not redesign lifecycle, payment, authorization, eligibility, or access rules as part of visual cleanup.
- [x] Do not delete a compatibility layer until its removal gate is satisfied.
- [x] Characterize current behavior before consolidating duplicated logic.
- [x] Keep attorney, paralegal, and admin projections consistent for every affected event.
- [x] Test desktop, mobile, deep links, refreshes, multi-tab synchronization, keyboard navigation, and assistive technology where applicable.
- [x] Keep the existing local preview live while frontend work is being reviewed.

---

## Phase 1 — Shared authenticated shell and layout stability

### Initial shell

- [x] Inventory the sidebar, header, search, notification, account-control, and Assistant markup shipped by every authenticated paralegal page.
- [x] Define one shared initial HTML contract for the authenticated product shell.
- [x] Render or reserve the shared header and sidebar before first paint.
- [x] Remove page-specific placeholder brands such as `Dashboard` only after the shared shell exists in the initial document.
- [x] Stop moving visible main content, controls, or toolbars into new wrappers after first paint.
- [x] Ensure the selected navigation state is page-specific without changing the shared shell geometry.
- [x] Preserve the current desktop header and sidebar appearance approved from Browse Matters.
- [x] Preserve accessible touch targets, labels, focus order, and keyboard interaction.

### Layout stability verification

- [x] Verify Home, Browse Matters, My Matters & Applications, Matter workspace, Profile, Account Settings, and public Help at 320px, 360px, 375px, 390px, 430px, 768px, 1024px, 1440px, and 1920px.
- [x] Verify direct loads and navigation between every authenticated paralegal surface.
- [x] Verify menu closed, opening, open, and closing states.
- [x] Verify search closed, focused, open, populated, empty, and closing states.
- [x] Verify Assistant closed and open states without disabling page scrolling unexpectedly.
- [x] Measure layout geometry and confirm navigation does not blink, jump, resize, or reveal hidden legacy controls.
- [x] Confirm browser back/forward and deep-linked hashes preserve the correct shell and selected navigation state.

### Removal gate

- [x] Remove `sidebar-layout-ready` and equivalent first-paint hiding from the Phase 1 shell after verifying the initial document renders correctly without it.
- [x] Keep static per-page shell markup as the initial-delivery mechanism, with one tested markup and geometry contract across authenticated routes.
- [x] Ensure no visible header depends on post-load relocation; retain hidden legacy-toolbar compatibility only for characterized legacy consumers tracked for later cleanup.

---

## Phase 2 — Home dashboard dead-code and duplicate-state cleanup

### Characterization

- [x] Record the current Home states: payout setup, incomplete profile, no active work, active Matter, recommendations, invitations, applications, deadlines, messages, and released compensation.
- [x] Add or retain tests proving which section appears for each state and which action is primary.
- [x] Characterize refresh behavior after application, invitation, message, deadline, availability, profile, payout, and Matter-status changes.

### Dead frontend code

- [x] Confirm that `messageBox`, `earnedThisMonthCard`, and `earningsToggle` have no rendered consumers.
- [x] Remove their selectors, listeners, state, and CSS after characterization confirmed they were dead.
- [x] Confirm that `assignmentCardTemplate` is unused and remove it.
- [x] Inventory unused legacy selectors for stats cards, quick actions, activity cards, assignment cards, old Stripe banners, and old earnings cards.
- [x] Remove confirmed-obsolete dashboard CSS instead of overriding it in later stylesheets.
- [x] Keep Home-specific V2 styling in `paralegal-private-office.css`; retain only the generic inline rules still required by My Matters, applications, dialogs, and legacy compatibility.

### Duplicate data ownership

- [x] Map every call to `/api/paralegal/dashboard`, `/api/applications/my`, `/api/jobs/open`, recommendation exclusions, invitations, events, messages, earnings, Stripe status, and availability.
- [x] Make `paralegal-dashboard.js` the Home data coordinator and `lpc:paralegal-dashboard-refresh` the projection event consumed by My Matters.
- [x] Remove the duplicate initial `/api/paralegal/dashboard` request after active/completed Matter behavior was characterized.
- [x] Retain `metrics.pendingApplications` and `myApplications` as documented lifecycle/API projections because existing cross-role and access-loss contracts consume them, even though Home uses `/api/applications/my` for detailed application rendering.
- [x] Confirm and enforce that an older dashboard or application response cannot overwrite a newer request.
- [x] Confirm rapid navigation and multi-tab events cannot render stale counts or stale cards.

### Phase 2 data ownership determination

- `/api/paralegal/dashboard`: one initial owner, `paralegal-dashboard.js`; supplies active-Matter and earnings projections to Home and emits active Matters to the cases view.
- `/api/applications/my`: application-list coordinator inside `paralegal-dashboard.js`; generation-guarded and used for Home plus My Applications.
- `/api/jobs/open` plus `/api/applications/recommendation-exclusions`: recommendation-state loader; server history remains authoritative and stale generations are discarded.
- Invitations, events, message threads, unread totals, Stripe Connect status, and availability retain their existing authoritative endpoints and are composed into the Home snapshot without changing their business rules.
- `/api/cases/my-completed`: remains independently owned by Completed Matters because it is historical data outside the live Home projection.

### Completion gate

- [x] Home state contracts pass.
- [x] Recommendation contracts pass.
- [x] Header, sidebar, search, notification, and Assistant contracts pass.
- [x] No removed selector, template, or response field is referenced by production code or tests.
- [x] Frontend payload improved from 7,344.5 KiB to 7,332.0 KiB without raising the 7,168.0 KiB threshold; the inherited baseline overage remains tracked for later asset-wide cleanup.

---

## Phase 3 — Recommendation and application consistency

### Recommendation authority

- [x] Characterize the current state, practice-area, experience, block, publication, assignment, and historical-application rules.
- [x] Preserve the rule that any historical application prevents a Matter from returning to recommendations, including withdrawn, rejected, and inactive applications.
- [x] Define one authoritative recommendation projection, preferably server-side.
- [x] Return the recommendation reason or matched attributes needed by the UI without exposing sensitive ranking internals.
- [x] Keep Browse Matters broader than recommendations unless product requirements explicitly change.
- [x] Add parity tests proving the browser and authoritative projection cannot disagree during migration.

### Experience requirements

- [x] Inventory canonical and legacy experience fields.
- [x] Consolidate numeric and text parsing into one shared server-side function.
- [x] Preserve legacy `Experience: N` parsing until production data no longer depends on it.
- [x] Add boundary tests for missing, zero, fractional, malformed, and exact-match experience values.

### Application history decision

- [x] Decide whether withdrawn applications should appear in the paralegal's visible historical application record.
- [x] If visible, define their label, placement, filtering, and available actions. *(Not applicable: the verified active-queue presentation remains authoritative.)*
- [x] If intentionally hidden, document why recommendation history still retains them.
- [x] Align Home, My Applications, Browse Matters, search results, counts, badges, and deep links with the decision.

### Application-history presentation decision — 2026-08-31

- Home and My Applications remain active-work queues, not a complete historical ledger. Withdrawn, rejected, and accepted applications are intentionally absent from those active queues.
- Canonical `Application` records and status history remain intact. Every canonical application status permanently excludes the Matter from Recommendations, so a terminal or inactive state cannot manufacture a new recommendation.
- Submitted, viewed, and shortlisted applications suppress Browse apply controls and remain visible in My Applications. Rejected applications remain server-authoritative and cannot be resubmitted. Withdrawn applications remain hidden from My Applications but retain the existing explicit reapplication behavior in Browse. Search and authorized direct Matter access retain their existing broader discovery rules.

### Browse applied-state cleanup

- [x] Characterize the current server and `sessionStorage` applied-state behavior.
- [x] Make server application history authoritative after authentication.
- [x] Retain session storage only for a documented transient/offline purpose, or remove it.
- [x] Prevent withdrawn, rejected, inactive, and duplicate applications from presenting contradictory Apply states.
- [x] Verify refresh, browser back/forward, two-tab use, and direct Matter links.

### Completion gate

- [x] Cross-role recommendation/application scenarios pass.
- [x] A historically applied-to Matter never returns to recommendations.
- [x] Browse and application history show intentional, documented states.
- [x] No client-only ranking rule can silently diverge from the server.

---

## Phase 4 — Eligibility, availability, and Stripe-rule consolidation

### Application eligibility

- [x] Inventory every role, approval, profile-photo, availability, block, Matter-state, assignment, experience, duplicate-application, and payout-readiness check.
- [x] Identify the authoritative policy result for application eligibility.
- [x] Make frontend controls consume policy output rather than independently recreating rules.
- [x] Preserve backend enforcement regardless of frontend presentation.
- [x] Remove the dual-signature workflow-policy compatibility path only after all callers use one documented contract.
- [x] Keep development-only bypasses isolated, environment-gated, and covered by tests.

### Payout readiness

- [x] Define one projection for Stripe account presence, details submission, payout enablement, restrictions, and required setup actions.
- [x] Ensure Home, Browse, Account Settings, application routes, and Assistant use that projection consistently.
- [x] Prevent a failed or stale Stripe refresh from incorrectly enabling applications.
- [x] Preserve Phase 4/4B payment, chargeback, payout-hold, and immutable financial-evidence behavior.
- [x] Do not change charge, payout, refund, transfer, or reconciliation behavior during UI consolidation.

### Availability

- [x] Define the server record as authoritative.
- [x] Inventory and remove unnecessary local-storage representations after synchronization tests exist.
- [x] Standardize the display labels and available options across Home, header controls, Profile, and Account Settings.
- [x] Verify multi-tab updates, failed saves, retry behavior, and loss of access.

### Phase 4 authority determination

- `buildApplicationEligibility` is the canonical application-readiness contract. It composes approved paralegal role/status, block relationship, open and unassigned Matter state, duplicate application, profile photo, and verified payout readiness. Browse consumes the returned `applicationEligibility`; the submission route independently re-evaluates the same policy and remains authoritative.
- Availability remains a server-owned discovery/profile signal and is explicitly not an application blocker. The detailed `availabilityDetails` record is written through `/api/paralegals/update-availability`. The signed-in user snapshot in browser storage is retained only as a verified session projection and cross-tab signal; receiving tabs reload `/api/users/me` instead of trusting the storage payload. The unused `/api/users/me/availability` compatibility endpoint remains in place because removing a public route requires a separate deprecation audit.
- `projectPayoutReadiness` is the canonical display/application projection for Stripe account presence, submitted details, payout enablement, restrictions, evidence freshness, and required action. `/api/payments/connect/status` exposes it; Home, Account Settings, Browse, the application route, and the Assistant consume it. Failed live lookups are `temporarily_unavailable` and never ready.
- Stripe Connect bypass identities are centralized in one development/test-only allowlist that is empty in production. Charge, payout, refund, transfer, payout-hold, chargeback, `PaymentOperation`, `FinancialAdjustment`, `PlatformIncome`, and reconciliation paths were not modified.

### Completion gate

- [x] Eligibility policy tests pass for every blocker and eligible state.
- [x] UI and API agree on the reason an application is enabled or blocked.
- [x] Stripe and availability state cannot become falsely optimistic after stale or failed requests.

---

## Phase 5 — Component and surface modernization

### Canonical components

- [x] Use the canonical LPC dialog utility for confirmation, warning, destructive, informational, prompt, and alert states.
- [x] Replace the legacy image-card presentation without changing dialog actions or lifecycle effects.
- [x] Reduce Assistant CSS to the active side-drawer implementation and required responsive states.
- [x] Create shared empty-state, loading-state, error-state, badge, count, status, filter, pagination, and action presentation.
- [x] Preserve white page backgrounds and the approved restrained navy, blue, and gold product palette.
- [x] Avoid shadows where the approved paralegal direction excludes them.

### Browse Matters

- [!] The active Browse presentation is centralized in scoped LPC product components; its characterized structural CSS remains in place until Phase 6 so filter and expanded-detail behavior is not destabilized.
- [x] Preserve all filters, sorting, eligibility presentation, expanded details, attorney preview, and application actions.
- [x] Keep `Details` as the Matter-detail action label where applicable.
- [x] Verify empty, populated, loading, error, blocked, previously applied, and payout-incomplete states.

### My Matters & Applications

- [x] Modernize active Matters, completed Matters, applications, invitations, filters, saved views, and pagination.
- [x] Preserve all current direct-link and highlight behavior.
- [x] Make active work visually distinct from open opportunities and recommendations.
- [x] Verify archived, withdrawn, rejected, completed, cancelled, paused, and read-only states.

### Matter workspace

- [x] Consolidate workspace header/sidebar behavior with the shared shell.
- [x] Modernize messages, files, deadlines, tasks, submissions, revisions, approvals, payment state, and read-only presentation without changing authorization.
- [x] Preserve LPC Assistant workspace-access boundaries.
- [x] Verify loss of access, blocks, stale sessions, completed Matters, chargebacks, payout holds, and direct links.

### Profile and Account Settings

- [!] The large characterized settings controller remains intact for behavior safety; the attorney-only dashboard module now has a role-owned loading boundary. Physical per-tab extraction is reserved for Phase 6 characterization cleanup.
- [x] Stop loading the attorney-only dashboard module for paralegals.
- [x] Replace the full-page asynchronous reveal with a stable initial shell and local loading states.
- [x] Modernize remaining Profile, Account, Security, and Preferences controls consistently.
- [x] Preserve passkeys, profile photo, education, documents, blocks, notifications, themes, and privacy behavior.

### Help

- [x] Keep the existing public-style Help page so signed-out users retain the same support entry point.
- [x] Add authenticated Help as a V2 route while preserving the public page separately. This supersedes the pre-rebuild decision after owner approval of the full V2 plan.
- [x] Verify Assistant, issue reporting, contact/support links, authentication, and sign-out behavior in the appropriate public or authenticated surface.

### Completion gate

- [x] Each paralegal surface passes functional, responsive, keyboard, screen-reader, and visual-regression verification before moving to the next surface.
- [x] Shared profile and Matter-detail surfaces retain their cross-role shell and behavior; unrelated pre-existing attorney-only contrast/test-fixture findings remain outside Phase 5.

---

## Phase 6 — Compatibility-layer retirement

### Job and Case dual-model compatibility

- [x] Inventory every open, linked, orphaned, relisted, paused, assigned, completed, archived, and historical record shape through the separately authorized aggregate-only production audit.
- [x] Define `Case` as lifecycle/workspace authority and retain `Job` as the discovery projection until its controlled migration is complete.
- [!] Phase 6A shows 32/33 Job/Case workflows are known test data; one correctly linked workflow remains unknown. Do not build a customer-history migration around the test residue or retire the models while that workflow and active callers remain unclassified.
- [!] Before/after record counts and cross-role visibility cannot be proven until an authorized migration is executed.
- [x] Keep `Job`/`Case` joining for now: the one unknown workflow and active dual-model callers remain uncharacterized, even though the other 32 workflows are known test data.

### Application mirrors

- [x] Phase 6A classifies all 5 missing-Job Applications, all 3 missing active mirrors, all 3 embedded-only applicants, and 29/30 count mismatches as known test residue—not customer migration blockers.
- [x] Define canonical `Application` records as application-history authority and `Case.applicants` as a temporary current-candidate projection.
- [!] One clean Application workflow and one non-open count mismatch remain unknown; caller migration and that provenance question must be resolved before mirror retirement.
- [x] Retain mirror writes until attorney, paralegal, admin, count, badge, notification, search, Assistant, and deep-link consumers have migrated.

### Legacy fields and statuses

- [x] Inventory duplicated actor, Matter, listing, profile-image, practice-area, state, and status fields.
- [x] Measure production usage by provenance: Case actor/state aliases are consistent; among 125 unknown users, 48 retain both profile-image aliases, 58 use practice areas, and 50 use state-experience evidence.
- [!] No machine-readable real-customer marker exists for those users; alias dependency remains unknown and must not be inferred in either direction.
- [x] Keep read compatibility until all records and callers are migrated.
- [x] Retain aliases until deep links, jobs, notifications, webhooks, reports, and archived records pass after migration.

### Legacy themes

- [x] Determine stored usage and provenance: 101 users have `mountain`, 9 have `mountain-dark`; 7 mountain users are known tests and 103 mountain-family preferences are not test-classified. The owner confirms the 100+ population is real user data.
- [x] Apply the owner-approved presentation mapping `mountain → light` and `mountain-dark → dark` without removing unrelated preferences.
- [!] Persisting the normalized value for existing production accounts remains a separately authorized migration; V2 does not require retired theme CSS or expose retired theme names.

### Redirect pages

- [!] Database data cannot measure page-view usage and no repository analytics source records it; access-log or analytics evidence is still required.
- [x] Preserve query strings and canonical target hashes during redirects.
- [x] Retain redirects while external links, emails, bookmarks, or notifications may still target them.
- [x] Do not remove redirects before an approved deprecation period and usage/deep-link audit.

### Completion gate

- [x] Production-read audit was separately authorized and documented in `PHASE6_COMPATIBILITY_RETIREMENT_REPORT.md`.
- [x] Migration, rollback, reconciliation, and record-count procedures are documented for review; none were executed.
- [x] No historical, archived, financial, legal, or audit evidence was deleted or changed.
- [x] Cross-role lifecycle contracts (57/57 targeted tests), redirect/deep-link browsers (3/3), and the complete repository suite remain green.

### Phase 6A provenance correction — 2026-09-01

- [x] Classify only through exact repository fixture identities, development-only allowlists, and reserved harness domains; never infer test or real provenance from record shape.
- [x] Classify 28 users, 32 Jobs, 32 Cases, and 36 Applications as known test data.
- [x] Leave 125 users and one Job/Case/Application workflow unknown because no affirmative real/test marker exists.
- [x] Separate test cleanup from compatibility retirement: all material Application mirror defects are test residue.
- [x] Identify mountain themes as the only owner-confirmed real-user migration blocker.
- [x] Keep Job/Case, application mirrors, aliases, themes, and redirects unchanged pending their independent gates.

---

## Phase 6B — Dashboard V2 design completion

### State-adaptive composition

- [x] Preserve the approved white Private Office canvas, restrained navy/gold palette, flat surfaces, global header, and global sidebar.
- [x] Keep the large navy work surface for active Matters, where work items, files, activity, deadlines, and actions justify its size.
- [x] Reduce setup and no-active-work surfaces without presenting recommendations as assigned work.
- [x] Keep payout setup and matching-profile setup as the single authoritative action inside their desk state.
- [x] Keep recommendations exclusively in Matter folios and retain the approved compact empty recommendation copy.
- [x] Collapse the no-application state to one row while retaining the full application progress strip when an application exists.
- [x] Retain Calendar, Office inbox, and the Released work compensation ribbon with their existing data and actions.

### Responsive and motion completion

- [x] Give the mobile greeting and action controls separate full-width rows so the summary cannot be squeezed into a narrow text column.
- [x] Preserve supported-width touch targets and prevent horizontal overflow at 320px through 1920px.
- [x] Remove the desk-entry animation that could replay during verified data enrichment or refresh and resemble a loading blink.
- [x] Forward desktop wheel and trackpad gestures from the fixed sidebar to the active route scroll owner; acknowledge genuinely non-scrollable views with restrained motion that is disabled under reduced-motion preferences.
- [x] Preserve reduced-motion behavior and keyboard/focus interaction.

### Completion gate

- [x] Deterministic setup, empty, recommended, active, application, invitation, review, revision, completed, unavailable, and failure states remain composed.
- [x] Private Office accessibility, responsive geometry, stale-response protection, availability authority, and tab-stability contracts pass in Chromium, Firefox, and WebKit (24/24).
- [x] No lifecycle, recommendation, eligibility, availability, payment, authorization, schema, or compatibility behavior changed.

### Account Settings visual completion

- [x] Retain Profile, Security, Preferences, and Help with every existing field, action, and account behavior.
- [x] Replace the fixed-height profile poster and nested scroll regions with a compact professional identity panel and normal page scrolling.
- [x] Present profile details, security controls, and preferences as one consistent white, navy, and blue-gray account system without shadows.
- [x] Keep security and preference controls grouped, readable, and responsive without changing their authority or persistence.
- [x] Reset category navigation to the page top without rebuilding the shell or introducing a transition blink.
- [x] Preserve the Browse Matters header and Home sidebar presentation at desktop and mobile widths.
- [x] Pass Account Settings visual, accessibility, overflow, header, sidebar, and category-navigation contracts in Chromium, Firefox, and WebKit.
- [x] Use the Home navigation globally and keep Profile, Security, and Preferences as in-page Account Settings categories.
- [x] Make preference persistence consistently automatic, field-isolated, sequenced, recoverable, and visibly acknowledged.
- [x] Normalize stored retired theme values to the supported light/dark presentation without exposing retired theme names or deleting unrelated preferences.
- [x] Make payout-readiness copy state-aware and explain profile-visibility locks.
- [x] Give two-step verification, backup codes, and passkeys one shared security-verification step.
- [x] Surface profile dirty/saved state and protect unsaved profile edits during navigation.

### Global Search interaction refinement

- [x] Restore the header interaction in which the magnifying glass expands into the actual search input on hover or focus.
- [x] Keep typing in the persistent header rather than moving the input into a dropdown or routed Search page.
- [x] Keep the results surface closed until at least two characters are entered.
- [x] Preserve authorized Matter-only results, stale-request cancellation, user-scoped history, keyboard navigation, and no-remount destinations.
- [x] Use `No results.` for the empty result state.
- [x] Verify inline expansion, keyboard access, result routing, and responsive bounds in Chromium, Firefox, and WebKit.

---

## Dashboard V2 Phase 7 — Matter workspace read-only foundation

- [x] Recreate the Matter overview, work items, files and submissions, messages, history, and financial presentation inside the persistent V2 shell.
- [x] Use the existing authorized Case and Matter-experience projections as the source of truth.
- [x] Keep the workspace read-only and introduce no lifecycle, schema, payment, or authorization changes.
- [x] Preserve active, completed, archived, missing, forbidden, stale-session, and loss-of-access behavior.
- [x] Route active and historical Matter links internally without remounting the shell.
- [x] Verify required widths, Assistant-open containment, accessibility, and Chromium/Firefox/WebKit behavior.

## Dashboard V2 Phase 8 — Matter workspace mutations

- [x] Connect text-message sending and read acknowledgement; verify stale access, blocks, unread counts, notifications, multi-tab synchronization, cross-role visibility, responsive containment, and server-confirmed refreshes. See `docs/PARALEGAL_V2_PHASE8A_MESSAGING.md`.
- [x] Connect file upload, scan-status, list, and download actions; verify authorization, metadata, retry safety, deep links, multi-tab synchronization, cross-role visibility, historical closure, and revoked-access behavior. Submission-state changes remain in the later submissions/revisions group. See `docs/PARALEGAL_V2_PHASE8B_FILES.md`.
- [x] Connect deadline actions and verify lifecycle eligibility, notifications, stale actions, and cross-role visibility. See `docs/PARALEGAL_V2_PHASE8C_DEADLINES.md`.
- [x] Connect submissions and revisions without inventing statuses or bypassing existing authority. See `docs/PARALEGAL_V2_PHASE8D_SUBMISSIONS.md`.
- [x] Connect approval and completion status without changing payment behavior or granting paralegals attorney-only controls. See `docs/PARALEGAL_V2_PHASE8E_COMPLETION.md`.
- [x] Verify idempotency, stale-action rejection, multi-tab behavior, notifications, deep links, and attorney/paralegal/admin reconciliation after each mutation group.

## Dashboard V2 Phase 9 — Full acceptance candidate gates

### Characterization coverage required before cleanup

- [x] Home state-adaptive presentation.
- [x] Recommendation matching and historical exclusion.
- [x] Browse-versus-recommendation eligibility differences.
- [x] Application submission, withdrawal, rejection, shortlisting, invitation, acceptance, and hiring.
- [x] Active/completed Matter visibility and direct links.
- [x] Messages, files, deadlines, submissions, revisions, approvals, unread counts, and badges.
- [x] Availability and profile/payout setup blockers.
- [x] Block, restriction, logout, stale session, and loss-of-access behavior.
- [x] Attorney/paralegal/admin projection consistency.
- [x] Assistant access to account and Matter workspace information.

The definitive V1-to-V2 capability comparison and legacy-retirement gates are recorded in `docs/PARALEGAL_V2_PARITY_AUDIT.md`.

### Frontend quality gates

- [x] No first-paint shell reconstruction.
- [x] No visible blinking or geometry changes during navigation.
- [x] No page-level scroll lock when the Assistant is open unless a true modal is active.
- [x] No clipped header, sidebar, search, account controls, dialogs, or content at supported widths.
- [x] No duplicate IDs, unresolved TOC/deep links, or hidden focusable controls.
- [x] WCAG contrast, labels, focus visibility, focus trapping, and reduced-motion behavior pass.
- [x] Chromium, Firefox, and WebKit accessibility matrices pass with no new skips.
- [x] Performance budgets pass without increasing thresholds to accommodate duplicate code.

### Repository gates

- [x] Targeted backend and browser contracts pass after each phase.
- [x] The complete suite passes under the repository-pinned Node and npm versions before each checkpoint.
- [x] Existing unrelated user changes are preserved and excluded from phase commits.
- [ ] Each phase receives a dedicated checkpoint commit only after its verification is green.
- [x] No deployment or production mutation occurs without separate authorization.

---

## Decisions required

- [!] Should withdrawn applications appear in visible application history?
- [x] Public Help remains available, and signed-in V2 Help remains inside the persistent application shell (superseding decision recorded 2026-09-03 after owner approval of the V2 rebuild plan).
- [x] `Case` is lifecycle/workspace authority; `Job` remains the current discovery projection until independent retirement gates pass (recorded 2026-09-01).
- [x] `Application` is application-history authority; `Case.applicants` remains the current-candidate projection until consumer migration (recorded 2026-09-01).
- [!] When may legacy themes and compatibility redirects be deprecated?

Record each decision here with its date, owner, rationale, and linked implementation/checkpoint before dependent work begins.

## Progress log

| Date | Phase | Status | Summary | Verification / checkpoint |
| --- | --- | --- | --- | --- |
| 2026-08-31 | Audit | Complete | Repository-wide read-only inventory of remaining paralegal V2 styling, logic duplication, and compatibility layers. | No production behavior changed. |
| 2026-09-01 | Dashboard V2 design completion | Complete | Finished state-adaptive Home density, mobile header composition, compact empty applications, and refresh-stable work-surface presentation. | Paralegal browser regression 75/75 across Chromium, Firefox, and WebKit; Jest 193/193 suites and 1,464/1,464 tests; performance 4,871.9 KiB within budget. |
| 2026-09-01 | Account Settings visual completion | Complete | Reframed Profile, Security, and Preferences as one compact professional account system with normal page scrolling, consistent grouped controls, responsive composition, and preserved categories/actions. | Account Settings and affected accessibility/header contracts passed 15/15 across Chromium, Firefox, and WebKit after the contrast correction; Jest 193/193 suites (1,464/1,464 tests) passed under Node 24.18.0; performance 4,889.6 KiB within budget. |
| 2026-09-01 | Account Settings behavior completion | Complete | Unified field-isolated automatic preference saving with visible recovery, restored legacy-theme representation, aligned the paralegal sidebar with Home, clarified payout/visibility authority, consolidated security verification, and added profile dirty-state protection. | Affected browser contracts 24/24 across Chromium, Firefox, and WebKit; Jest 193/193 suites (1,466/1,466 tests) under Node 24.18.0; performance 4,900.6 KiB within budget. |
| 2026-09-01 | Account Settings correction audit | Complete | Corrected stale-draft authority, programmatic dirty tracking, field-isolated preference recovery, all four stored theme projections, dark-shell contrast, mobile account-menu focus, real section deep links, and first-paint hydration contracts. Removed obsolete preference-save styling and preserved existing role-specific layouts. | Final uninterrupted paralegal matrix 102/102 across Chromium, Firefox, and WebKit; browser contracts passed; complete Jest 193/193 suites and 1,469/1,469 tests under Node 24.18.0/npm 11.16.0; static frontend, binding, API, performance, legal, and no-theater gates passed. |
| 2026-08-31 | Phase 1 | Complete | Shared authenticated shell is present before first paint; header, sidebar identity, navigation geometry, mobile drawer, search, notifications, and Assistant space remain stable across routes and supported widths. Full-screen hydration hiding was removed from Home and Account Settings. | Static shell contract plus Chromium, Firefox, and WebKit responsive/accessibility verification. Hidden legacy compatibility is preserved for Phase 2/5 removal gates. |
| 2026-08-31 | Phase 2 | Complete | Removed characterized dead Home controls and styles, established one Home dashboard-request owner, shared its normalized snapshot with My Matters, and added stale-response protection without changing lifecycle or recommendation rules. | 69/69 paralegal browser tests and 189/189 Jest suites (1,428/1,428 tests) passed under Node 24.18.0. Payload improved to 7,332.0 KiB; the inherited 7,168.0 KiB budget overage remains tracked. |
| 2026-08-31 | Phase 3 | Complete | Made the server the sole recommendation-ranking authority, preserved permanent historical-application exclusions, centralized experience parsing, removed authenticated Browse session-storage authority, and documented the active-application presentation policy. | 69/69 paralegal browser tests and 190/190 Jest suites (1,444/1,444 tests) passed under Node 24.18.0. Syntax and API contracts passed. Payload improved to 7,325.4 KiB; the inherited budget overage and five pre-existing frontend-binding findings remain tracked. |
| 2026-09-01 | Phase 4 | Complete | Consolidated application eligibility and Stripe payout readiness, made Browse consume the server policy projection, removed stale Stripe session-cache authority, centralized development-only Connect bypasses, and made cross-tab availability refresh from the server. Availability remains a non-blocking profile/discovery signal. | 72/72 paralegal browser tests passed across Chromium, Firefox, and WebKit; 191/191 Jest suites (1,452/1,452 tests) passed under Node 24.18.0/npm 11.16.0. Payload is 7,324.6 KiB; the inherited 7,168.0 KiB budget remains unchanged. |
| 2026-09-01 | Phase 5 | Complete | Added the shared white/no-shadow LPC component layer across Browse, My Matters, the Matter workspace, Profile, and Account Settings; standardized legacy dialog presentation; removed the superseded Assistant skin; made attorney-only settings code role-owned; and retained public-style Help. Characterized structural CSS and the large shared settings controller remain explicitly reserved for Phase 6 retirement. | 75/75 paralegal browser tests passed across Chromium, Firefox, and WebKit; 192/192 Jest suites (1,458/1,458 tests) passed under Node 24.18.0/npm 11.16.0. Performance passes at 4,870.2 KiB without raising the 7,168.0 KiB budget. |
| 2026-09-01 | Phase 6 | Superseded by 6A | Initial aggregate audit established totals but incorrectly treated test-generated Matter/Application residue as customer-history migration evidence. | No compatibility was removed or migrated. |
| 2026-09-01 | Phase 6A | Complete | Reclassified production compatibility evidence using only exact fixture identities, development allowlists, and reserved harness domains. All material application-mirror defects are known test residue. Mountain themes are owner-confirmed real-user blockers; Job/Case, aliases, and redirects remain unknown or unmeasured. | Aggregate-only production read; provenance contract 6/6 and complete Jest 193/193 suites (1,464/1,464 tests) passed under Node 24.18.0/npm 11.16.0. No writes, identifiers, Stripe access, migration, deployment, or compatibility removal. |
| 2026-09-03 | Dashboard V2 Phase 6 | Complete locally | Added authenticated routed Help, inline expanding server-authorized Matter search, authoritative live notifications, and the existing permission-aware LPC Assistant to the persistent V2 shell without introducing new lifecycle or authorization rules. Search keeps its input in the header and opens results only after a query begins. | Targeted Jest 12/12 suites (236/236 tests); complete Jest 200/200 suites (1,525/1,525 tests) under Node 24.18.0; V2 browser matrix 90/90 across Chromium, Firefox, and WebKit; post-review Search contracts 29/29 Jest assertions and all focused cross-browser interaction checks passed. Uncommitted and not deployed. |
| 2026-09-03 | Dashboard V2 Phase 7 | Complete locally | Added the authorized read-only Matter workspace inside the persistent V2 shell, including overview, work, files and submissions, messages, history, financials, and safe unavailable/access-loss states. | Complete Jest 201/201 suites (1,530/1,530 tests) under Node 24.18.0; Phase 7 browser matrix 18/18 across Chromium, Firefox, and WebKit; integrated Chromium V2 regression 27/27. Uncommitted and not deployed. |
| 2026-09-03 | Dashboard V2 Phase 8A | Complete locally | Connected Matter text messaging and read acknowledgement to the existing authority with server-confirmed refreshes, draft preservation, stale-access handling, and open-tab synchronization. | Complete Jest 202/202 suites (1,536/1,536 tests) under Node 24.18.0; Phase 8A browser matrix 18/18 across Chromium, Firefox, and WebKit. Uncommitted and not deployed. |
| 2026-09-03 | Dashboard V2 Phase 8B | Complete locally | Connected authorized active-Matter file listing, upload, scan-status checks, and download inside the persistent V2 shell. Preserved historical read-only metadata and excluded deletion, submission/revision/approval, deadline, completion, and payment mutations. | Complete Jest 203/203 suites (1,541/1,541 tests) under Node 24.18.0/npm 11.16.0; integrated Phase 7/8A/8B browser matrix 54/54 across Chromium, Firefox, and WebKit; static and performance gates passed. Uncommitted and not deployed. |
| 2026-09-03 | Dashboard V2 Phase 8C | Complete locally | Separated the shared read-only Matter deadline from owner-private Event reminders; connected server-confirmed reminder create/edit/delete, Home merge and cross-tab refresh without inventing a completion status or alert behavior. | Complete Jest 205/205 suites (1,551/1,551 tests) under Node 24.18.0/npm 11.16.0; integrated Phase 7/8A/8B/8C browser matrix 72/72 across Chromium, Firefox, and WebKit; static and performance gates passed. Uncommitted and not deployed. |
| 2026-09-03 | Dashboard V2 Phase 8D | Complete locally | Connected paralegal submissions and revision-response presentation to the existing CaseFile authority, added explicit submission confirmation, preserved exact file states and server-owned versioning, and synchronized changed evidence across Matter, Home, and My Matters without adding a lifecycle state. | Complete Jest 207/207 suites (1,560/1,560 tests) under Node 24.18.0/npm 11.16.0; focused lifecycle contracts 14/14; Phase 8D browser matrix 21/21; integrated Phase 7/8A/8B/8C/8D browser matrix 93/93 across Chromium, Firefox, and WebKit; static and performance gates passed. Uncommitted and not deployed. |
| 2026-09-03 | Dashboard V2 Phase 8E | Complete locally | Connected attorney-owned task review and Matter-completion handoff to the paralegal Work section, added live task/Case revalidation, and preserved completion access loss and completed history without exposing attorney or payment mutations. | Complete Jest 209/209 suites (1,567/1,567 tests) under Node 24.18.0; focused contracts 24/24; Phase 8E Matter browser matrix 24/24; integrated Phase 7/8A/8B/8C/8D/8E browser matrix 99/99 across Chromium, Firefox, and WebKit; static and performance gates passed. Uncommitted and not deployed. |
| 2026-09-03 | Dashboard V2 Phase 9 | Acceptance candidate | Completed the uninterrupted full paralegal acceptance matrix and reconciled two obsolete Search-role assertions without changing product behavior. Verified the entire persistent-shell journey, state projections, workflow mutations, responsive composition, accessibility, stale access, and cross-tab behavior. | Paralegal Playwright 321/321 across Chromium, Firefox, and WebKit with no skips/flakes; Jest 209/209 suites (1,567/1,567 tests); browser contracts and applicable static gates passed. `check:focus` retains two documented pre-existing public-suite conditional skips. Uncommitted and not deployed. |
| 2026-09-04 | V1-to-V2 capability parity audit | Complete locally | Traced every intended paralegal capability from identity through discovery, applications, Matter collaboration, files, messaging, deadlines, submissions, completion, history, payments, global tools, and access loss. Corrected retained active-Matter aliases, résumé readiness, autosave recovery, message read-watermark remount behavior, Assistant/Matter bounds, cross-process refresh delivery, and silent recovery paths. V1 remains in place pending the separately authorized cutover/rollback rehearsal. | Complete Jest 213/213 suites (1,645/1,645 tests) under Node 24.18.0/npm 11.16.0; uninterrupted paralegal Playwright 381/381 across Chromium, Firefox, and WebKit with `--fail-on-flaky-tests`; static syntax, hygiene, API, binding, route, no-theater, and performance gates passed. Uncommitted and not deployed. |
