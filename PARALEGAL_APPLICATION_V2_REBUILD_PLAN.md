# LPC Paralegal Application V2 Rebuild Plan

Status: **Phases 0–9 are implemented locally and remain uncommitted and undeployed. Capability parity is audited in `docs/PARALEGAL_V2_PARITY_AUDIT.md`; route cutover, rollout rehearsal, and legacy retirement remain unapproved.**

Prepared: September 2, 2026

Scope: Paralegal authenticated frontend, including the Matter workspace

Strategy: New persistent frontend shell over the existing LPC backend and data

## 1. Current decision boundary

The owner approved and reviewed implementation through the local Phase 9 acceptance candidate. The requirements checkboxes below preserve the original build specification and are not the current completion ledger; current implementation evidence lives in `PARALEGAL_V2_CLEANUP_CHECKLIST.md`, the Phase 0–9 documents, and `docs/PARALEGAL_V2_PARITY_AUDIT.md`.

A separate review and authorization are still required for route cutover, any non-production or production rollout, compatibility removal, V1 retirement, production data work, or deployment.

The proposed V2 is a presentation-layer rebuild. It is **not** a rebuild of LPC's database, lifecycle, payment system, authorization system, or backend services. The 100+ existing paralegal accounts and all associated records remain authoritative and must load through the current APIs.

No task in this document is permission to deploy, access production data, migrate records, delete compatibility code, or switch users. Each release or production step requires separate authorization.

## 2. Why a clean frontend rebuild is recommended

The current paralegal experience is distributed across large independent HTML documents with page-specific CSS, initialization, hydration, navigation, and state ownership. Home, Browse Matters, Profile Settings, Help, and the Matter workspace reconstruct common interface elements independently. This creates:

- full-document navigation rather than persistent application navigation;
- visible first-paint and hydration changes;
- duplicate sidebar, header, menu, search, notification, and Assistant setup;
- inconsistent content rails, widths, gutters, and scroll owners;
- page-specific loading behavior that can affect the entire screen;
- duplicated event bindings and late role/theme styling;
- higher regression risk every time a shared element is changed;
- difficulty preserving view state while users move between tasks.

V2 should use one persistent application shell. Only the central routed view changes. Shared controls remain mounted.

## 3. Binding source-of-truth documents

V2 must consume—not reinterpret—the current behavior documented and tested in:

- `DOMAIN_LIFECYCLE_INVENTORY.md`
- `DASHBOARD_VISIBILITY_MATRIX.md`
- `SCENARIO_COVERAGE_REPORT.md`
- `DUPLICATED_RULES_AND_RISKS.md`
- `PARALEGAL_TEST_CHECKLIST.md`
- `PARALEGAL_V2_CLEANUP_CHECKLIST.md`
- `PHASE6_COMPATIBILITY_RETIREMENT_REPORT.md`
- `docs/PARALEGAL_ASSISTANT_HARDENING_CHECKLIST.md`
- `docs/paralegal-assistant/DATA_PERMISSION_MATRIX.md`
- `docs/paralegal-assistant/RESPONSE_CONTRACT.md`
- `docs/paralegal-assistant/SOURCE_OF_TRUTH_MATRIX.md`
- `docs/paralegal-assistant/WORKFLOW_POLICY_INVENTORY.md`
- `docs/paralegal-assistant/RISK_REGISTER.md`
- `docs/RELEASE_GATES.md`
- `ROLLBACK_PLAN.md`
- `docs/PARALEGAL_V2_PARITY_AUDIT.md`

If code, tests, and a document disagree, work stops until the authoritative existing behavior is identified. V2 must not silently choose a new interpretation.

## 4. Non-negotiable preservation rules

### 4.1 Existing people and profile data

- [ ] Preserve every existing paralegal account identifier.
- [ ] Preserve names, email addresses, phone numbers, avatars, pending photos, and photo-review status.
- [ ] Preserve biographies, years of experience, education, certifications, publications, skills, languages, state experience, practice areas, and availability.
- [ ] Preserve uploaded resumes, supporting documents, metadata, review state, and storage references.
- [ ] Preserve account approval, restriction, deactivation, deletion, and onboarding state.
- [ ] Preserve security settings, MFA/passkey state, active sessions, and blocked-user relationships.
- [ ] Preserve notification and communication preferences.
- [ ] Preserve unknown or older fields returned by existing APIs; V2 must not erase fields it does not render.
- [ ] Never replace a complete profile update with a partial payload that clears omitted fields.
- [ ] Never use production user data for development fixtures or visual tests.

### 4.2 Existing work and financial history

- [ ] Preserve applications, withdrawals, rejections, shortlists, and invitations.
- [ ] Preserve active, completed, cancelled, expired, unpublished, and archived Matter visibility exactly as currently authorized.
- [ ] Preserve messages, unread state, files, deadlines, submissions, revisions, approvals, and audit history.
- [ ] Preserve attorney funding, paralegal payouts, refunds, disputes, chargebacks, payout holds, and reconciliation evidence.
- [ ] Preserve original `PlatformIncome`, `PaymentOperation`, and `FinancialAdjustment` evidence.
- [ ] Do not create, rename, merge, or reinterpret lifecycle statuses.
- [ ] Do not trigger a charge, transfer, payout, refund, dispute action, or Stripe mutation during frontend development or migration testing.

### 4.3 Compatibility behavior

- [ ] Preserve `Job`/`Case` compatibility until separately proven removable.
- [ ] Preserve `Application`/`Case.applicants` compatibility until separately proven removable.
- [ ] Preserve identity, profile, state, practice-area, and status aliases still accepted by current APIs.
- [ ] Preserve legacy redirects until usage is measured or a separately approved retirement plan exists.
- [ ] Do not restore retired Mountain themes.
- [ ] Normalize retired theme preferences to the current supported visual default at presentation time without deleting unrelated preferences.

## 5. Explicit non-goals

The V2 frontend project must not:

- rewrite backend business logic;
- change MongoDB schemas merely for frontend convenience;
- introduce new lifecycle statuses;
- alter recommendation eligibility;
- alter application, invitation, hiring, funding, completion, dispute, or payment policy;
- remove historical records;
- perform a production backfill;
- modify Stripe configuration or payment behavior;
- redesign the attorney or admin applications;
- expose confidential Matter content to LPC Assistant beyond its current permission contract;
- combine Stripe chargebacks with LPC work-quality disputes;
- make the public website part of the authenticated application shell;
- retire the current paralegal frontend before V2 acceptance and rollback verification.

## 6. Target application architecture

```text
Paralegal V2 application entry
├── Authentication/session boundary
├── Persistent application shell
│   ├── Sidebar
│   ├── Account/profile control
│   ├── Universal header
│   ├── Search
│   ├── Notifications
│   ├── LPC Assistant drawer
│   ├── Global dialogs/toasts
│   └── Routed content viewport
│       ├── Home
│       ├── Browse Matters
│       ├── My Matters & Applications
│       ├── Profile Settings
│       ├── Help
│       ├── Public paralegal profile preview
│       └── Matter workspace
└── Shared API, cache, state, accessibility, and telemetry services
```

### 6.1 Architectural rules

- [x] Create one V2 HTML entry and one bootstrap path.
- [x] Mount the sidebar, header, search, notifications, Assistant, and global feedback layers once.
- [x] Use client-side routing for authenticated paralegal destinations.
- [x] Change only the content viewport during ordinary navigation.
- [x] Keep real URLs and browser history; do not use fake tabs with inaccessible state.
- [x] Support direct entry and refresh on every implemented V2 route.
- [x] Support Back and Forward without resetting the application shell.
- [x] Preserve a separate scroll position for each primary view.
- [ ] Preserve unsaved drafts when users temporarily change views.
- [ ] Prompt before genuinely destructive navigation away from unsaved work.
- [x] Use route-level error boundaries so one failed view cannot blank the shell.
- [x] Use view-level loading states; never replace the whole screen with a loader.
- [x] Prevent duplicate API calls and duplicate event listeners during route changes.
- [x] Cancel or disregard stale requests when the active user, route, or Matter changes.
- [x] Keep a single source of truth for authenticated role, account status, theme, and font size.
- [x] Keep a single source of truth for badges and unread counts.
- [x] Keep a single source of truth for availability.
- [x] Keep a single source of truth for modal and drawer layering.

## 7. Route and deep-link plan

Final route names must be approved before implementation. The router must support mappings for at least:

| Destination | V2 route responsibility | Existing entry to preserve |
|---|---|---|
| Home | Paralegal dashboard overview | `dashboard-paralegal.html#home` |
| My Matters & Applications | Active/completed Matters and application history | `dashboard-paralegal.html#cases` |
| Browse Matters | Filters, results, details, and apply action | `browse-jobs.html` |
| Profile Settings | Profile, Security, Preferences | `profile-settings.html` |
| Help | Paralegal help and issue reporting | `paralegalhelp.html` |
| Profile preview | Attorney-visible paralegal profile | `profile-paralegal.html?paralegalId=...` |
| Matter workspace | Authorized Matter collaboration | `case-detail.html?caseId=...` |

- [ ] Decide whether V2 uses `/app/paralegal/...`, another path, or feature-flagged existing paths.
- [ ] Map every current paralegal deep link to an equivalent V2 route.
- [ ] Preserve query parameters used for Matter IDs, highlighted records, invitations, notifications, completed Matters, and setup returns.
- [ ] Preserve external links from emails and notifications.
- [ ] Preserve refresh behavior on nested routes.
- [ ] Preserve unauthorized, missing, expired, archived, and forbidden deep-link outcomes.
- [ ] Ensure attorney-only or admin-only routes never mount in the paralegal router.
- [ ] Add route-not-found handling inside the shell without disguising authorization failures.
- [ ] Define canonical URLs and prevent redirect loops.
- [ ] Verify old URLs remain valid throughout rollout and rollback.

## 8. Persistent shell work

### 8.1 Sidebar

- [ ] Reproduce the approved Home sidebar exactly once.
- [x] Include Home, Browse Matters, My Matters & Applications, Profile Settings, and Help.
- [ ] Keep icon size, label position, row height, spacing, and content groups identical across routes.
- [ ] Keep the selected destination unfilled with the approved darker cornflower-blue text.
- [ ] Keep the profile cluster unfilled and shadow-free.
- [ ] Load the cached user name and valid avatar before first paint.
- [ ] Handle unavailable images without a broken-image flash.
- [ ] Keep the account menu in one portal/layer.
- [ ] Preserve Settings, profile access, and Sign out behavior.
- [ ] Preserve collapse/expand behavior at desktop widths if retained.
- [ ] Preserve the accessible mobile menu and backdrop.
- [ ] Keep the menu control at least 44 by 44 CSS pixels.
- [ ] Preserve focus return, Escape handling, `aria-expanded`, `aria-controls`, and inert background behavior.
- [ ] Never rebuild or remeasure the sidebar during route changes.

### 8.2 Universal header

- [ ] Reproduce the approved Browse Matters header exactly once.
- [ ] Keep its height, border, white background, padding, and control alignment fixed.
- [x] Keep Search, Notifications, and Assistant mounted.
- [x] Keep Search compact until activated.
- [x] Prevent Search from changing the header's height or shape.
- [x] Render the search results layer in a stable overlay.
- [x] Keep notification count and panel state consistent across routes.
- [x] Keep Assistant state when the user changes views.
- [ ] Reserve all control dimensions before first paint.
- [ ] Never insert, remove, or relocate header controls during route hydration.

### 8.3 Shared content frame

- [ ] Define one desktop content rail, maximum workspace width, and responsive gutter system.
- [ ] Define one top offset beneath the persistent header.
- [ ] Align every primary view to that frame.
- [ ] Permit narrower inner reading widths without changing the outer anchor.
- [ ] Use one content scroll owner.
- [ ] Prevent the browser body and nested content areas from competing for scroll.
- [ ] Preserve route-specific scroll positions.
- [ ] Prevent scrollbar appearance from moving the page horizontally.
- [ ] Keep white page backgrounds unless a deliberately approved component uses navy.

### 8.4 Global feedback and overlays

- [ ] Build one toast/status region with deduplication.
- [ ] Build one accessible dialog host.
- [ ] Build one confirmation pattern.
- [ ] Build one destructive-action pattern.
- [ ] Build one upload/progress pattern.
- [ ] Build one empty, unavailable, permission-denied, and retry pattern.
- [ ] Remove photographic legacy completion modals from V2.
- [ ] Use the approved flat, shadow-free LPC modal treatment.
- [ ] Lock background scroll only while a modal requires it.
- [ ] Restore focus to the initiating control when overlays close.

## 9. Shared frontend services

### 9.1 Authentication and session

- [ ] Reuse current secure cookie/session behavior.
- [ ] Verify the authenticated user before mounting protected data.
- [ ] Render the cached shell identity without treating cache as authorization.
- [ ] Revalidate role, approval, restriction, and disabled/deleted state.
- [ ] Centralize deactivation and loss-of-access handling.
- [ ] Stop protected requests after session loss.
- [ ] Clear confidential cached view data on logout or account change.
- [ ] Prevent Back/Forward cache from exposing a previous user's protected content.
- [ ] Synchronize logout, deactivation, and restrictions across tabs.
- [ ] Preserve CSRF behavior for every mutation.

### 9.2 API client

- [ ] Wrap the current endpoints without changing their server contracts.
- [ ] Use one credentials, CSRF, error, retry, and cancellation policy.
- [ ] Classify authentication, authorization, validation, conflict, unavailable, and network failures distinctly.
- [ ] Never automatically retry non-idempotent actions.
- [ ] Attach idempotency evidence where current APIs require it.
- [ ] Abort or ignore stale route and Matter requests.
- [ ] Prevent a late response from one Matter overwriting another Matter's view.
- [ ] Preserve exact cents and server-formatted financial evidence.
- [ ] Never infer missing payment state in the browser.

### 9.3 Query and cache layer

- [ ] Define cache keys that include user identity, route, Matter ID, filters, and relevant lifecycle scope.
- [ ] Deduplicate concurrent reads.
- [ ] Distinguish fresh, stale, loading, refreshing, empty, forbidden, and failed states.
- [ ] Keep previously valid content visible during safe background refreshes.
- [ ] Invalidate only affected data after mutations.
- [ ] Synchronize application, invitation, message, deadline, and Matter updates across relevant views.
- [ ] Reconcile notification-driven updates without creating duplicates.
- [ ] Clear user-specific cache on logout/account switch.
- [ ] Define offline and reconnect behavior without pretending stale financial state is current.

### 9.4 Form and draft framework

- [ ] Standardize field labels, help, validation, required state, and error placement.
- [ ] Track pristine, dirty, saving, saved, failed, and conflict states.
- [ ] Support debounced autosave for appropriate profile fields.
- [ ] Flush pending autosave on blur and before safe navigation.
- [ ] Do not autosave invalid values.
- [ ] Do not overwrite newer server changes with stale drafts.
- [ ] Use field- or section-level patches where supported.
- [ ] Preserve unknown fields and avoid destructive replacement payloads.
- [ ] Retain explicit confirmation for photo crops, document uploads, password changes, MFA changes, blocking, withdrawals, submissions, approvals, and financial-impacting actions.
- [ ] Provide visible `Saving…`, `Saved`, and actionable failure feedback.

## 10. Home view

- [ ] Recreate the approved white Home composition.
- [ ] Keep the compact action row with `On your desk`, Availability, and Browse Matters aligned.
- [ ] Do not restore the Welcome heading or `Private office` eyebrow.
- [ ] Keep the approved navy work surface for active work and setup actions.
- [ ] Keep recommendations out of `On your desk`.
- [ ] Make incomplete profile or payout setup the single authoritative setup action when applicable.
- [ ] Preserve state-adaptive density.
- [ ] Preserve active-Matter switching without duplicate refreshes.
- [ ] Preserve deadlines in `Next seven days` / `Calendar`.
- [ ] Preserve incoming invitations, messages, and required actions in `Office inbox`.
- [ ] Preserve recommendation folios under `Selected for you` / `Matter folios`.
- [ ] Preserve compact no-recommendation behavior and Browse Matters action.
- [ ] Preserve application progress only when an active application exists.
- [ ] Preserve the compact no-application row.
- [ ] Preserve the navy `Released work` compensation ribbon and readable contrast.
- [ ] Preserve authoritative compensation periods and amounts.
- [ ] Prevent initial placeholders from cycling through multiple visible states.
- [ ] Never show a recommendation as assigned or active work.
- [ ] Never show a withdrawn/rejected/inactive historical application as a new recommendation.
- [ ] Keep loading and errors local to the affected Home region.

## 11. Availability

- [ ] Preserve the existing availability authority and fields.
- [ ] Preserve availability status, next available date, and current summary behavior.
- [ ] Keep the approved blue hover treatment.
- [ ] Use one dialog/dropdown design consistent with V2.
- [ ] Validate dates and status combinations before mutation.
- [ ] Show confirmed server state after saving.
- [ ] Handle conflict, stale session, restriction, and network failure.
- [ ] Synchronize the Home control and any Profile representation.
- [ ] Preserve keyboard, touch, focus, and screen-reader behavior.

## 12. Browse Matters view

- [ ] Recreate the approved Browse Matters visual hierarchy inside the persistent shell.
- [ ] Preserve all current eligibility and browse behavior.
- [ ] Preserve practice-area, state, compensation, deadline, and date-posted filters.
- [ ] Preserve sorting.
- [ ] Preserve filter defaults, clear action, and update behavior.
- [ ] Decide whether filters update immediately or on explicit action; do not mix both silently.
- [ ] Store filter state in the route so Back/Forward and deep links behave predictably.
- [ ] Preserve result count and pagination/infinite-loading behavior as currently authoritative.
- [ ] Preserve Matter cards and expanded detail behavior.
- [ ] Keep `Details` as the detail action label.
- [ ] Preserve profile-completion and payout-setup application gates.
- [ ] Preserve existing application/invitation/history exclusion logic.
- [ ] Preserve blocks and account restrictions.
- [ ] Preserve no-results, no-eligible-results, unavailable, and retry distinctions.
- [ ] Avoid language implying a paralegal is eligible only within a matching state or practice area.
- [ ] Prevent an already historically applied-to Matter from reappearing as a recommendation.
- [ ] Prevent duplicate applications from fast clicks, multiple tabs, retries, or stale results.
- [ ] Refresh only affected result cards after an application action.

## 13. My Matters & Applications view

- [ ] Recreate active Matters, completed Matters, applications, and invitations in one coherent routed view.
- [ ] Preserve authoritative grouping and status labels.
- [ ] Preserve pagination and saved-view/filter behavior.
- [ ] Preserve highlighted Matter/application deep links.
- [ ] Preserve withdrawn-paralegal history where currently available.
- [ ] Preserve receipt/download actions.
- [ ] Preserve dispute-window language and eligibility.
- [ ] Preserve block controls and Settings management links.
- [ ] Preserve invitation accept/decline preconditions.
- [ ] Preserve application withdrawal/revoke preconditions and confirmation.
- [ ] Prevent optimistic UI from inventing a state before the server confirms it.
- [ ] Reconcile Home application progress after application changes.
- [ ] Reconcile Browse eligibility after application changes.
- [ ] Reconcile active Matter counts and notification badges after hiring/completion.
- [ ] Keep loading and errors local to the affected list.

## 14. Profile Settings view

### 14.1 Shared settings structure

- [x] Preserve Profile, Security, and Preferences categories.
- [x] Keep one visual system and one scroll owner.
- [x] Preserve category route/deep-link state.
- [x] Prevent category switching from remounting the shell or resetting unrelated state.
- [x] Preserve keyboard tab behavior and visible focus.
- [x] Keep all controls reachable at every supported viewport.

### 14.2 Professional profile

- [x] Load every current profile field and document reference.
- [x] Preserve the upgraded professional visual design.
- [x] Keep profile readiness compact and secondary when the profile is otherwise usable.
- [x] Hide readiness when fully ready if that remains the approved behavior.
- [x] Open photo actions by activating the profile photo.
- [x] Do not restore permanent Edit Photo and Remove Photo buttons.
- [x] Preserve photo crop, upload, remove, pending-review, rejection, and fallback behavior.
- [x] Preserve attorney-visible profile preview.
- [x] Add debounced autosave for bio, experience, skills, practice areas, states, languages, contact fields, and other safe profile metadata.
- [x] Keep explicit actions for photo and document upload/removal.
- [x] Show section-level save status without consuming excessive space.
- [x] Preserve draft recovery only when it is newer and clearly identified.
- [x] Prevent stale local drafts from replacing authoritative server values.
- [x] Preserve incomplete, rejected, pending, and approved profile states.

### 14.3 Security

- [x] Recreate the approved Security design.
- [x] Preserve password-change validation and reauthentication requirements.
- [x] Preserve MFA/passkey setup, verification, recovery codes, and removal behavior.
- [x] Preserve active-session visibility and revocation.
- [x] Preserve blocked-user management.
- [x] Preserve payout setup entry and Stripe Connect status without changing payment behavior.
- [x] Never place secrets, recovery codes, or confidential values in general application cache.
- [x] Require explicit confirmation for sensitive security mutations.

### 14.4 Preferences

- [x] Recreate the approved Preferences design.
- [x] Support only current light/dark appearance choices.
- [x] Remove every user-facing trace of Mountain Light, Mountain Dark, Classic Mountain, and Classic Mountain Dark.
- [x] Preserve unrelated preference fields.
- [x] Preserve supported font-size and communication preferences.
- [x] Keep immediate-save behavior with visible status.
- [x] Synchronize preferences across tabs without a full shell repaint.
- [x] Apply appearance before first paint on subsequent sessions.

## 15. Help and issue reporting

- [x] Keep authenticated Help as a routed V2 view while public Help remains separately accessible.
- [x] Preserve all current paralegal help content and substantive guidance.
- [x] Preserve issue-report submission behavior and server-side classification.
- [x] Preserve success, validation, unavailable, and retry states.
- [x] Keep confidential-information warnings appropriate to the support channel.
- [x] Preserve password-reset, legal, contact, admissions, and accessibility links.
- [x] Ensure an authenticated Help visit does not dismantle the application shell.

## 16. Global search

- [x] Keep Search mounted once in the header.
- [x] Keep Search compact until hover, focus, or the keyboard shortcut activates it.
- [x] Expand the actual header search input inline so typing never moves into a dropdown.
- [x] Keep the header height and surrounding tool geometry unchanged while Search expands.
- [x] Keep the results layer closed until the user enters at least two characters.
- [x] Use the concise empty-result message `No results.`.
- [x] Search only resources the current paralegal is authorized to access.
- [x] Preserve the current paralegal result contract: authorized Matters only. Profiles remain attorney-only; applications and messages are not existing search result types.
- [x] Preserve keyboard navigation, Escape, focus return, and result announcements.
- [x] Keep recent queries/results user-scoped.
- [x] Cancel stale searches.
- [x] Prevent results from a prior user/session from appearing.
- [x] Route selected results without remounting the shell.
- [x] Preserve deep-link authorization at the destination.

## 17. Notifications, unread counts, and badges

- [x] Mount one notification center.
- [x] Preserve unread totals and badge semantics.
- [x] Preserve mark-one/mark-all behavior.
- [x] Preserve notification destinations.
- [x] Deduplicate polling, refresh, or event subscriptions.
- [x] Reconcile notifications across browser tabs.
- [x] Route notification clicks inside V2 when possible.
- [x] Preserve stale-session and authorization handling.
- [x] Do not decrement counts until the server confirms the authoritative change.
- [x] Invalidate and reconcile Home/Work projections and the global badge after relevant changes.

## 18. LPC Assistant drawer

- [x] Keep the Assistant as the approved narrow, shadow-free side drawer.
- [x] Keep it mounted across route changes.
- [x] Preserve open/closed state during navigation.
- [x] Preserve the approved mistake notice: `AI can make mistakes. Check important information.`
- [x] Do not restore the long confidential-information disclaimer in the composer.
- [x] Do not show `Checking that now` on initial open.
- [x] Do not restore `Describe what's blocking you` ghost text.
- [x] Preserve feedback controls only if they submit or store meaningful feedback.
- [x] Preserve thumbs-up/down behavior and accessible labels.
- [x] Preserve current paralegal Assistant tools and least-privilege permissions.
- [x] Pass route and Matter context explicitly; never scrape arbitrary DOM content.
- [x] Keep account questions separate from Matter-confidential context.
- [x] Require authorized Matter membership before workspace information is available.
- [x] Clear Matter context when leaving or losing access to a workspace.
- [x] Handle stale sessions, removed assignments, blocks, restrictions, and closed Matters through the existing server authority.
- [x] Never expose attorney-only, admin-only, another user's, or another Matter's information.

## 19. Matter workspace

The workspace migrates after lower-risk shell views and receives its own acceptance gate.

### 19.1 Entry and authorization

- [ ] Load by authoritative Matter/Case identifier.
- [ ] Verify authenticated role and current workspace membership before confidential reads.
- [ ] Preserve direct/deep-link behavior.
- [ ] Preserve missing, forbidden, removed-access, archived, cancelled, and completed outcomes.
- [ ] Recheck access on refresh, tab focus, sensitive action, and relevant server response.
- [ ] Clear cached confidential data immediately after loss of access.
- [ ] Prevent browser history from revealing protected content after logout or removal.

### 19.2 Workspace overview

- [ ] Recreate Matter identity, attorney identity, status, scope, compensation, and deadline presentation.
- [ ] Preserve authoritative status names.
- [ ] Preserve role-appropriate actions only.
- [ ] Preserve completed and archived read-only history.
- [ ] Preserve withdrawn-paralegal access boundaries.
- [ ] Preserve dispute and payout-hold presentation without merging their meanings.

### 19.3 Messages

- [ ] Preserve conversation history, ordering, timestamps, sender identity, and unread state.
- [ ] Preserve send permissions by lifecycle and account state.
- [ ] Prevent duplicate sends from retries, double-clicks, or multiple tabs.
- [ ] Preserve attachment behavior and validation.
- [ ] Keep composer drafts per Matter.
- [ ] Reconcile new messages and unread badges without reloading the workspace.
- [ ] Handle blocks, removed access, completion, cancellation, and restrictions during an open composer.
- [ ] Prevent a stale send from reaching a Matter after context changes.

### 19.4 Files

- [ ] Preserve file list, metadata, uploader, uploader identity, and download behavior.
- [ ] Preserve file authorization and signed-link behavior.
- [ ] Preserve accepted file types, size limits, and malware/security handling.
- [ ] Show progress, success, failure, retry, and cancellation accurately.
- [ ] Prevent duplicate upload records.
- [ ] Preserve historical files after completion where currently authorized.
- [ ] Never expose storage identifiers or private URLs unnecessarily.

### 19.5 Deadlines

- [x] Preserve deadline list, ownership, status, and date semantics.
- [x] Preserve add/edit/delete permissions exactly and document that the current Event authority has no completion state.
- [x] Preserve the current absence of Event notifications and synchronize the Home calendar.
- [x] Handle timezone and LPC business-date rules consistently.
- [x] Prevent stale edits and conflicting multi-tab changes.
- [x] Preserve completed and historical deadline evidence where currently retained.

### 19.6 Submissions, revisions, and approvals

- [x] Preserve submission creation and attachment requirements.
- [ ] Preserve submission timestamps and immutable historical evidence.
- [x] Preserve attorney revision requests and paralegal revision responses.
- [ ] Preserve approval and completion preconditions.
- [x] Preserve role-specific controls and status language.
- [ ] Prevent repeated approvals, repeated completion, or stale action replay.
- [ ] Reconcile workspace, Home, Matter lists, notifications, and payments after confirmed changes.
- [x] Never let client presentation advance the lifecycle without server confirmation.

### 19.7 Completion, payment, and exceptional states

- [ ] Preserve Matter completion behavior without rewriting historical Matter records.
- [ ] Preserve payout readiness, released payout, hold, refund, dispute, and chargeback evidence.
- [ ] Keep Stripe disputes distinct from LPC work-quality disputes.
- [ ] Preserve chargeback policy: unreleased payout may be held; released payout is not automatically clawed back.
- [ ] Preserve immutable platform-income evidence and separate adjustments.
- [ ] Show only server-authoritative financial values.
- [ ] Keep payment actions outside V2 unless already authorized for the paralegal role.
- [ ] Never trigger payment behavior through view hydration or background refresh.

## 20. Profile preview

- [ ] Preserve the exact attorney-visible set of paralegal fields.
- [ ] Preserve approved versus pending photo behavior.
- [ ] Preserve unavailable/private field handling.
- [ ] Preserve direct profile links and authorization.
- [ ] Route the owner back into Profile Settings without remounting the shell.
- [ ] Verify preview reflects confirmed autosaves and does not display unsaved local drafts as public.

## 21. Visual system

- [ ] Create a scoped V2 token layer for white, navy, approved blues, restrained gold, text, lines, states, and focus.
- [ ] Use Sarabun for application typography and approved editorial type only where explicitly retained.
- [ ] Define consistent type sizes, weights, line heights, and label treatments.
- [ ] Define one spacing scale.
- [ ] Define one border and radius system.
- [ ] Keep authenticated paralegal surfaces shadow-free unless separately approved.
- [ ] Keep the background white.
- [ ] Preserve the navy work surface and compensation ribbon where approved.
- [ ] Define cards, strips, rows, folios, tables, forms, tabs, buttons, links, badges, menus, tooltips, dialogs, drawers, and empty states once.
- [ ] Avoid styling through page-specific `!important` overrides.
- [ ] Avoid loading old dashboard CSS alongside V2.
- [ ] Prevent legacy selectors from leaking into V2.
- [ ] Establish visual regression screenshots for every major state and viewport.

## 22. Responsive behavior

Required verification widths:

- 320px
- 360px
- 375px
- 390px
- 430px
- 768px
- 1024px
- 1440px
- 1920px

For every primary route and workspace state:

- [ ] No horizontal overflow.
- [ ] No clipped controls, text, menus, dialogs, drawers, or content.
- [ ] No sidebar/menu overlap with brand or account controls.
- [ ] No content movement caused by scrollbar appearance.
- [ ] No touch target below the accepted minimum.
- [ ] No hover-only essential action.
- [ ] Correct drawer and modal containment.
- [ ] Correct mobile navigation focus and background inertness.
- [ ] Correct long-name, long-title, long-email, and large-text wrapping.
- [ ] Correct zoom at 200% and text spacing overrides.

## 23. Accessibility requirements

- [ ] Preserve valid landmark structure.
- [ ] Provide one clear page/view heading per routed view.
- [ ] Keep navigation labels and current-page semantics accurate.
- [ ] Maintain logical DOM and focus order.
- [ ] Move focus appropriately after route changes without stealing it during background updates.
- [ ] Announce loading, saving, errors, and confirmed mutations appropriately.
- [ ] Keep decorative icons hidden from assistive technology.
- [ ] Provide accessible names for icon-only controls.
- [ ] Support keyboard operation for every action.
- [ ] Support Escape and focus restoration for menus, dialogs, and the Assistant.
- [ ] Meet WCAG 2.2 AA contrast, including real computed contrast checks.
- [ ] Support reduced motion.
- [ ] Avoid relying only on color for status.
- [ ] Run automated checks in Chromium, Firefox, and WebKit.
- [ ] Conduct manual screen-reader checks on macOS VoiceOver and at least one additional supported screen reader before rollout.

## 24. Performance requirements

- [ ] Set a V2 JavaScript, CSS, font, image, and route-chunk budget before implementation.
- [ ] Do not increase a budget to hide duplication.
- [ ] Load the application shell and active route first.
- [ ] Lazy-load inactive views and heavy workspace features.
- [ ] Preload only critical fonts and shell assets.
- [ ] Avoid duplicate font families and weights.
- [ ] Avoid shipping legacy page CSS or scripts with V2.
- [ ] Avoid duplicate API requests during startup and navigation.
- [ ] Keep route transitions responsive under simulated slow network and CPU conditions.
- [ ] Measure layout shift, interaction latency, and loading behavior.
- [ ] Keep the shell interactive while route data refreshes.
- [ ] Establish cold-load and warm-navigation acceptance thresholds.

## 25. Security and privacy review

- [ ] Complete a route-by-route authorization inventory before connecting data.
- [ ] Treat the server as authority; hiding a control is not authorization.
- [ ] Confirm every mutation retains CSRF and authorization protection.
- [ ] Confirm confidential data is not placed in URLs, analytics, logs, local storage, or error messages.
- [ ] Confirm caches are user- and Matter-scoped.
- [ ] Confirm upload and download controls preserve existing security boundaries.
- [ ] Confirm logout and access loss clear confidential client state.
- [ ] Confirm Assistant context follows its data-permission matrix.
- [ ] Confirm no secrets or payment credentials enter frontend bundles.
- [ ] Run dependency, CSP, XSS, open-redirect, deep-link, and stale-session checks.

## 26. Characterization required before implementation

- [ ] Freeze a clean baseline commit and record Node/npm versions.
- [ ] Run and record the complete existing suite.
- [ ] Inventory every existing paralegal route and entry link.
- [ ] Inventory every endpoint each paralegal surface reads or mutates.
- [ ] Inventory all request/response shapes, including optional and legacy fields.
- [ ] Inventory all current browser storage keys and cached data.
- [ ] Inventory all global events, polling, observers, intervals, and cross-tab channels.
- [ ] Inventory all direct Stripe-related frontend entry points without accessing Stripe.
- [ ] Inventory every modal, drawer, toast, dropdown, upload, and file action.
- [ ] Record screenshots for empty, setup, populated, unavailable, forbidden, stale, and error states.
- [ ] Add missing characterization tests before moving a behavior.
- [ ] Establish fixtures for approved, incomplete, restricted, blocked, invited, applied, shortlisted, hired, active, completed, withdrawn, disputed, payout-held, and archived states.

## 27. Test program

### 27.1 Unit tests

- [ ] Router and route parsing.
- [ ] Query keys and cache invalidation.
- [ ] Request cancellation and stale-response suppression.
- [ ] Form dirty state and autosave queue.
- [ ] Partial profile update preservation.
- [ ] Status presentation mappings sourced from existing rules.
- [ ] Date, currency, count, and badge formatting.
- [ ] Recommendation history exclusion presentation.
- [ ] Permission-derived control visibility.
- [ ] Assistant context creation and clearing.

### 27.2 Component/view tests

- [ ] Every shell element and responsive state.
- [ ] Every Home state.
- [ ] Browse filters, results, details, and application gates.
- [ ] Matter/application/invitation states.
- [ ] Profile autosave, photo, documents, Security, and Preferences.
- [ ] Search, notifications, account menu, Assistant, dialogs, and toasts.
- [ ] Workspace messages, files, deadlines, submissions, revisions, approvals, completion, and read-only history.

### 27.3 Cross-role and lifecycle tests

- [ ] Attorney creates/publishes Matter → eligible paralegal Browse and recommendations update.
- [ ] Ineligible experience → Matter is excluded from recommendations.
- [ ] Historical withdrawn/rejected/inactive application → Matter does not return to recommendations.
- [ ] Invitation → paralegal Home, invitations, notifications, and deep link agree.
- [ ] Application/withdrawal/rejection/shortlist → attorney and paralegal surfaces agree.
- [ ] Hiring/funding → workspace and active Matter visibility agree.
- [ ] Message/file/deadline/submission/revision/approval → both roles and counts agree.
- [ ] Completion → active views, history, compensation, notifications, and payment views agree.
- [ ] Unpublish/cancel/expire/delete → every list, count, search result, recommendation, and deep link agrees.
- [ ] Block/restriction/deactivation/access removal → open and stale sessions lose appropriate access.
- [ ] Refund/dispute/chargeback/payout hold → financial presentation remains authoritative and immutable evidence remains intact.

### 27.4 Browser contracts

- [ ] Chromium, Firefox, and WebKit.
- [ ] All required responsive widths.
- [ ] Direct routes, links, tabs, Back, Forward, refresh, and multi-tab behavior.
- [ ] No full-screen blanking or shell remount during navigation.
- [ ] No layout shift from late fonts, role, theme, identity, sidebar, header, search, notifications, or Assistant hydration.
- [ ] Scroll restoration for every primary route.
- [ ] Focus management for route changes and overlays.
- [ ] No new skips.

### 27.5 Visual review

- [ ] Owner approval of each route at desktop and mobile.
- [ ] Empty, setup, populated, error, and restricted states.
- [ ] Long-content stress states.
- [ ] Assistant closed and open.
- [ ] Sidebar expanded, collapsed, opening, open, and closing.
- [ ] Light and dark supported appearances.

## 28. Build and rollout method

### Phase 0 — Approval and baseline

- [ ] Owner approves this plan and resolves open decisions.
- [ ] Create a dedicated V2 branch/checkpoint.
- [ ] Record clean suite totals and current working-tree ownership.
- [ ] Freeze route/API/field/status inventories.
- [ ] Confirm no production access is needed for construction.

Exit gate: approved scope and clean characterization baseline.

### Phase 1 — V2 foundation

- [x] Create isolated V2 entry, build boundary, tokens, router, shell, error boundary, and test harness.
- [x] Implement session boundary and API client wrappers.
- [x] Implement persistent sidebar/header/search/notification/Assistant hosts without connecting privileged content.
- [x] Prove navigation, deep links, Back/Forward, scroll, responsive behavior, and no shell remount.

Exit gate: empty shell is stable and accessible across all browsers and widths.

### Phase 2 — Home

- [x] Recreate every approved Home state using fixtures.
- [x] Connect read-only Home endpoints.
- [x] Connect availability only after mutation characterization passes.
- [x] Verify recommendations, applications, deadlines, inbox, setup, and compensation.

Exit gate: Home matches current authority and approved visuals without changing backend behavior.

### Phase 3 — Browse Matters

- [x] Recreate filters, results, details, empty/error states, and apply gates.
- [x] Connect read endpoints first.
- [x] Connect application mutation after duplicate/stale/multi-tab tests pass.
- [x] Verify historical recommendation/application exclusions.

Exit gate: Browse and recommendations agree with current production logic.

### Phase 4 — My Matters, applications, and invitations

- [x] Recreate all lists, filters, pagination, details, and actions.
- [x] Connect invitation and withdrawal/revoke actions after characterization.
- [x] Verify cross-view and cross-role synchronization.

Exit gate: all pre-engagement and engagement transitions match current behavior.

### Phase 5 — Profile Settings

- [x] Recreate Profile, Security, and Preferences.
- [x] Add safe autosave to professional profile fields.
- [x] Preserve explicit sensitive/upload actions.
- [x] Verify all existing profile data round-trips without loss.
- [x] Verify retired themes do not return.

Exit gate: synthetic legacy/current profiles load, edit, save, preview, and reload without losing any field.

### Phase 6 — Help, search, notifications, and Assistant integration

- [x] Add authenticated Help view.
- [x] Complete global Search destinations.
- [x] Complete notification reconciliation.
- [x] Connect Assistant context and feedback controls.

Exit gate: global tools remain mounted, authorized, synchronized, and accessible across every route.

### Phase 7 — Matter workspace read-only foundation

- [x] Recreate workspace shell, overview, history, messages, files, deadlines, and submissions in read-only fixture mode.
- [x] Connect authorized reads.
- [x] Verify stale-session and loss-of-access behavior.
- [x] Verify completed/archived history.

Exit gate: all workspace information is correct and confidential boundaries are proven.

### Phase 8 — Matter workspace mutations

- [x] Connect text-message sending and read acknowledgement using the existing messaging authority.
- [x] Connect files through the existing upload, scan-status, list, and download authorities. See `docs/PARALEGAL_V2_PHASE8B_FILES.md`.
- [x] Connect deadlines. See `docs/PARALEGAL_V2_PHASE8C_DEADLINES.md`.
- [x] Connect submissions and revisions. See `docs/PARALEGAL_V2_PHASE8D_SUBMISSIONS.md`.
- [x] Connect attorney-owned approval and completion outcomes without exposing those controls to paralegals. See `docs/PARALEGAL_V2_PHASE8E_COMPLETION.md`.
- [x] Verify idempotency, stale-action rejection, multi-tab behavior, notifications, and cross-role reconciliation after each group. Phase 8A–8E are implemented and covered locally.

Exit gate: complete cross-role workspace lifecycle is green without payment behavior changes.

### Phase 9 — Full acceptance candidate

- [x] Run full Jest suite under the required Node/npm baseline.
- [x] Run complete browser, accessibility, performance, security, and lifecycle matrices.
- [ ] Complete manual owner visual review.
- [ ] Complete manual paralegal workflow review using isolated test accounts.
- [x] Complete data-preservation comparison using synthetic snapshots representative of old and current profiles.
- [x] Resolve every P0/P1 defect; document accepted lower-priority findings.

Exit gate: release candidate approved for a separately authorized non-production deployment.

### Phase 10 — Non-production rollout rehearsal

- [ ] Deploy only to an approved non-production environment.
- [ ] Run smoke, lifecycle, cross-role, accessibility, performance, and rollback tests.
- [ ] Verify old and V2 URLs.
- [ ] Verify feature flag and immediate rollback.
- [ ] Record asset, route, API, and data compatibility evidence.

Exit gate: rehearsal is green and rollback is proven.

### Phase 11 — Controlled production rollout

Requires separate explicit authorization.

- [ ] Confirm database backup/recoverable checkpoint even though no data migration is intended.
- [ ] Confirm no schema migration is included.
- [ ] Confirm release artifact hashes and exact files.
- [ ] Run final complete suite.
- [ ] Enable V2 for owner/internal accounts first.
- [ ] Enable a small approved paralegal cohort.
- [ ] Monitor authentication, route, API, autosave, workspace, upload, notification, and Assistant failures.
- [ ] Compare old/V2 lifecycle counts and financial presentation.
- [ ] Expand only after acceptance thresholds are met.
- [ ] Keep immediate rollback available.

Exit gate: all approved paralegals moved only after measured stability.

### Phase 12 — Legacy retirement

Requires separate explicit authorization after the rollback window.

- [ ] Confirm no required traffic depends on legacy paralegal pages.
- [ ] Preserve redirects and deep links.
- [ ] Archive—not casually delete—legacy source and acceptance evidence.
- [ ] Remove old assets only after dependency proof.
- [ ] Re-run complete suite and production smoke tests.
- [ ] Update operations, support, incident, and onboarding documentation.

## 29. Feature-flag and rollback requirements

- [ ] V2 is disabled by default until authorized.
- [ ] Flag can target individual test users before cohorts.
- [ ] Flag evaluation cannot expose V2 to the wrong role.
- [ ] Old and V2 frontends use the same authoritative records and APIs.
- [ ] Rollback changes routing only; it does not require data reversal.
- [ ] Autosaves made in V2 remain readable in the old UI.
- [ ] Actions completed in either UI remain visible in the other.
- [ ] Rollback preserves active workspace drafts or warns users appropriately.
- [ ] Operations documentation states who can roll back and how.
- [ ] A rollback rehearsal is mandatory before production rollout.

## 30. Observability and support readiness

- [ ] Record route-load failures without confidential payloads.
- [ ] Record API error categories without secrets or Matter content.
- [ ] Measure client navigation time, shell remounts, and layout shifts.
- [ ] Measure autosave success/failure/conflict rates.
- [ ] Measure workspace send/upload/action failures.
- [ ] Measure unauthorized and stale-session outcomes.
- [ ] Separate V2 errors from legacy errors.
- [ ] Add release/version identifiers to diagnostic reports without restoring obsolete legal `Version` wording.
- [ ] Update support macros for V2 navigation and rollback.
- [ ] Prepare an incident response procedure for profile-save or workspace-access defects.

## 31. Required owner review decisions

Before Phase 1, decide:

1. The canonical V2 URL structure.
2. Whether authenticated Help becomes a V2 view while the public Help page remains separate.
3. Whether desktop sidebar collapse remains part of V2.
4. The approved V2 light/dark appearance behavior.
5. The exact profile fields permitted to autosave.
6. The autosave delay and visible status wording.
7. Whether Profile Settings keeps a manual `Save now` fallback.
8. Whether Browse filters apply immediately or through `Update results`.
9. The initial internal/canary rollout cohort.
10. The rollback observation window before legacy retirement.

These decisions affect presentation and rollout. They do not authorize changes to lifecycle, payment, or legal policy.

## 32. Definition of done

Paralegal V2 is complete only when:

- [ ] Existing paralegal accounts and profiles load without field loss.
- [ ] Existing applications, invitations, Matters, workspace records, and financial history remain intact.
- [ ] The sidebar, header, search, notifications, and Assistant never remount during authenticated navigation.
- [ ] Ordinary navigation produces no full-screen blank, blink, hydration jump, or shell reflow.
- [ ] Only the changing view displays localized loading behavior.
- [ ] Every current deep link has a tested result.
- [ ] Every lifecycle and visibility rule matches the authoritative existing system.
- [ ] Profile autosave is safe, conflict-aware, and visibly confirmed.
- [ ] The Matter workspace passes complete cross-role lifecycle testing.
- [ ] Accessibility, performance, security, responsive, stale-session, multi-tab, and rollback gates are green.
- [ ] No new skips hide required coverage.
- [ ] No schema or production data migration is needed for frontend adoption, unless separately reviewed and authorized.
- [ ] Owner visual and workflow review is complete.
- [ ] Controlled rollout and rollback rehearsal are complete.
- [ ] Production rollout receives separate explicit authorization.

## 33. Recommended approval boundary

Approve **Phases 0 and 1 only** first. That authorizes characterization and construction of the isolated empty V2 shell, not business mutations, production access, deployment, user migration, or Matter workspace actions.

Once the shell proves true persistent navigation—with no remounting or blinking—the owner can review it before any existing paralegal workflow is moved.
