# LPC Attorney Authenticated Frontend V2 Migration and V1 Retirement Plan

Status: **Audit and plan only; no implementation, migration, deletion, deployment, or retirement is authorized**

Prepared: September 4, 2026

Scope: Attorney-authenticated frontend, all attorney routes, the attorney side of the Matter lifecycle and workspace, and eventual retirement of the existing attorney V1 frontend

Strategy: A new attorney-owned persistent frontend shell over the existing LPC backend, lifecycle, authorization, payment, and record contracts, introduced beside V1 and retired only after measured parity and rollback proof

## 1. Executive decision

The attorney experience is a multi-page, progressively enhanced frontend whose principal behavior is concentrated in very large HTML and JavaScript files. It is not safe to restyle or incrementally convert those pages in place while the paralegal V2 audit and implementation are active. The safest path is an attorney-specific V2 entry, router, components, state adapters, and tests that consume the current APIs without changing them.

The backend and its persisted records remain authoritative. V2 must preserve exact current lifecycle transitions, role gates, payment and Stripe behavior, status aliases, reconciliation states, data-retention behavior, and cross-role consequences. Where current sources disagree, the disagreement is a characterization blocker or separately logged defect; it is not permission to select a cleaner behavior.

No task in this plan authorizes production access, a data migration, a schema or API change, a Stripe call, deployment, traffic switching, V1 deletion, or modification of paralegal V1/V2. Every implementation phase, rollout step, and retirement step requires separate owner authorization.

## 2. Audit method, snapshot, and limitations

This plan was produced from a repository-only, read-only trace of:

- attorney-facing HTML entries and their inline code;
- imported frontend modules and shared browser utilities;
- mounted backend routes and guards;
- lifecycle, visibility, compatibility, release, rollback, testing, and Assistant documents;
- models/services named by those routes and existing test coverage.

No production data was accessed. No request was sent to Stripe. No code path was executed that creates, changes, migrates, or deletes records.

The repository was already heavily modified when this audit began. In particular, the active paralegal V2 work includes changes to shared backend routes/models/services, shared frontend scripts/styles, and many untracked paralegal V2 artifacts. This plan therefore describes the filesystem observed on September 4, 2026, not a clean commit. Before attorney implementation, the owner must designate a clean commit plus an explicit allowed set of shared changes as the attorney V2 baseline. Existing user changes are not part of this deliverable and were not modified.

## 3. Binding sources of truth

V2 must consume and preserve the behavior captured by:

- `DOMAIN_LIFECYCLE_INVENTORY.md`
- `DASHBOARD_VISIBILITY_MATRIX.md`
- `SCENARIO_COVERAGE_REPORT.md`
- `DUPLICATED_RULES_AND_RISKS.md`
- `ATTORNEY_TEST_CHECKLIST.md`
- `PHASE6_COMPATIBILITY_RETIREMENT_REPORT.md`
- `docs/ATTORNEY_ASSISTANT_HARDENING_CHECKLIST.md`
- `docs/ATTORNEY_GRADE_RELIABILITY_STANDARD.md`
- `docs/RELEASE_GATES.md`
- `ROLLBACK_PLAN.md`

The following precedence rule is mandatory:

1. persisted authoritative record and external payment evidence;
2. backend authorization and lifecycle implementation;
3. executable characterization tests;
4. current frontend presentation;
5. prose documentation.

If those layers conflict, stop the affected V2 work, record the conflict with fixtures and exact sources, and obtain an owner decision. Do not silently normalize behavior in the browser.

## 4. Non-negotiable preservation rules

### 4.1 Accounts and attorney profile

- [ ] Preserve attorney IDs, role, approval, denial/rejection, disabled/deleted, verification, onboarding, and session state.
- [ ] Preserve name, email, phone, avatar and photo-review state, bar state/number, law firm, website, LinkedIn URL, biography, practice areas, publications, languages, experience, and all accepted aliases.
- [ ] Preserve notification preferences, email preferences, theme/font preferences, MFA, passkeys, sessions, and block relationships.
- [ ] Do not trust cached identity or role for authorization; revalidate through current session APIs.
- [ ] Do not overwrite unknown or unrendered fields with partial profile payloads.
- [ ] Preserve deactivation/deletion restrictions and retained financial/audit history.
- [ ] Use synthetic fixtures only; never copy production profiles into development or screenshots.

### 4.2 Matters, candidates, and collaboration

- [ ] Preserve CaseDraft, Case, Job, Application, invitation, applicant mirror, pre-engagement, assignment, task, file, message, event, dispute, archive, and notification records.
- [ ] Preserve exact ownership and participant checks on every read and mutation.
- [ ] Preserve application viewed/shortlisted/starred/rejected/withdrawn behavior and mirrored/reconciliation evidence.
- [ ] Preserve invite eligibility, accept/decline/revoke consequences, pending state, expiry, and notification behavior.
- [ ] Preserve pre-engagement revision/CAS behavior, questions, requirements, answers, conflict response, and approval/change-request gates.
- [ ] Preserve workspace read/write eligibility and immediate loss of access after withdrawal, dispute, block, deactivation, or other authoritative transition.
- [ ] Preserve historical and archived visibility without granting active-workspace permissions.

### 4.3 Money and Stripe

- [ ] Treat all displayed amounts as exact cents and use server-provided currency/evidence.
- [ ] Preserve the current minimum Matter amount and displayed 22% platform-fee presentation without making either a client authority.
- [ ] Preserve saved-payment-method, SetupIntent, portal, pending-hire return, escrow, funding-integrity, payout, refund, dispute-settlement, reversal, and reconciliation behavior.
- [ ] Never infer funded, paid, refundable, released, or settled state from optimistic UI or a Case label alone.
- [ ] Never automatically retry a non-idempotent payment, hire, completion, partial-payout, dispute, or settlement action.
- [ ] Preserve `PaymentOperation`, `Payout`, `PlatformIncome`, `FinancialAdjustment`, webhook, receipt, and Case funding evidence.
- [ ] Keep LPC work-quality disputes distinct from Stripe chargebacks.
- [ ] Use mocked/test payment providers for V2 development; no production Stripe objects or live mode.

### 4.4 Exact status vocabulary

V2 may map statuses to display labels but may not create, rename, merge, or persist new values. Required compatibility includes:

| Domain | Current values/aliases V2 must accept |
|---|---|
| User | roles `attorney`, `paralegal`, `admin`, `director`; status `pending`, `approved`, `denied`, `rejected`; disabled/deleted switches |
| Case persisted | `open`, `in progress`, `in_progress`, `paused`, `completed`, `disputed`, `closed` |
| Case normalized aliases | `in_progress` → `in progress`; `cancelled`/`canceled` → `closed`; `assigned`/`awaiting_funding` → `open`; `active`/`awaiting_documents`/`reviewing`/`funded_in_progress` → `in progress` |
| Viewer-only state | `draft`, `open`, `applied`, `funded_in_progress` |
| Job | `open`, `in_review`, `assigned`, `closed` |
| Application | `submitted`, `viewed`, `shortlisted`, `accepted`, `rejected`, `withdrawn` |
| Invitation | `pending`, `accepted`, `declined`, `expired` |
| Pre-engagement | `requested`, `submitted`, `approved`, `changes_requested`; conflict response empty, `none_known`, `disclosure` |
| File review/security | `pending_review`, `approved`, `attorney_revision`; security `pending`, `clean`, `blocked`, `error`, `not_required` |
| Dispute/moderation | dispute `open`, `resolved`, `rejected`; moderation `none`, `flagged`, `resolution_requested` |
| Payment/funding | integrity `pending`, `verified`, `failed`; processing/operation `not_started`, `pending`, `paid`/`succeeded`, `failed`, `reversed`, `needs_reconciliation` as applicable |
| Payout finalization | `zero_auto`, `partial_attorney`, `full`, `admin`, `expired_zero`, or null |
| Event/task | event responses `needsAction`, `accepted`, `declined`, `tentative`; types `deadline`, `meeting`, `call`, `court`, `misc`; standalone task `todo`, `in progress`, `review`; Case tasks use `completed` |

Unknown values must render a safe neutral label and telemetry, never unlock an action.

## 5. Explicit non-goals

This project must not:

- modify paralegal V1 or V2 files;
- redesign the public website, paralegal application, admin application, or director portal;
- change shared backend business logic, lifecycle transitions, payment rules, Stripe behavior, authorization, schemas, or API contracts;
- consolidate Case/Job or Application/Case applicant records;
- clean test data, backfill aliases, or migrate production records;
- alter recommendation/readiness/blocking policy;
- add a named unpublish, expiration, or cancellation lifecycle that does not currently exist;
- grant Assistant access beyond its current evidence and permission contracts;
- retire compatibility based on low apparent usage without measured evidence;
- delete or redirect V1 before V2 acceptance and rollback proof.

## 6. Current attorney frontend architecture

### 6.1 Shape and ownership

The current application is a set of independent documents with duplicated shell markup and page-owned initialization:

```text
Attorney V1
├── dashboard-attorney.html (6,232 lines)
│   ├── Home, Matters, Tasks, Payments hash views
│   ├── many inline styles/scripts/dialogs
│   ├── attorney-tabs.js (7,674 lines)
│   ├── attorney-dashboard.js (tour/onboarding)
│   └── billing-lite.js
├── create-case.html (3,524 lines; details/description/review hash steps)
├── case-detail.html (3,782 lines)
│   └── case-detail.js (6,566 lines; shared A/P workspace controller)
├── browse-paralegals.html + browse-paralegals.js
├── profile-paralegal.html + profile-paralegal.js
├── profile-attorney.html + profile-attorney.js
├── profile-settings.html (5,828 lines; role-conditional shared page)
├── help.html (public chrome with authenticated adaptation)
└── redirect shims: active-cases, case-applications, billing-attorney,
    create-case-step2, create-case-step5
```

Shared browser infrastructure includes `session.js`, `sidebar-profile.js`, `sidebar-grip.js`, `universal-header.js`, notification utilities, global search, productivity command registry, context panel, toast/dialog styles, support drawer, business-date helpers, and Stripe Connect/payment helpers. Much of it is also used by paralegal V1/V2 or public pages. It is a dependency, not attorney-owned code.

### 6.2 Current architectural risks

- Full-document navigation remounts session, shell, search, notifications, Assistant, menus, and overlays.
- Common navigation exists as repeated HTML and role-conditional branches, including both attorney and paralegal markup in the Matter workspace.
- State is split among URL query/hash, DOM, module globals, local/session storage, server records, polling, SSE, and optimistic caches.
- Dashboard and workspace implement independent status normalization and funded-workspace predicates.
- Inline and imported scripts make initialization order and duplicate listener/API behavior hard to prove.
- `case-detail.js` is a shared cross-role controller, so an attorney-only in-place rewrite can regress paralegal V1/V2.
- `profile-settings.html` currently defaults to paralegal shell markup and then role-loads attorney behavior, creating first-paint and ownership coupling.
- Search, notification, and Assistant deep-link resolution are distributed compatibility surfaces.
- V1 fallbacks between `/api/cases/my`, `/api/cases`, embedded files, and upload/file routes obscure which contract is canonical.

## 7. Complete authenticated route inventory

The inventory below includes direct pages, hash/query states, and legacy entries that can be reached from an authenticated attorney session. Public documents are included only where they adapt to authenticated state or are a dependency of an authenticated flow.

| Current entry | Current attorney responsibility | State/deep links to preserve | V2 disposition |
|---|---|---|---|
| `dashboard-attorney.html` | Persistent-looking but document-local dashboard | `#home`; empty hash; query-driven notices/onboarding | Map to V2 Home; retain V1 behind flag |
| `dashboard-attorney.html#cases` | Matter lists | filters `active`, `draft`, `archived`, `inquiries`; saved sort/filter/query state | V2 Matters route with equivalent URL state |
| `dashboard-attorney.html#tasks` | Private attorney checklist/tasks | pagination, status, Matter association, create/detail dialogs | V2 Private Tasks route |
| `dashboard-attorney.html#funds` | Payments | `from=settings`, `settingsTarget=payment-method|billing-history`, return/highlight state | V2 Payments route |
| `create-case.html` | Create/edit/resume Matter draft | `#details`, `#description`, `#review`; draft ID/editing Case parameters; return target | Nested V2 creation flow with draft guard |
| `case-detail.html?caseId=…` | Matter workspace for attorney/paralegal/admin | Matter ID plus tab/link context; unauthorized/missing/archive outcomes | V2 attorney Matter route; do not reuse shared V1 controller |
| Matter tabs | Overview, Applications, Work, Files, Messages, Activity, Financials | `overview`, `applications`, `work`, `files`, `messages`, `activity`, `financials` | Addressable nested routes or canonical query state |
| `browse-paralegals.html` | Directory/search/filter/sort/invite | page, state, specialty, years, availability, sort; authenticated action mode | Attorney V2 Paralegals route; public route remains separate |
| `profile-paralegal.html?paralegalId=…` | Candidate/public profile, invite/hire/pre-engagement | candidate ID; `returnTo`, applicant/Matter context | V2 candidate detail preserving safe return context |
| `profile-attorney.html` | Own or authorized attorney profile presentation | attorney/user ID, own edit links, back target | V2 Profile/preview route |
| `profile-settings.html` | Profile, security, notifications, preferences, account | hash destinations including personal/public/firm/notifications/security/closure | Attorney-owned V2 Settings routes; shared API only |
| `help.html` | Attorney help/incident intake | anchors for account, posting, hiring, workflow, tasks, payments/disputes, issue report | Decide public page vs authenticated V2 Help wrapper |
| `active-cases.html` | Legacy redirect | query/hash preservation to `#cases` | Keep until usage/deep-link evidence permits retirement |
| `case-applications.html` | Legacy candidate-review redirect | `openApplicants=1`, query/hash to inquiries | Keep and test until measured retirement |
| `billing-attorney.html` | Legacy Payments redirect | preserves source URL parameters into `#funds` | Keep and test until measured retirement |
| `create-case-step2.html` | Legacy description-step redirect | destination `create-case.html#description` | Keep and test until measured retirement |
| `create-case-step5.html` | Legacy review-step redirect | destination `create-case.html#review` | Keep and test until measured retirement |
| `login.html` and auth recovery | session entry/loss destination | intended return URL and safe role destination | Shared compatibility dependency, not rebuilt here |
| `attorney-faq.html`, terms/privacy/accessibility/contact | linked supporting content | anchors and authenticated header state | External/public dependency, not moved into V2 |

Before Phase 1, run a repository-wide link census across HTML, JavaScript, email templates, notification presentation, search/deep-link services, tests, and documentation. This table is the minimum set, not evidence that unlisted external bookmarks do not exist.

## 8. Current behavior and data dependency inventory

### 8.1 Session, shell, and onboarding

- `/api/auth/me`, `/api/users/me`, `/api/csrf`, `/api/auth/logout` provide identity/session/CSRF behavior.
- `/api/users/me/onboarding` reads/writes persisted onboarding; local/session storage also tracks tour progress and notices.
- Role must be exactly attorney for attorney routes; approval, disabled, deleted, and session-loss responses must prevent protected content.
- First-run sequence covers profile completion, payment method, and first Matter; replay/dismiss/complete semantics must be characterized.
- Sidebar collapse, profile identity/avatar, mobile drawer, Back/Forward, skip links, focus, and sign-out behavior are shared dependencies.

### 8.2 Home

- `/api/attorney/dashboard` supplies the consolidated overview.
- `/api/cases/my-active`, `/api/cases/my?...archived...`, `/api/applications/my-postings`, `/api/messages/threads`, `/api/messages/unread-count`, `/api/checklist?overdue=true`, and `/api/payments/payment-method/default` supplement it.
- Preserve recent Matters, active/completed/application/message/deadline summaries, onboarding attention, weekly notes, empty/error/loading states, and navigation to exact filtered destinations.
- The known risk that attorney escrow totals can differ from `/api/payments/summary` must be characterized; V2 must not choose a total formula.

### 8.3 Matter creation, drafts, edit, and deletion

- `/api/case-drafts` list/create, `/:draftId` get/update/delete.
- `/api/cases` publishes; `/:caseId` reads/edits/deletes within existing gates.
- Preserve autosave cadence, resume, draft identity, validation, exact fields, optional deadline, tasks/requirements, amount and fee preview, review step, publish notice, and return navigation.
- Publication currently creates Case and Job through backend behavior; V2 must not duplicate or simulate that state transition.
- Preserve amount lock after first application and task-scope lock after hire.
- Delete is only for eligible never-engaged open Matters. Do not label it unpublish/cancel if the server does not.
- Characterize publish-success/draft-delete-failure, duplicate submission, stale draft, two-tab edit, offline loss, and editing a now-ineligible Case.

### 8.4 Matters dashboard and applicant management

- `/api/cases/my`, archived/file variants, `/api/case-drafts`, `/api/applications/my-postings`, `/:caseId/applicants`, `/:caseId/invites`, `/:caseId/status-history`, `/:caseId/notes`.
- Preserve active/draft/archived/inquiries lists, 15-row pagination, filters, sort, saved views, URL state, status labels, unread/file summaries, preview, notes, invite state, application counts, and archive highlighting.
- Preserve star/shortlist/reject/revoke behavior through existing endpoints and authoritative Application plus Case mirror semantics.
- Preserve flags and resolution/request-edit flows where exposed.
- Stale or reconciliating mirrors must be shown safely and refreshed, not repaired client-side.

### 8.5 Candidate discovery, profile, invitation, pre-engagement, and hire

- Directory/profile reads use public presentation and authenticated `/api/paralegals`, `/api/users`, `/api/cases/my-active`, and signed document URLs.
- Invite uses `/api/cases/:caseId/invite` and must preserve target readiness, active block, ownership, open/relisted/unassigned Matter, amount-lock, duplicate/pending invite, and assigned-candidate gates.
- Pre-engagement uses request/respond/review endpoints and revision-aware workflow.
- Hire uses `/api/cases/:caseId/hire/:paralegalId`; saved payment method and pre-engagement approval are prerequisites where applicable.
- Pending hire state in `/api/users/me/pending-hire` bridges a payment-method setup/return; preserve it exactly and clear only through current behavior.
- Preserve safe candidate-document access, blocked profile outcomes, stale candidate/Matter handling, and payment cancellation/recovery.
- Never expose KYC, internal review, private profile fields, or another attorney's Matter context.

### 8.6 Workspace overview and authorization

- `/api/cases/:caseId` and `/api/cases/my` provide Matter and list projections; `/api/cases/:caseId/stream` provides lifecycle updates.
- V1 treats `in progress`/`in_progress` as funded workspace states and separately tracks readable versus writable workspace access.
- Preserve owner/assigned participant/admin distinctions, archived/read-only behavior, pause/dispute messaging, status history, selected Matter navigation, and stale-request rejection.
- Revalidate before every protected mutation and on stream/poll/session loss. A cached rendered Matter is not authorization.
- Clear confidential workspace data on logout, account switch, loss of access, or forbidden refresh; prevent BFCache disclosure.

### 8.7 Applications tab

- Preserve candidate ordering and fields, cover letters, documents, viewed state, shortlist/star/reject, invitation relation, pre-engagement status, hire eligibility, and closed/ineligible action state.
- Preserve accepted winner and rejected/nonwinning history as authorized.
- Mark-view side effects and count movement must match V1/backend characterization.
- Accept-vs-revoke, apply-vs-hire, two-attorney-tab hire, and stale revision conflicts require explicit UX recovery.

### 8.8 Work, tasks, deadlines, and activity

- Case-embedded tasks and revisions are distinct from private ChecklistTask records shown on `#tasks`.
- Events/deadlines use `/api/events`; Case also has current/legacy date fields. Assistant and dashboards merge some projections.
- Preserve create/edit/complete/reopen permissions, optimistic presentation only where safe, task revision/CAS conflicts, attorney-private versus participant-visible scope, event attendee responses/reminders, and audit/activity history.
- Do not merge Case deadline, legacy deadline, Event, embedded Case task, standalone Task, and ChecklistTask without an approved source contract.

### 8.9 Files and submissions

- Reads/uploads/deletes/security/downloads span `/api/uploads/case/:caseId`, `/api/uploads/view`, `/api/uploads/signed-get`, `/api/cases/:caseId/files`, and file status/revision/replace endpoints.
- Preserve type/size gates, scan status (`pending`, `clean`, `blocked`, `error`, `not_required`), safe view/download, progress/retry, participant ACL, review status, attorney approval/revision request, replacement lineage, and filename/metadata.
- Pending attachments are intentionally tab-memory only; V1 deletes the former `lpc_case_attachments` IndexedDB. V2 must not persist confidential legal-work attachments on shared devices.
- Do not treat an embedded Case file mirror as independently authoritative or repair it from the browser.

### 8.10 Messages

- `/api/messages/:caseId` supports thread/read/send; file, edit, reaction, delete, summary, unread-count, and thread-list endpoints supplement it.
- Preserve participant/access checks, text/file/audio/system types, sanitization, edit/delete/reaction semantics, read receipts/last-viewed behavior, unread badges, presence-aware notifications, and notification preferences.
- V1 combines Matter SSE, three-second polling fallback, snapshots, optimistic messages, and workspace presence heartbeats every 20 seconds.
- V2 should centralize realtime ownership but must preserve fallback and convergence semantics.
- Existing unread algorithms differ between endpoints. Lock the expected result in characterization tests before adopting one badge value.

### 8.11 Completion, withdrawal, disputes, payout, archive

- Completion uses `/api/cases/:caseId/complete`; it is gated by authoritative task/work/payment conditions and races with task updates/disputes.
- Withdrawal outcomes include zero, partial attorney decision, rejection/escalation, expiry, relist, and access revocation. Attorney endpoints include partial payout, reject payout, and relist.
- Disputes use `/api/disputes/:caseId` plus comments and admin-only settlement paths; attorney V2 exposes only currently authorized actions.
- Preserve `pausedReason`, payout-finalization type, termination/moderation states, notices, countdown/deadline evidence, and exact post-action destinations.
- Completion, dispute, or withdrawal must immediately update both roles' dashboards, workspace ACL, messages/files, notifications, search, Assistant evidence, payment views, and archive behavior according to current contracts.
- Never present client success until the authoritative response is confirmed; reconciliation/unknown outcomes require a recoverable pending state, not another mutation.

### 8.12 Payments

- `/api/payments/config`, payment-method default/setup, portal, escrow active/pending, intent/confirm/reconcile, summary/history/receipts/export, attorney receipt, and Case budget routes are relevant.
- Preserve SetupIntent return flow, default method presentation/change, portal handoff, active escrow table, exact amount/currency/date/status, history pagination/filtering, receipts, CSV export, and settings deep links.
- Preserve same-origin safe return URLs and never accept an arbitrary external redirect.
- Financial UI must distinguish charge/funding integrity, escrow, payout, refund, dispute settlement, reversal, and reconciliation rather than deriving one generic paid state.

### 8.13 Notifications, search, and Assistant

- Notifications use list, unread count, read/read-all, clear/dismiss, SSE stream, polling fallback, and workspace presence endpoints.
- Preserve actor/type-specific presentation, safe avatars, stale-action sanitization, role-safe object links, relative time, multi-center synchronization, and notification/email preference interaction.
- Global search uses authenticated search policy and role-safe deep links. Preserve rate limiting, query minimum/debounce, archive/withdrawal/blocked visibility, keyboard interaction, and 401/403/429 outcomes.
- Assistant uses support conversation/messages/events/feedback/restart/escalate endpoints and current context/evidence policies. Preserve role-aware prompts, Matter context, safe navigation validation, ticket state, privacy/retention, SSE/poll fallback, feedback, and escalation.
- Assistant context must be server-authorized. Browser route context is a hint, never evidence or permission.

### 8.14 Settings and account safety

- Profile/settings dependencies include `/api/users/me`, notification preferences, `/api/account/preferences`, dashboard saved views, password, 2FA/authenticator, passkeys, backup codes, sessions, deactivate status/action, and account deletion.
- Preserve reauthentication/challenge behavior, CSRF, password-manager/autocomplete semantics, passkey browser support/error handling, one-current-session protection, revoke-others, and destructive confirmations.
- Preserve restrictions preventing deactivation/deletion during active Matter, open dispute, or pending payout.
- Preserve mountain/mountain-dark preference compatibility. It is the only compatibility layer currently proven to affect real users; presentation migration requires a separate reversible owner-approved plan.

## 9. Shared versus attorney-specific ownership

| Concern | Classification | V2 rule |
|---|---|---|
| Attorney shell, Home, Matters, private Tasks, Payments | Attorney-specific | New attorney-owned modules and styles |
| Matter creation and attorney candidate review | Attorney-specific | New attorney-owned routes/components |
| Attorney side of workspace actions | Attorney-specific presentation | Consume shared APIs/contracts; do not edit paralegal V1/V2 controller |
| Candidate directory/profile | Mixed public/attorney | Separate public presentation from authenticated action adapter |
| Profile Settings document | Currently shared/role-conditional | Build attorney V2 view; reuse API contracts, not shared DOM |
| Session/CSRF/auth loss | Shared contract/infrastructure | Adapter boundary; coordinate changes, no unilateral edits |
| Notifications/search/Assistant | Shared service and UI behavior | Versioned integration interface; compatibility tests for both roles |
| Toast/dialog/focus primitives | Shared frontend candidate | Initially copy or consume stable interface; shared refactor requires coordinated approval |
| Case lifecycle/payment/readiness/blocking | Shared backend authority | Read-only dependency; never reimplement as UI policy |
| Realtime/SSE/presence | Shared protocol | One attorney V2 owner; preserve paralegal consumers |
| Status/amount/date presentation | Shared semantics, role-specific copy | Central V2 adapters backed by characterization fixtures |
| Public/help/legal pages | Shared/public | Link out unless owner approves authenticated wrapper |

Any change needed in a shared file must be raised as a compatibility request containing: consumer list, before/after contract, paralegal V1/V2 impact, tests, rollout ordering, and rollback. It is outside attorney V2 implementation authorization until separately approved.

## 10. Target V2 architecture

```text
Attorney V2 entry
├── session and role boundary
├── persistent attorney shell
│   ├── sidebar/navigation
│   ├── universal header
│   ├── search
│   ├── notifications
│   ├── Assistant
│   ├── dialog/toast/live regions
│   └── routed content viewport
│       ├── Home
│       ├── Matters / Applications
│       ├── Create or edit Matter
│       ├── Private Tasks
│       ├── Paralegal directory/profile
│       ├── Payments
│       ├── Attorney profile/settings/help
│       └── Matter workspace
│           ├── Overview
│           ├── Applications
│           ├── Work
│           ├── Files
│           ├── Messages
│           ├── Activity
│           └── Financials
└── attorney-owned adapters
    ├── API/CSRF/error/cancellation
    ├── normalized read models (presentation only)
    ├── lifecycle capability projection from server evidence
    ├── query cache and realtime invalidation
    ├── route/deep-link compatibility
    └── telemetry, accessibility, performance, and release identity
```

### 10.1 Architectural rules

- [ ] One attorney V2 entry and bootstrap path; no inclusion in paralegal V2 bundles.
- [ ] Persistent shell mounts once; only the content viewport changes.
- [ ] Real URLs support direct entry, refresh, Back/Forward, bookmarks, emails, and notifications.
- [ ] Route-level loaders/errors cannot blank or remount the shell.
- [ ] One session owner, one query/cache owner, one realtime owner, and one overlay/focus owner.
- [ ] Abort or ignore stale requests by user, route, Matter, tab, and request generation.
- [ ] Cache keys include role/user and Matter identity; clear confidential data on auth/access changes.
- [ ] Mutations invalidate every affected attorney projection; cross-role convergence remains server-driven.
- [ ] Client capability selectors may hide/disable actions but server authorization remains decisive.
- [ ] Unknown/reconciliation states fail closed and offer refresh/support, not speculative actions.
- [ ] Preserve drafts/typed text intentionally; never persist attachments or sensitive Matter content without an approved storage policy.
- [ ] Prevent duplicate listeners, streams, heartbeats, polls, uploads, and mutations across navigation.
- [ ] Shared integrations are wrapped behind versioned attorney adapters to avoid changing active paralegal work.

### 10.2 Proposed route model

Final paths require owner approval. Recommended canonical shape:

| V2 destination | Proposed path |
|---|---|
| Home | `/app/attorney/home` |
| Matters | `/app/attorney/matters` |
| Matter list state | `/app/attorney/matters?view=active|draft|archived|applications` |
| Create/resume/edit | `/app/attorney/matters/new/:step`, with safe draft/edit query identity |
| Workspace | `/app/attorney/matters/:caseId/:tab` |
| Private Tasks | `/app/attorney/tasks` |
| Paralegals | `/app/attorney/paralegals` |
| Candidate | `/app/attorney/paralegals/:paralegalId` |
| Payments | `/app/attorney/payments` |
| Profile | `/app/attorney/profile` |
| Settings | `/app/attorney/settings/:section` |
| Help | `/app/attorney/help` or current `help.html` |

Old URLs must continue to resolve during rollout. Redirects must preserve allowlisted query/hash meaning, reject unsafe return URLs, avoid loops, and be reversible.

## 11. Migration phases and gates

### Phase 0 — freeze and characterize

- [ ] Owner names the exact baseline commit and allowed in-progress shared dependencies.
- [ ] Record every attorney URL, query/hash parameter, link producer, email/notification/search link, and redirect.
- [ ] Capture synthetic golden fixtures at every lifecycle/status/authorization boundary.
- [ ] Add API contract snapshots for every endpoint V1 actually consumes, including errors and reconciliation states.
- [ ] Add cross-role projection tests before building UI.
- [ ] Record current accessibility, responsive, performance, and browser baselines.
- [ ] Create a defect register separated into confirmed defect, ambiguity, missing coverage, and desired V2 enhancement.

Exit: owner approves baseline, route ledger, endpoint ledger, characterization suite, and defect classifications. No unresolved P0 ambiguity affects the first V2 slice.

### Phase 1 — isolated foundation

- [ ] Add attorney V2 entry, feature flag/cohort resolver, release identity, auth boundary, router, shell, error boundaries, telemetry, and synthetic test harness.
- [ ] Integrate shared session/search/notifications/Assistant through adapters without modifying paralegal files.
- [ ] Prove direct entry, refresh, history, account switch, session loss, BFCache safety, and no V1 traffic impact.

Exit: shell tests pass at supported widths/browsers; disabled flag has zero observable V1 effect; rollback is a flag operation.

### Phase 2 — read-only Home and Matters

- [ ] Implement Home summaries and read-only active/draft/archived/application lists.
- [ ] Match counts, ordering, empty/error/loading states, dates, amounts, status labels, and deep links against V1 fixtures.
- [ ] Shadow-compare V1/V2 projections without changing records.

Exit: parity report has no unexplained P0/P1 differences.

### Phase 3 — private Tasks and candidate discovery

- [ ] Implement private checklist/task behavior, directory filters/pagination, candidate profile, documents, and safe return context.
- [ ] Keep invite/hire mutations disabled until characterization gates pass.
- [ ] Verify public versus authenticated candidate fields and block/readiness outcomes.

Exit: authorization and discovery matrix passes; paralegal routes/bundles unchanged.

### Phase 4 — Matter creation and management

- [ ] Implement draft autosave/resume, validation, review, publish, eligible edit/delete, notes, filters, saved views, and status history.
- [ ] Add idempotency/double-submit UX around existing server contracts without inventing guarantees.
- [ ] Test interrupted publication and draft cleanup independently.

Exit: synthetic create/edit/delete/draft scenarios match V1/backend; no live payments or production data.

### Phase 5 — applications, invitations, pre-engagement, and hire

- [ ] Implement viewed/star/shortlist/reject/revoke, invite, pre-engagement, pending-hire/payment return, and hire/fund presentation.
- [ ] Exercise concurrency and reconciliation outcomes.
- [ ] Prove both roles/admin see the authoritative movement after each action.

Exit: full applicant-to-funded-workspace cross-role suite passes with test provider; no duplicate financial mutation under retries/navigation.

### Phase 6 — workspace read-only foundation

- [ ] Implement authorized route, tabs, Overview, status/history, participant presentation, read-only Work/Files/Messages/Activity/Financials.
- [ ] Prove access-loss clearing, archived behavior, stale request isolation, and deep-link outcomes.

Exit: role/record matrix passes for open, funded, paused, completed, disputed, closed, archived, blocked, withdrawn, and deactivated conditions.

### Phase 7 — collaboration

- [ ] Implement messages/realtime/read state, uploads/security/downloads, file review/revisions, tasks/CAS, deadlines/events, and activity.
- [ ] Preserve polling fallback and reconnect behavior.
- [ ] Run multi-tab, offline/reconnect, scanner-race, large-file, and assistive-technology tests.

Exit: no divergence in authoritative records or unread/file/task projections; access loss stops streams and clears UI.

### Phase 8 — completion, disputes, withdrawal, archive, and financials

- [ ] Implement completion and its blocked/conflict states, withdrawal payout decisions/relist, dispute presentation/comments, receipts/history/export, and archive access.
- [ ] Cover payment unknown/reconciliation/failure/reversal/refund paths before happy-path polish is accepted.

Exit: money integrity and terminal lifecycle matrix passes across attorney/paralegal/admin projections using test evidence.

### Phase 9 — settings and global UX

- [ ] Implement attorney profile, security, notifications, preferences, sessions, passkeys/MFA, account actions, help, search, notifications, and Assistant parity.
- [ ] Preserve mountain-theme users through an approved compatibility layer; no preference rewrite.

Exit: complete route/API/accessibility/security suite passes and shared consumers remain compatible.

### Phase 10 — internal acceptance and dark launch

- [ ] Production-like synthetic environment only; seed deterministic personas and lifecycle records.
- [ ] Dark-load assets/endpoints where safe, shadow projections read-only, compare errors/performance, and verify release telemetry.
- [ ] Owner, legal/trust, support, accessibility, security, and payments reviewers sign their gates.

Exit: release candidate evidence satisfies `docs/RELEASE_GATES.md`; rollback drill succeeds.

### Phase 11 — reversible cohort rollout

- [ ] Explicit owner deployment authorization.
- [ ] Internal accounts, then synthetic/beta cohort, then small attorney percentages with hold periods.
- [ ] Cohort assignment is server-controlled, sticky, auditable, and instantly reversible.
- [ ] V1 remains available and receives compatible links throughout rollout.
- [ ] Monitor auth/403/404/409/429/5xx, mutation duplication, payment reconciliation, stale access, JS errors, vitals, support contacts, and parity deltas.

Exit: all cohort thresholds and minimum observation windows pass; no stop-ship condition.

### Phase 12 — V1 default-off and retirement

- [ ] Make V2 default only after owner approval; retain per-user/global fallback.
- [ ] Measure V1 route hits and legacy link producers through the approved window.
- [ ] Remove V1 code only in small, independently reversible packages after zero-usage/compatibility evidence.
- [ ] Retain redirect shims longer than implementation code and verify email/bookmark behavior.
- [ ] Archive immutable release/test evidence and update operating/support documentation.

Exit: every item in Section 16 and the Definition of Done is satisfied. Otherwise V1 remains.

## 12. Required test program

### 12.1 Characterization and contract

- [ ] Snapshot endpoint method/path, guards, request payload, response shape, aliases, pagination, sorting, side effects, and error codes.
- [ ] One fixture projected through attorney, paralegal, and admin surfaces after every lifecycle event.
- [ ] Case/Job and Application/Case applicant mirror success, stale, missing, and `needs_reconciliation` states.
- [ ] Static link producer and redirect contract prevents retired routes or direct Job-hire behavior from reappearing.
- [ ] V1/V2 differential reads for every route and status; documented exceptions require owner approval.

### 12.2 Lifecycle and concurrency

- [ ] Publish → apply → view → star/shortlist → pre-engagement revisions → hire/fund → collaborate → complete/payout/archive.
- [ ] Invite → accept/decline/revoke; duplicate and expired invite.
- [ ] Apply-vs-hire, accept-vs-revoke, hire-vs-delete, two-tab hire, task-complete-vs-completion, completion-vs-dispute, withdrawal-vs-completion, webhook-vs-reconcile.
- [ ] Delete only never-engaged open Matter; amount/task locks; absence of invented expiration/unpublish.
- [ ] Withdrawal zero/partial/rejected/expired/relist and subsequent hire using verified remaining balance.
- [ ] Dispute open/comment/admin resolution outcomes and post-resolution access.
- [ ] Unknown status and stale revision fail closed.

### 12.3 Money integrity

- [ ] No payment method, setup initiated/cancelled/succeeded, pending-hire return missing/stale/valid.
- [ ] Charge success/failure/timeout/unknown, duplicate callback, webhook ordering, reconciliation needed/succeeded/failed.
- [ ] Full/partial/zero payout, refund, settlement, transfer failure/reversal, chargeback presentation.
- [ ] Compare Case, Payout, PaymentOperation, PlatformIncome, FinancialAdjustment, webhook evidence, receipts, CSV, attorney totals, paralegal earnings, and admin views.
- [ ] Exact cents/currency/date/rounding; never floating-point reconstruction.
- [ ] Navigation, retry, refresh, Back, and double-click cannot duplicate a money mutation.

### 12.4 Authorization, privacy, and security

- [ ] Anonymous, pending, denied/rejected, wrong-role, disabled/deleted, owner/nonowner, participant/nonparticipant, admin/director as currently allowed.
- [ ] Direct URL/API denial matches hidden/disabled actions; UI hiding alone never counts.
- [ ] Reject, revoke, withdrawal, dispute, completion, block, deactivation, and session revocation tested against an already-open second tab.
- [ ] CSRF on every mutation; secure credentials/cookies; safe same-origin returns; no open redirects.
- [ ] XSS payloads in names, titles, bios, cover letters, messages, filenames, notes, task text, notifications, search, and Assistant output.
- [ ] Upload type/size/polyglot/scan/blocked/download authorization and signed URL expiry.
- [ ] No secrets, tokens, Matter content, PII, payment identifiers, or Assistant evidence in logs, analytics, URLs, local storage, error reports, or screenshots.
- [ ] Cache/BFCache/service-worker/account-switch tests prevent cross-user protected-data disclosure.
- [ ] Rate-limit and abuse outcomes for auth, search, messaging, invitations, uploads, support, and payment initiation.

### 12.5 Accessibility

- [ ] WCAG 2.2 AA automated scans plus manual keyboard and screen-reader review.
- [ ] Semantic landmarks, one `h1`, logical headings, skip links, page/route announcements, document titles.
- [ ] Visible focus, 44×44 targets where appropriate, contrast, zoom/reflow at 200% and 400%, text spacing, reduced motion, high contrast/forced colors.
- [ ] Router focus policy and preserved/restored focus for dialogs, drawers, menus, tabs, toasts, validation, and async updates.
- [ ] Roving tab keyboard behavior for workspace tabs; deep-linked tab announced correctly.
- [ ] Accessible names/descriptions/errors for create Matter, payment, pre-engagement, profile/security, search, upload, message composer, and destructive actions.
- [ ] Live regions do not duplicate or expose confidential content; loading/busy and reconciliation states announced.
- [ ] Screen readers: VoiceOver/Safari and NVDA/Firefox or Chrome at minimum.

### 12.6 Responsive and input modes

- [ ] Widths 320, 360, 390, 768, 1024, 1366, 1440, and 1920 CSS pixels; portrait and landscape where relevant.
- [ ] No horizontal loss at 320; tables become accessible cards/scroll regions without hiding amounts/actions.
- [ ] Safe-area insets, virtual keyboard, sticky composer/header, drawer layering, long names/titles/statuses, browser zoom.
- [ ] Touch, mouse, keyboard, trackpad; hover-independent actions; coarse pointer targets.
- [ ] Message/file/task/application lists with empty, one, many, very long, slow, and error data.

### 12.7 Browser and platform

- [ ] Current and previous major Chrome, Edge, Firefox, and Safari desktop.
- [ ] Current iOS Safari and Android Chrome; private browsing where storage/passkeys differ.
- [ ] History/deep links, downloads, uploads, drag/drop, clipboard, SSE reconnect, AbortController, Intl/time zone, passkeys, Stripe-hosted returns.
- [ ] Graceful behavior when optional browser capabilities, third-party cookies, popups, camera/microphone, or storage are unavailable.

### 12.8 Performance and reliability

- [ ] Budgets approved for JS/CSS bytes, request count, LCP, INP, CLS, memory, and long tasks on representative mobile/desktop profiles.
- [ ] Persistent shell does not refetch/remount global tools on route changes.
- [ ] Route code splitting and lazy heavy dependencies; reserve layout dimensions to prevent CLS.
- [ ] No N+1 candidate/file/message reads, duplicate polls/streams, leaked listeners/timers, or unbounded caches.
- [ ] 100+ Matters/applications/notifications, long threads, large file lists, slow 3G/4G, offline/reconnect, server 429/5xx, partial API failure.
- [ ] SSE-to-poll fallback, reconnect jitter/backoff, tab visibility, and only one effective presence owner per visible workspace.
- [ ] Route-level failure preserves shell and unaffected cached views while confidential stale data follows access rules.

### 12.9 Cross-role and operational

- [ ] Attorney action appears correctly for assigned paralegal and admin without requiring an unsafe refresh.
- [ ] Paralegal action appears correctly for owning attorney and admin.
- [ ] Notifications, unread counts, search, Assistant, email/deep links, and dashboard totals agree after transitions.
- [ ] Legacy V1 attorney and paralegal clients remain compatible while an attorney uses V2.
- [ ] Mixed-version actions and rollback mid-session do not duplicate mutations or strand URLs.
- [ ] Synthetic support runbooks cover pending payment, reconciliation, lost access, blocked upload, stale application, and V1 fallback.

## 13. Rollout, monitoring, and rollback

### 13.1 Release controls

- V1 and V2 must be separately addressable builds with immutable release IDs.
- Global kill switch and per-cohort route decision must not require a rebuild.
- Cohort state must be sticky but overridable for support; no URL should trap a user in V2.
- Database/API/Stripe compatibility remains backward compatible for the entire mixed-version window.
- Do not deploy unrelated backend or paralegal changes in the same attorney V2 release candidate.

### 13.2 Stop-ship/automatic rollback signals

- any unauthorized protected data display or stale-tab access after revocation;
- any duplicate, missing, incorrectly valued, or unexplained payment/hire/completion/dispute mutation;
- any increase in `needs_reconciliation` attributable to V2;
- material V1/V2 count, status, ACL, receipt, or lifecycle divergence;
- auth/CSRF/session/logout regression or cross-account cache leak;
- broken legacy email/notification/search/bookmark links;
- sustained route error, JS exception, performance, accessibility, or support thresholds beyond approved budgets;
- inability to identify release/cohort or execute the rollback drill.

### 13.3 Frontend rollback procedure

1. Freeze rollout and record incident/release/cohort/time window.
2. Disable attorney V2 routing globally while leaving backend/data untouched.
3. Redirect canonical V2 routes to mapped V1 destinations with safe Matter/draft/tab/filter context.
4. Invalidate V2 assets/caches as required without clearing authoritative server state or resubmitting mutations.
5. Verify login, Home, Matters, affected Matter, payment history/receipt, notifications, search, and both-role visibility on V1.
6. Reconcile any in-flight external/payment operation using existing operational procedures; never repair from browser state.
7. Observe stability, communicate to support/owners, and preserve evidence before deciding forward-fix or redeploy.

The broader service rollback procedure in `ROLLBACK_PLAN.md` applies only if a separately authorized backend/service release is involved. Attorney V2 should be independently reversible without rolling back shared services.

## 14. Existing defects and ambiguities — separate from V2 design

These repository findings require characterization or owner classification. They must not be silently fixed by V2:

| ID | Finding | Classification/action before affected phase |
|---|---|---|
| A-01 | Attorney dashboard escrow total may disagree with authoritative payment summary and can show zero | Characterize money projection; payments owner decides defect |
| A-02 | Message unread count, summary, thread, and last-viewed predicates differ | Characterize one fixture across endpoints; do not select a formula |
| A-03 | Case/Job edit and relist mirrors may omit discovery/matching fields | Existing distributed-state risk; backend owner defect decision |
| A-04 | Application and Case applicant mirrors can enter reconciliation and counts can diverge | Preserve evidence; test UI pending/retry state |
| A-05 | No dedicated unpublish or Matter-expiration transition exists | Preserve absence; copy must not invent it |
| A-06 | Case deadline, legacy deadline, Event, Case task, Task, and ChecklistTask have overlapping projections | Owner must approve source/presentation contract |
| A-07 | `Case.status` and funded-workspace normalization is duplicated in dashboard/workspace clients | Characterize aliases; V2 presentation adapter only |
| A-08 | Profile Settings uses role-conditional paralegal-first markup and shared assets | Architectural coupling; build isolated attorney view |
| A-09 | V1 workspace falls back among multiple Case/file endpoints | Determine canonical read contract without removing fallbacks |
| A-10 | Legacy redirect usage is unmeasured | Retain until logs/analytics prove safe retirement |
| A-11 | Job/Case, Application/mirror, identity/profile/state/practice/status alias dependency remains unknown | Retain; active callers and an unclassified workflow remain |
| A-12 | Mountain/mountain-dark preferences are a confirmed real-user compatibility dependency | Separate reversible migration required; no retirement here |
| A-13 | Recommendation history exclusion is contradicted in paralegal client behavior | Cross-role dependency only; do not alter from attorney V2 |
| A-14 | General Assistant and specialized withdrawn-paralegal evidence policies differ | Preserve named boundary and add cross-role contract test |

Each confirmed defect needs an owner, severity, reproduction, authoritative expected behavior, separate change authorization, regression tests, and release note. V2 parity may intentionally reproduce a non-security defect until that process completes. Security/payment/authorization defects are stop-ship and must not be knowingly reproduced without explicit risk resolution.

## 15. Open owner decisions

- [ ] Exact clean baseline commit after separating active paralegal work.
- [ ] Canonical V2 URL prefix and whether Help remains public or gets an authenticated wrapper.
- [ ] Framework/build approach, provided it stays attorney-isolated and meets CSP/deployment constraints.
- [ ] Which shared frontend integrations are consumed as-is, wrapped, or versioned; who owns compatibility approval.
- [ ] Authoritative display source for attorney Home/payment totals.
- [ ] Named contract for deadlines and private versus shared tasks.
- [ ] Expected unread equivalence across summary/count/thread/read endpoints.
- [ ] V2 policy for safe persistence of text drafts; attachment persistence remains prohibited absent new approval.
- [ ] Whether archived Matter workspace is a read-only V2 route or archive-download/detail presentation.
- [ ] Exact handling/copy for pending, unknown, and `needs_reconciliation` financial/lifecycle states.
- [ ] Supported browser versions, accessibility test matrix, and quantitative performance budgets.
- [ ] Cohort sizes, hold times, success/error/support thresholds, and named go/no-go owner.
- [ ] Required V1 observation window and acceptable residual usage before each redirect/code retirement.
- [ ] Separate owner/date for mountain-theme migration, if any.
- [ ] Ownership and disposition for A-01 through A-14.

Unanswered decisions do not block read-only discovery, but they block implementation of the affected phase and all retirement.

## 16. V1 compatibility and retirement requirements

### 16.1 Compatibility ledger

For every V1 artifact, record owner, current consumers, external link sources, storage keys, APIs, cookies/session assumptions, CSP/assets, feature-flag behavior, V2 replacement, tests, traffic evidence, and rollback destination. Minimum artifacts:

- all route entries and redirect shims in Section 7;
- dashboard hash/query parsing and saved view parameters;
- Matter/candidate/draft IDs and return/highlight parameters;
- onboarding/tour/case-posted/pending-hire/local/session storage keys;
- shared session, header/sidebar, notification, search, Assistant, context, toast/dialog, and Stripe helpers;
- V1 status/amount/date/presentation normalizers and endpoint fallbacks;
- email, notification, Assistant, search, and server object-deep-link producers;
- service-worker/CDN/cache behavior if present in the deployment environment.

### 16.2 Retirement gates per artifact

An artifact may be removed only when all are true:

- [ ] V2 replacement is accepted and enabled for 100% of eligible attorney traffic for the approved observation period.
- [ ] No unresolved P0/P1 parity, security, accessibility, money, or cross-role defect exists.
- [ ] Repository link census shows no active producer except intentional compatibility tests/redirects.
- [ ] Access logs/analytics show usage below the owner-approved threshold, with bots/tests separated from users.
- [ ] Email/notification/bookmark/direct-entry and rollback mappings are proven.
- [ ] Mixed-version and rollback tests pass without the artifact's implementation code.
- [ ] Support and operations documentation no longer instructs users to depend on it.
- [ ] Owner approves the exact deletion package after reviewing `git diff --stat` and path list.
- [ ] Deletion does not touch paralegal V1/V2 or an unversioned shared dependency.
- [ ] Recovery method and retained release artifact are documented and drilled.

### 16.3 Required order

1. Stop generating new V1 links, while both versions still accept them.
2. Make V2 default with immediate V1 fallback.
3. Observe and resolve residual legitimate V1 usage.
4. Remove attorney-only V1 page implementation in small packages.
5. Retain and monitor compatibility redirects.
6. Remove attorney branches from shared code only through a separately coordinated shared-infrastructure project.
7. Retire redirects last, individually, with external-link evidence.

Job/Case, Application/Case applicant, identity/profile/state/practice/status aliases, and mountain theme compatibility are not frontend-page cleanup and cannot be retired by this plan.

## 17. Exact definition of done

The attorney V2 migration and V1 retirement are complete only when:

- [ ] Every attorney-authenticated route, nested state, query/hash parameter, redirect, and external deep-link producer has an accepted V2 destination.
- [ ] Every behavior and endpoint in Sections 7–8 has characterization evidence for success, empty, validation, authorization, conflict, rate-limit, unavailable, network, stale, unknown, and reconciliation outcomes as applicable.
- [ ] Exact backend lifecycle, payment, authorization, Stripe, schema, API, record, and compatibility contracts remain unchanged unless a separately approved defect fix says otherwise.
- [ ] Full publish-to-terminal lifecycle and all branch/race scenarios pass across attorney, paralegal, and admin projections.
- [ ] Payment evidence reconciles exactly across all authoritative records and every role-facing view; no duplicate mutation is possible through tested client behavior.
- [ ] Session loss, account switch, access revocation, blocking, deactivation, and BFCache tests prove protected data cannot remain accessible.
- [ ] Messages, files, scans, tasks, deadlines, applications, notifications, search, and Assistant pass realtime/poll/reconnect/stale-tab tests.
- [ ] Accessibility acceptance meets WCAG 2.2 AA with automated and named manual screen-reader/keyboard evidence.
- [ ] Responsive, browser, device/input, performance, reliability, and high-volume budgets pass on the approved matrix.
- [ ] Paralegal V1 and V2 files are unchanged by attorney work, and cross-role/shared compatibility suites pass.
- [ ] The defect register is resolved, explicitly deferred by the proper owner, or classified as stop-ship; none is hidden as V2 design.
- [ ] Release gates, security review, legal/trust copy review, support readiness, observability, and release identity are signed.
- [ ] Global/per-cohort rollback has been drilled from a mixed-version, in-flight-session state without data change or duplicate mutation.
- [ ] V2 has completed approved cohort stages and observation periods below all thresholds.
- [ ] Each V1 artifact has independently satisfied Section 16 retirement evidence and exact deletion approval.
- [ ] Legacy redirects are retained until separately proven unused and safe to remove.
- [ ] Immutable audit, test, rollout, rollback, compatibility, and owner-decision evidence is archived.
- [ ] The owner provides final written authorization that attorney V2 is accepted and the specified attorney V1 artifacts may be retired.

Until every applicable checkbox is satisfied, the correct status is **migration incomplete; V1 compatibility retained**.

## 18. Deliverables required before implementation authorization

- [ ] Clean-baseline record and protected path list for paralegal/shared work.
- [ ] Machine-readable route/deep-link ledger.
- [ ] Endpoint/request/response/error/guard ledger.
- [ ] Shared-versus-attorney ownership manifest.
- [ ] Synthetic lifecycle fixture catalog and cross-role visibility matrix.
- [ ] V1 screenshots/accessibility/performance/browser baseline.
- [ ] Defect and ambiguity register with owner decisions.
- [ ] Approved V2 architecture decision record and route map.
- [ ] Phase-by-phase test plan with traceability from every dependency to tests.
- [ ] Feature-flag/cohort/telemetry and rollback design.
- [ ] V1 artifact-by-artifact retirement ledger.

This document is the audit and migration/retirement plan. It intentionally performs none of those implementation tasks.
