# Paralegal V2 capability-parity and retirement audit

Date: September 4, 2026

Status: **Local implementation and automated capability parity are established; legacy retirement is not yet authorized.**

## Decision

Paralegal V2 now has an implementation path for every intended paralegal capability exposed by the current Home, Browse Matters, My Matters & Applications, Account Settings, Help, and active Matter workspace surfaces. It reads and mutates the existing authoritative records through the existing routes; it does not create a second profile, Matter, application, message, file, deadline, or financial record.

This audit found and corrected seven parity or reliability defects before recommending a cutover:

1. Active Matters stored with the legacy `paralegal` participant alias or `funded_in_progress` status could be omitted from the Home/Work dashboard projection.
2. Profile readiness could miss the retained `resumeKey` alias.
3. An unchanged failed profile autosave revision could schedule itself repeatedly instead of remaining as an explicit recoverable draft.
4. Matter-tab remounts could attempt the same message read acknowledgement more than once.
5. The Matter container could temporarily exceed the viewport while the pinned Assistant recomposed at a desktop breakpoint.
6. A write handled by a different application process could wait for the client polling fallback because process-local event publication could not reach subscribers connected elsewhere.
7. Onboarding refresh and realtime-heartbeat failures could be silent instead of preserving the current view while exposing an observable recovery signal.

The audit also hardened cross-process refresh behavior. Persisted Application, Block, Case, CaseFile, Event, Job, Message, Notification, and User changes now emit opaque refresh signals to connected browser sessions in each web process through MongoDB change streams. Existing SSE, `BroadcastChannel`, visibility/online reconciliation, and 15-second polling remain fallback layers. No record content is sent in a refresh signal.

The legacy frontend must not be deleted merely because feature parity is present. Route cutover, a rollback rehearsal, production-like multi-instance realtime verification, and manual assistive-technology checks remain release gates.

## Source of truth and constraints

The audit used the current routes, services, models, frontend controllers, lifecycle tests, Phase 0–9 V2 evidence, lifecycle inventory, dashboard visibility matrix, scenario report, and compatibility report. No production data, Stripe account, deployment, migration, schema change, charge, payout, refund, or backfill was used.

The existing backend remains authoritative. V2 is one persistent client shell over that backend. Field aliases and compatibility models remain readable until their separately documented retirement gates are satisfied.

## Capability matrix

| Domain | V1 capability that must survive | V2 authority and behavior | Audit result |
| --- | --- | --- | --- |
| Identity and session | Cookie session, role and approval gates, stale-session exit, logout | `/api/auth/me`; cached identity is presentation-only; pageshow, visibility, online, storage, and mutation failures reauthorize; protected caches/drafts clear on account change or access loss | Preserved and strengthened |
| Approval, restriction and deactivation | Approved paralegals may use protected workflow; restricted/deactivated users lose access | Existing route middleware remains authoritative; V2 exits or fails closed on `401` and applicable `403`; deactivation uses the existing eligibility/status and mutation routes | Preserved |
| Profile data | Identity, contact, bio/about, years, practice areas, state experience, skills, best-for, experience, education, languages, publications | `/api/users/me` reads and field-isolated `PATCH` writes; V2 merges retained aliases for display and never sends a whole-profile replacement | Preserved; stale autosave retry corrected |
| Profile photo and documents | Crop/upload/remove photo; pending/rejected/approved photo state; résumé, certificate and writing sample | Existing profile-photo and document upload routes; résumé accepts `resumeURL` and retained `resumeKey`; explicit confirmation for destructive removal | Preserved; legacy résumé alias corrected |
| Attorney-visible paralegal profile | Attorneys retain the current authorized public/profile view | Existing `profile-paralegal.html` and authorized profile projection remain in service; V2 owner preview reflects confirmed profile values and document references | Preserved; no attorney field removed |
| Security | Password, MFA email/authenticator, backup codes, passkeys, sessions, blocks, account deactivation | Existing `/api/account/*` and `/api/blocks*` authorities; sensitive actions remain explicit and confirmed; secrets are not stored in V2 cache | Preserved |
| Preferences | Notification choices, visibility, font size, supported appearance | Existing preference and notification-preference routes; only current light/dark choices are shown; retired theme strings normalize at presentation without clearing other preferences | Preserved; persistence migration remains separately controlled |
| Availability | Current status and next-available date | Existing `/api/paralegals/update-availability`; server response is authoritative; cross-tab refresh refetches the user instead of trusting storage | Preserved; still not an application blocker |
| Recommendations | State **or** practice-area match; required experience; publication/assignment/block/account rules; permanent historical-application exclusion | Server `/api/jobs/recommended` uses the canonical recommendation projection and historical Application plus retained `Case.applicants` evidence | Preserved and centralized server-side |
| Browse Matters | Broader open catalog, filters/sort/details, blocked and application eligibility states | `/api/jobs/open`, `/api/applications/my`, `/api/users/me`; state, practice, compensation, deadline and date-posted filters stay in route state; server eligibility decides whether Apply is allowed | Preserved |
| Applications | Apply, duplicate guard, active queue, revoke/withdraw, rejected/accepted behavior and history evidence | Existing Job/Case application routes and canonical Application records; V2 guards double submission and refetches confirmed state | Preserved |
| Historical application rule | Withdrawn, rejected, accepted or otherwise inactive history must never create a fresh recommendation | Recommendation exclusion uses every canonical Application status and retained applicant evidence. Browse remains intentionally broader; withdrawn applications retain the existing explicit Browse reapplication behavior | Preserved; cross-surface matrix added |
| Shortlisting and invitations | Attorney shortlist/invite; paralegal review, accept/decline/revoke; payout readiness precondition | Existing application/Case routes; V2 reads invitations with Work/Home, rechecks current Stripe readiness before acceptance, and fails closed if readiness is unavailable | Preserved |
| Hiring and funding | Attorney-owned selection/funding advances the Matter and creates workspace access | Existing lifecycle/payment routes and Case projection remain authoritative; V2 presents resulting state but adds no client-side lifecycle transition | Preserved |
| Home dashboard | Setup blockers, active work, deadlines, inbox, recommendations, applications and released compensation | Existing dashboard, user, payout, recommendation, invitation, Event, message, unread and Application projections are atomically composed; local failure stays local | Preserved; active legacy aliases corrected |
| Active Matter list | Assigned active work appears once and is not confused with recommendations | Dashboard query accepts `paralegal` or `paralegalId`, recognized active statuses including `funded_in_progress`, excludes archived/released work, and normalizes display status | Preserved and corrected |
| Matter workspace access | Only current participants may open active confidential work; stale or deep links reauthorize | Existing `/api/cases/:id` Matter-experience projection and middleware; `401/403/404`, completion and access loss purge the mounted confidential view | Preserved |
| Workspace overview and tasks | Scope, participants, status, progress and attorney-owned task completion | Existing minimized Matter-experience projection; paralegal sees task state but receives no attorney task-edit or completion controls | Preserved; omission of attorney controls is intentional |
| Messages | Ordered conversation, sender/time, send, read state, unread counts, retry and attachment exchange | Existing message and upload authorities; immediate pending delivery, stable `clientMessageId`, server reconciliation, per-Matter drafts, read watermark, SSE/event/tab/poll refresh | Preserved and strengthened |
| Files | Multiple selection, upload progress, validation, scan state, list, authorized download, retry and cancellation | Existing CaseFile upload/list/security/download routes; 20 MB and type checks mirror but never replace server enforcement; concurrent uploads keep failed selections for retry | Preserved and strengthened |
| Submissions and revisions | Paralegal submission, attorney review/revision evidence, version/timestamps, stale protection | Existing CaseFile status route and exact stored statuses; paralegal can submit/revise but not perform attorney review; confirmed state is refetched | Preserved |
| Deadlines | Shared Matter deadline plus user-owned calendar entries | Shared Case deadline remains read-only; existing Event CRUD creates private reminders only; date-only semantics and Home synchronization are retained | Preserved; separation is intentional |
| Completion and history | Attorney completion removes active access; completed work remains in authorized history | Existing completion route and `/api/cases/my-completed`; V2 removes the stale live workspace and presents history/receipt without fabricating continued workspace access | Preserved |
| Payments and payouts | Payout readiness, exact recorded amounts, released history, receipt, holds, refunds and dispute/chargeback evidence | Existing payout-readiness and Matter financial projections only; no V2 hydration or background refresh triggers money movement; attorney/payment mutations remain outside the paralegal client | Preserved read behavior; no payment logic changed |
| Work-quality disputes and blocks | Eligible paralegal may open a work dispute or block future interaction; Stripe dispute remains separate | Existing dispute and block routes with confirmations and server conflict handling; chargeback state is presentation only and remains distinct | Preserved |
| Notifications and badges | Authoritative unread total, notification list, mark one/all, dismiss/clear, destinations | Existing notification routes; unread-count endpoint remains authoritative; SSE, cross-tab and polling reconcile after server confirmation | Preserved and strengthened |
| Global Search | Authorized paralegal Matter results and protected deep links | Existing `/api/cases/search` with Matter-only result type; stale requests abort, results are identity-scoped, and destinations reauthorize | Preserved; result scope not broadened |
| Help and issue reporting | Guidance, support links and structured issue submission | Authenticated V2 Help uses existing incident intake; public Help remains available separately | Preserved |
| LPC Assistant | Account/support guidance, feedback, and authorized Matter context only | Existing support drawer and server-side permission contract; explicit V2 route/Matter context, no DOM scraping, context cleared on route/access change | Preserved |
| Responsive/accessibility | Keyboard, focus, touch, mobile navigation, overlays and supported widths | Persistent shell, scoped views and cross-browser contracts at 320–1920 px; drawer and Matter width are bounded; reduced motion supported | Automated parity present; manual AT gate remains |

## Intentional differences that are not regressions

- Browse Matters is intentionally broader than Recommendations. A Matter may be browseable without being recommended.
- Availability is a profile/discovery signal, not an application-eligibility blocker.
- Withdrawn applications are absent from the active application queue but remain permanent recommendation-exclusion evidence. The current Browse reapplication rule is preserved.
- Shared Matter deadlines and private paralegal reminders are different records. V2 does not let a private Event overwrite the Case deadline.
- Task review, task completion, document approval, Matter completion, funding, payout, refund, and chargeback actions remain attorney/admin/server-owned. V2 does not expose those controls to paralegals.
- Completed Matters remain in historical lists and payment evidence but do not expose an active collaboration workspace when the backend no longer authorizes one.
- V2 does not add message editing, deletion, reactions, or pinning because V1 did not provide those paralegal capabilities.

## Realtime delivery determination

For writes handled in the current process, message, file, Case, application, dispute, payment, profile, availability and notification routes publish refresh signals immediately after authoritative persistence. The open V2 client then refetches the relevant authorized projection without a document reload.

For writes handled by another application process, the new MongoDB change-stream bridge mirrors persisted changes to that process's connected subscribers. If change streams are unavailable, the client retains reconnect, focus/online reconciliation, cross-tab communication and a 15-second polling safety net. Therefore the code path for immediate multi-process delivery exists, but a production-like multi-instance environment must verify that the deployed MongoDB topology and account permit change streams before “immediate” is treated as an operational guarantee.

## Data-preservation determination

- No V2 route creates a parallel user or business record.
- Profile autosave sends only changed allowlisted fields. Unknown and older fields are not cleared by omission.
- Uploads use the existing storage and record authorities.
- Financial values are read from server projections; V2 does not estimate missing evidence.
- Existing `Job`/`Case`, `Application`/`Case.applicants`, identity, state, profile, practice-area and status compatibility remains intact.
- Existing accounts whose stored appearance value uses a retired theme render through the current supported appearance without deleting any other preference. A production persistence migration is not part of this audit.

## Final automated verification

- Complete repository Jest suite: **213/213 suites and 1,645/1,645 tests passed** under Node 24.18.0/npm 11.16.0.
- Complete paralegal Playwright matrix: **381/381 passed** in one uninterrupted run across Chromium, Firefox, and WebKit with `--fail-on-flaky-tests`; no scenario was skipped.
- Focused Matter regression after the stable-URL assertion correction: **30/30 passed** across Chromium, Firefox, and WebKit.
- Focused V2 foundation/onboarding regression after the final observability corrections: **27/27 passed** across Chromium, Firefox, and WebKit.
- Focused backend parity/realtime/lifecycle group: **6/6 suites and 70/70 tests passed**.
- Static gates passed: JavaScript syntax (666 files), frontend hygiene (37 entry points, 500 asset references, 89 modules, 42 stylesheets), frontend API contract (284 literals / 359 mounted patterns), frontend bindings (65 scripts), runtime bindings (405 modules), route uniqueness (375 registrations), no-theater (507 production/operator files and 6 historical files), and performance (202 files, 5,562.8 KiB).

Two earlier complete-Jest attempts surfaced unrelated, non-repeating harness symptoms: one transient support-Assistant `401`, then one response carrying a fake-key Stripe authentication body while a lifecycle test was labeling a non-Stripe projection request. Each affected test and its complete domain file passed ten consecutive isolated runs, and the final complete Jest run passed. No timeout, authentication rule, payment behavior, or production code was weakened to obtain the green result.

## Remaining gates before V1 route cutover

1. Run a production-like multi-instance test proving attorney-to-paralegal message, attachment, notification, application, deadline, completion and access-loss refresh through the deployed change-stream/SSE topology, including polling fallback.
2. Complete manual VoiceOver plus one additional screen-reader pass for primary navigation, Settings, dialogs, uploads, messaging and access-loss outcomes.
3. Complete an owner workflow pass with isolated approved/incomplete/restricted paralegal fixtures and an attorney counterpart. Do not use production users.
4. Approve and rehearse a route-cutover and rollback procedure. Legacy URLs must continue adapting their query/hash context while redirect usage remains unmeasured.
5. Make V2 the one canonical paralegal entry before deleting any V1 source. Observe the rollback window first; then archive/remove V1 assets only after traffic and dependency evidence is clean.

## Retirement verdict

Do not delete V1 yet. The complete local matrix is green, so the next appropriate step is a controlled non-production V2 route-cutover and rollback rehearsal. It does **not** support two dashboards loading for a user: the intended end state is one canonical V2 application, with small legacy URL adapters retained only as redirects until their use is measurable and safe to retire.
