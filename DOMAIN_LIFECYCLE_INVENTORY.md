# LPC domain lifecycle inventory

Audit date: 2026-08-29
Audited snapshot: commit `13baf5d1` plus the pre-existing working-tree changes listed below
Method: repository-wide, read-only trace of models, routes, services, jobs, webhooks, frontend consumers, and tests. No production data was queried or mutated and no production behavior was changed.

## Baseline scope and authority

This document describes the implementation as it exists, including legacy aliases and inconsistencies. It does not propose a replacement lifecycle.

The working tree was already modified when the audit began. Those changes are part of the audited snapshot: `backend/models/Case.js`, `backend/models/Job.js`, `backend/routes/cases.js`, `backend/routes/jobs.js`, `backend/routes/paralegalDashboard.js`, `backend/tests/matchingDiscovery.test.js`, `frontend/assets/scripts/global-search.js`, `frontend/assets/scripts/paralegal-dashboard.js`, `frontend/create-case.html`, and `frontend/dashboard-paralegal.html`.

The lifecycle is distributed rather than represented by one record:

| Concern | Authoritative record | Mirrors or derived state |
|---|---|---|
| Matter engagement, workspace, funding and completion | `Case` | `Job.status`, `Application.status`, dashboard projections |
| Public/open opportunity | `Job`, linked to `Case` when available | `/api/jobs/open`, Case-based relist candidates |
| Application history | `Application` | `Case.applicants`, `Job.applicationsCount` |
| Invitation history | `Invitation` | Accepted/rejected `Application` and Case applicant mirrors |
| Funding evidence | `Case.escrow*` and `fundingIntegrity` plus Stripe | `PaymentOperation`, webhook records, payment views |
| Payout evidence | `Payout`, `PaymentOperation`, Stripe transfer | Case payout fields and receipt projections |
| Messages/files/deadlines | `Message`, `CaseFile`, `Event`; Case embeds file/task/deadline mirrors | unread counts, dashboard rows, Assistant projections |
| Notifications | `Notification` | SSE event, email, client-loaded unread count |
| Blocking | `Block` | legacy `User.blockedUsers` paths remain |

## Exact status vocabulary

| Record/field | Statuses accepted by current code |
|---|---|
| `User.role` | `attorney`, `paralegal`, `admin`, `director` |
| `User.status` | `pending`, `approved`, `denied`, `rejected` |
| account switches | `isDisabled`, `isDeleted`; deletion workflow also sets `status: denied` |
| availability | `availabilityDetails.status`: `available`, `unavailable`; legacy `availability` string |
| KYC | `unverified`, `pending_review`, `verified`, `rejected` |
| profile photo review | `unsubmitted`, `pending_review`, `approved`, `rejected` |
| `Case.status` | `open`, `in progress`, `in_progress` (legacy enum), `paused`, `completed`, `disputed`, `closed` |
| normalized Case aliases | `in_progress` → `in progress`; `cancelled`/`canceled` → `closed`; `assigned`/`awaiting_funding` → `open`; `active`/`awaiting_documents`/`reviewing`/`funded_in_progress` → `in progress` |
| persisted Case transitions | `open` → `in progress` or `closed`; `in progress` → `paused`, `completed`, `disputed`, or `closed`; `paused` → `in progress`, `disputed`, or `closed`; `completed` → `disputed` or `closed`; `disputed` → `paused` or `closed`; `closed` is terminal |
| viewer-only `CASE_STATE` | `draft`, `open`, `applied`, `funded_in_progress`; `draft` is a `CaseDraft`, and `applied`/`funded_in_progress` are derived rather than persisted Case statuses |
| `Job.status` | `open`, `in_review`, `assigned`, `closed` |
| `Application.status` | `submitted`, `viewed`, `shortlisted`, `accepted`, `rejected`, `withdrawn` |
| application/invitation sync | `pending`, `synced`, `needs_reconciliation` |
| invitation | `pending`, `accepted`, `declined`, `expired` |
| pre-engagement | `requested`, `submitted`, `approved`, `changes_requested` |
| conflict response | empty, `none_known`, `disclosure` |
| Case file review | `pending_review`, `approved`, `attorney_revision` |
| file security | `pending`, `clean`, `blocked`, `error`, `not_required` |
| dispute | `open`, `resolved`, `rejected` |
| pause reason | `paralegal_withdrew`, `attorney_paused`, `dispute`, or null |
| payout finalization | `zero_auto`, `partial_attorney`, `full`, `admin`, `expired_zero`, or null |
| payout processing | `not_started`, `pending`, `paid`, `failed`, `reversed`, `needs_reconciliation` |
| termination | `none`, `auto_cancelled`, `disputed`, `resolved` |
| moderation | `none`, `flagged`, `resolution_requested` |
| posting mirror | `synced`, `needs_reconciliation` |
| hire/completion claim | `claimed`, `needs_reconciliation`, or null |
| funding integrity | `pending`, `verified`, `failed` |
| payment operation kind | `case_payout`, `partial_payout`, `dispute_settlement`, `refund` |
| payment operation status | `pending`, `succeeded`, `failed`, `needs_reconciliation` |
| webhook processing | `received`, `processing`, `processed`, `failed` |
| Block source scope | `resolved_dispute`, `withdrawal_zero_payout`, `withdrawal_partial_payout`, `closed_case`, `application_screening`, `legacy`, or empty |
| message role/type | roles `attorney`, `paralegal`, `admin`, `system`; types `text`, `file`, `audio`, `system` |
| event | response `needsAction`, `accepted`, `declined`, `tentative`; type `deadline`, `meeting`, `call`, `court`, `misc` |
| standalone Task | `todo`, `in progress`, `review`; Case scope tasks instead use a `completed` boolean |

## Domain event inventory

Each row includes actor, gate, authoritative write, dependent records/values, affected surfaces, and the principal test or risk. “Admin” includes director only where the route's role guard does.

### Accounts, eligibility, availability and restrictions

| Event | Actor and preconditions | Authoritative change and dependent effects | Surfaces and expected visibility | Coverage, contradiction or risk |
|---|---|---|---|---|
| Register attorney | Visitor; valid identity, email, bar state/number, password and fee acknowledgement | Create pending attorney; verification artifacts/email | Login remains unavailable until email verified and admin approved; admin queue gains account | Registration/auth tests exist; no end-to-end cross-role test through first funded matter |
| Register paralegal | Visitor; résumé PDF and at least one year supplied | Create pending paralegal and résumé metadata | Admin queue gains account; no recommendations/applications until approval | Registration/file tests exist; approval-to-first-application characterization is missing |
| Approve/deny/suspend | Admin; pending or eligible account | `User.status`; suspend normalizes to `denied`; sessions/access follow current guard behavior | Login, directory, dashboards and admin lists change | Vocabulary drift: schema also accepts `rejected`, but admin normalization uses `denied` |
| Authenticate request | Any signed-in account | `verifyToken` reloads current User; denies disabled/deleted; `requireApproved` requires exact `approved` | All authenticated surfaces | Strong route coverage, but cross-tab revocation timing depends on next request |
| Update availability | Paralegal | Structured `availabilityDetails` and legacy display string | Profile/dashboard availability and public browse filtering update | Availability is not a recommendation, application, invitation or hiring gate. `/users?available=true` regex can match “Unavailable” because it contains “available” |
| Complete payout onboarding/KYC/photo review | Paralegal, Stripe, or admin/reviewer depending field | User/Stripe readiness fields | Apply/invite/hire CTA eligibility, payout setup warnings, public/profile presentation | Gates are repeated in applications, invitations and hiring; exact cross-role readiness matrix lacks one integrated test |
| Deactivate account | Account owner; no active matter, open dispute or pending payout | Disable/delete/status fields; reject applications and embedded mirrors, expire invitations, close open Jobs and unfunded open Cases; revoke sessions | User disappears from active participation while historical/financial records remain | `accountDeactivation.test.js` covers primary path; multi-record operations create partial-failure risk |
| Scheduled personal-data removal | Automation; retention/deactivation conditions met | Minimize identifiers/files or fully delete unused account; preserve required ledgers/history | Admin/history and receipts remain, personal fields disappear | `dataRemoval.test.js`; retention boundary and file deletion retries remain operational risks |
| Block future interaction | Attorney/paralegal; qualifying finalized dispute, withdrawal or completed/closed outcome; not an active/open dispute | Active `Block` pair | Profiles/jobs hidden; apply, invite, hire, messages and relevant deep links denied | `blockingRules.test.js`; canonical Block and legacy `User.blockedUsers` are duplicate sources |
| Unblock | Blocking party | Block becomes inactive | Discovery and future interaction return subject to other gates | Tested at route level; cache/multi-tab refresh not comprehensively characterized |

### Matter posting and discovery

| Event | Actor and preconditions | Authoritative change and dependent effects | Surfaces and expected visibility | Coverage, contradiction or risk |
|---|---|---|---|---|
| Autosave draft | Attorney | Create/update `CaseDraft` with `draft` state | Create-Matter resume flow only; not Browse/search/recommendations | Draft deletion after publish is frontend-driven and not transactional with publication |
| Publish/create matter | Attorney (or admin route authority); attorney has saved payment method; title/details/practice area; amount ≥ $400; optional valid deadline | Create `Case(open)` and `Job(open)`; email/admin signal/audit; rollback Case if Job creation fails | Attorney Home/postings, admin surfaces, paralegal Browse/search/recommendations become eligible | `jobEscrow.test.js`, `lifecycleTransitions.test.js`; Case/Job are still separate writes and two posting paths enforce different details |
| Edit open matter | Owning attorney/admin; attorney non-task fields only while open/unhired; budget locked after first application; task scope locked on hire except completion | Update Case; task completion uses `taskRevision` CAS | Attorney detail/dashboard; eligible discovery should reflect edits | Current Job mirror update covers experience fields but not all title/practice/details/budget/state/deadline fields, so Browse/recommendations may be stale |
| Unpublish/cancel | No dedicated canonical event was found | Never-engaged open matters can be deleted; legacy `cancelled`/`canceled` normalize to `closed` | Deletion removes posting; active funded termination uses dispute workflow instead | UI wording must not imply a separate lifecycle status/action that code does not have |
| Delete matter | Owning attorney/admin; Case is open, never hired/funded/disputed | Delete Case, related Jobs and Applications through sequential operations | Remove from all dashboards, Browse, search, recommendations and deep links | Lifecycle tests cover rejection after funding/completion; nontransactional cascade can leave orphans |
| Expire matter | No Case/Job posting-expiration transition found | None | Open matter remains until another event changes it | Invitation expiry and data purges exist; “matter expiration” is currently absent and should be characterized, not invented |
| Relist after withdrawal | Withdrawal service/automation or attorney decision; withdrawal finalized and remaining scope/value eligible | Case stays paused with prior paralegal removed; `relistRequestedAt`/payout finalization; `ensureCaseJobOpen` opens/creates Job | Browse/search/recommendations return; prior application history should remain excluded but currently may not | Strong withdrawal tests; relisted Job creation omits some matching metadata and can derive state from attorney rather than Case |
| Discover in Browse | Approved paralegal | `/api/jobs/open` merges open Jobs and eligible Case relists, suppresses blocks/assigned/final records; annotates non-withdrawn applications | Browse/search-result cards and Details links | It is a browse feed, not a server recommendation engine; Job/Case dual IDs and stale mirrors are risks |
| Recommend matter | Client on paralegal Home; profile has state/practice/years and open feed loaded | No server write. Client ranks state **or** practice match and rejects requirements above years; excludes IDs in its active-application cache | Recommended section only | Historical withdrawn/rejected/inactive applications are not retained in that cache and can reappear. This fails the required eligibility rule; see dedicated finding below |

### Applications, invitations and candidate review

| Event | Actor and preconditions | Authoritative change and dependent effects | Surfaces and expected visibility | Coverage, contradiction or risk |
|---|---|---|---|---|
| Apply | Approved paralegal; no active block; payout/photo readiness; Job and linked Case open/relisted/unassigned/nonarchived; cover letter ≥ 20 chars | Create `Application(submitted)` or reuse withdrawn record; add Case applicant mirror; increment Job count; lock Case amount; notify/email attorney | Paralegal Applications; attorney applicant queue/count/badge/notification | `caseFlowNotifications.test.js`, `matchingDiscovery.test.js`; mirror writes can enter `needs_reconciliation` |
| View application | Attorney owner | `Application.viewed` and Case mirror/status history | Attorney review queue changes; paralegal status presentation can change | Covered in application flow; two-record update risk |
| Shortlist/unshortlist/star | Attorney owner | Application and Case applicant mirror fields/status | Attorney candidate ordering/filter; paralegal application status where exposed | Service tests exist but full dashboard reflection is not cross-role tested |
| Reject application | Attorney owner; candidate active | `Application.rejected`, Case mirror rejected, counts/history; notification/email | Remove from active attorney queue; paralegal Applications stops showing it under current active filter; notification/deep link becomes historical/safe | Rejected history is then absent from recommendation exclusion, so matter can reappear but duplicate apply is rejected server-side |
| Withdraw pre-hire application | Applying paralegal; active application | `Application.withdrawn`, remove Case applicant mirror, resync Job count | Disappears from Applications and attorney active queue; historical notification/deep links sanitize | `/api/applications/my` excludes it and the apply route reuses it, so matter can be recommended again and reapplied to |
| Invite paralegal | Attorney owner; open/relisted unassigned Case, no block, approved and payout-ready target | `Invitation(pending)`; Case amount lock; notification/email | Attorney invitation management; paralegal invitation modal/list/count/notification | Invite tests are extensive; readiness logic is duplicated from apply/hire |
| Accept invitation | Invited paralegal; invitation pending and matter still eligible | Invitation accepted; create/update Application submitted and Case mirror | Invitation moves out; Applications and attorney applicant queue gain candidate | Sync can be `needs_reconciliation`; accept/hire races require characterization |
| Decline invitation | Invited paralegal | Invitation declined; related Application rejected when present | Remove from active invites/candidate queue; preserve history | Covered in flow tests; recommendation history exclusion for invite-derived rejection is not covered |
| Revoke invitation/application | Attorney owner | Pending invite expires/revokes; accepted relationship may become Application withdrawn and Case mirror removed | Both roles' active queues update; stale notification action suppressed | Tested; exact refresh across already-open tabs is not |
| Request pre-engagement information | Attorney owner; selected active candidate; matter tasks and at least one requirement | Pre-engagement `requested`, revision/state history; notify | Attorney candidate panel and paralegal response surface | `caseFlowNotifications.test.js`; duplicate sources around candidate status remain |
| Submit/respond | Requested paralegal; state requested/changes_requested and revision matches | `submitted` plus answers/conflict response and revision | Attorney review action appears; paralegal becomes read-only pending review | CAS tests exist |
| Approve/request changes | Attorney owner; submitted and matching revision/status | `approved` or `changes_requested`; notification | Hiring becomes eligible only on approval when requirements exist | Covered; multi-tab stale revision handled by CAS |

### Hiring, funding and active workspace

| Event | Actor and preconditions | Authoritative change and dependent effects | Surfaces and expected visibility | Coverage, contradiction or risk |
|---|---|---|---|---|
| Hire and initial fund | Attorney owner; active/accepted candidate; Case tasks; target approved/payout ready/unblocked; saved payment method; pre-engagement approved if present | Claim hire; charge/verify Stripe funds; persist escrow evidence; assign paralegal aliases, `hiredAt`, Case `in progress`; lock tasks; Job `assigned`; winning app accepted, others rejected; notifications | Attorney and paralegal Active Matters/workspace; posting disappears; candidate queues close; payment views update | Strong concurrency/escrow tests. Multiple records plus external Stripe create reconciliation paths |
| Hire on relisted funded balance | Attorney owner; prior withdrawal finalized and remaining verified escrow; eligible new candidate | Reuse verified remaining funding and reassign Case; update Job/apps/invites | Same active-workspace transition without a new full charge | Withdrawal/job escrow tests; relist metadata and stale posting risk |
| Start/confirm/reconcile escrow | Attorney or Stripe callback/webhook; owned eligible Case | Case escrow/funding-integrity fields, PaymentOperation/webhook evidence | Funding state, hire readiness, payment views and notifications | Funding exists both inside hire and `/payments` routes; duplicate authority/race risk |
| Open workspace | Assigned attorney/paralegal (admin where allowed); hired, funded, `in progress`, nonarchive, non-read-only, no active block; paralegal access not revoked | Read only unless a sub-action writes | Workspace, Messages, files, tasks, deadlines and Assistant become available | ACL tests are strong; direct links intentionally return 403/404 after eligibility ends |
| Terminate active funded matter | Attorney; active engagement | Open dispute; Case `disputed`, pause reason `dispute`, termination `disputed`; revoke paralegal access | Workspace/message/file access closes for paralegal; dispute/admin/payment surfaces appear | Not a simple cancellation; stale open tabs may retain rendered content until request/refresh |

### Workspace collaboration

| Event | Actor and preconditions | Authoritative change and dependent effects | Surfaces and expected visibility | Coverage, contradiction or risk |
|---|---|---|---|---|
| Send/edit/delete/react to message | Active workspace participant; funded active Case and no block | Message create/update/soft-delete/read metadata; optional Notification/email/SSE subject to preferences, presence and cooldown | Thread, unread count/badges, notification center, email | `messagingNotifications.test.js`; unread algorithms disagree between endpoints (see risk report) |
| Mark messages read/open thread | Participant | Read receipts/readBy and/or `User.messageLastViewedAt`, depending endpoint | Message badge, thread unread and dashboard unread | GET thread updates last-viewed but explicit read updates both; counts can diverge |
| Upload file | Active workspace participant; scan/type/size gates | Object storage plus `CaseFile` and Case file mirror; security state | Files list, message attachment, Assistant metadata, attorney review | `uploadsDownloads.test.js`, ACL tests; two file representations and scanner callbacks can drift |
| Approve/request file revision/replace | Authorized party under current file rules | CaseFile and Case mirror review/revision fields | Both workspace file views, notifications, Assistant | Route coverage exists; cross-role dashboard-to-workspace reflection is limited |
| Create/update deadline/event | Event owner; optional accessible Case link | Owner-specific `Event`; Case matter deadline separately uses `deadlineDate` plus legacy Date mirror | Calendar/dashboard deadline areas and Assistant | Events are not a shared Case calendar; dashboards/Assistant merge different sources and legacy fallbacks |
| Complete/reopen scope task | Workspace participant under role rules; matching `taskRevision`; not blocked by completion claim | Embedded `Case.tasks[].completed`, revision and audit | Both workspaces, progress/totals, completion readiness, Assistant | CAS and completion tests exist. Standalone `Task` collection is a separate Assistant source and not the Case scope authority |
| Submit work/request revision/approve | Implemented through file/task review and Case task-completion semantics rather than a single submission aggregate | File review states and embedded task state; no newly invented submission status | Workspace review controls and notifications | Terminology is spread across files/tasks; no single end-to-end “submission” record/lifecycle |

### Withdrawal, disputes, completion and archives

| Event | Actor and preconditions | Authoritative change and dependent effects | Surfaces and expected visibility | Coverage, contradiction or risk |
|---|---|---|---|---|
| Withdraw from active matter | Assigned paralegal; Case in progress, unfinished tasks, no open dispute/completion claim; matching task revision | Remove paralegal aliases, set `withdrawnParalegalId`, Case `paused`, reason `paralegal_withdrew`, revoke access | Active Matter disappears; historical/withdrawal payment card appears; attorney action and notifications appear; workspace deep link closes | `withdrawalLifecycleJobs.test.js`, concurrency tests |
| Zero-work withdrawal finalize | Service; zero completed tasks | `payoutFinalizedType: zero_auto`, timestamps; Job relisted/open | Matter returns to discovery for other eligible paralegals; former paralegal has read-only historical/payment evidence | Tested; former paralegal recommendation exclusion currently fails through historical application filtering |
| Partial-work attorney decision | Attorney; withdrawal awaiting decision | Partial transfer up to implemented cap/remaining amount, or reject payout and start dispute window | Payment views, former paralegal dispute CTA, relisted opportunity after finalization | Covered by withdrawal/payment tests; money operations use reconciliation states |
| Withdrawal dispute/expiry | Withdrawn paralegal within window, admin, or automation after window | Dispute state or `expired_zero`; settlement/finalization and relist | Admin dispute queue, both payment histories/notifications, Browse | Automation and dispute tests; clock-bound refresh and duplicate-worker idempotency remain risks |
| General dispute open | Eligible participant under route-specific state | Case `disputed`, Dispute open, access/payment holds | Active workspace closes or pauses; admin and role dispute/payment views appear | `disputesRefunds.test.js`; completion/dispute races are tested |
| Resolve dispute/refund/release | Admin; open dispute and valid allocation/action | Dispute resolution, Case/PaymentOperation/Payout/refund/transfer state; notifications | Admin queue clears; receipts/history and role dashboards update; future blocking may become eligible | Retry/idempotency tests exist; webhook reversal after completion can challenge Case invariants |
| Complete matter and pay | Attorney owner; Case in progress/funded/verified/assigned; at least one task and all complete; no dispute; completion claim acquired | Stripe transfer; Payout/PaymentOperation; Case `completed`, payment released, payout reference, paid/completed timestamps, archived/read-only/archive metadata and purge date | Active workspace disappears; completed/history and receipts appear; paralegal direct Case workspace is denied; notifications update | Strong concurrency/failure/reconciliation coverage in `paymentsPayouts.test.js` and `caseFlowNotifications.test.js` |
| Download archive | Owning attorney; completed archive available | Read/download only | Attorney completed/history; no paralegal workspace archive access | Archive failure/repair tests exist; Assistant exposes readiness, not file contents |
| Purge archive payload | Scheduled automation; purge date reached | Delete stored objects and clear file/archive payload metadata; set `purgedAt`; retain Case and financial/audit history | Archive download disappears; historical receipt/status remains | `automationCycle.test.js`; external deletion retries and partial object cleanup are risks |

### Payments, notifications and LPC Assistant

| Event | Actor and preconditions | Authoritative change and dependent effects | Surfaces and expected visibility | Coverage, contradiction or risk |
|---|---|---|---|---|
| Save/manage attorney payment method | Attorney through Stripe | Stripe customer/payment method references | Posting/hiring readiness and billing UI | Payment tests; dashboard escrow metric does not use the same authoritative summary |
| Paralegal Connect onboarding | Paralegal through Stripe | Connected-account/readiness fields | Apply/invite/hire gates, payout warning, payment views | Route tests; readiness duplicated across workflows |
| Stripe webhook | Stripe; verified signature; idempotent event claim with stale-processing recovery | WebhookEvent plus Case funding/payment fields, PaymentOperation/Payout, notifications | Payment state, receipts, workspace eligibility, dashboards | Webhook retry tests are strong; completed Case plus later transfer reversal/refund needs explicit invariant characterization |
| Create/read/clear notification | Domain service or recipient; preferences/presence may suppress delivery | Notification record, email, SSE; read/isRead fields | Notification list, unread badge/count, deep link/action | API loads latest 100 and client counts that window, risking understated unread totals |
| Suppress stale notification action | Presentation layer; target unavailable, withdrawn, blocked or unauthorized | No domain write; sanitized presentation | Notification remains informational with no invalid CTA | `notificationPresentation.test.js`; new notification types need characterization to avoid unsafe links |
| Ask general support Assistant | Signed-in user; context resolver authorization | Conversation/message records; read-only authorized context sent with support request | Support chat only | General resolver denies withdrawn Case access, while specialized paralegal workspace tool supports cutoff-limited withdrawn evidence |
| Ask workspace LPC Assistant | Active owner/participant, or specialized withdrawn-evidence rule; tool-specific authorization | No Case mutation; tool reads tasks/files/messages/deadlines/status/financial evidence; assistant conversation retained separately | Workspace Assistant response | Live-DB integration tests cover cross-user denial and core evidence. Standalone Task/Event merge and withdrawn-access policy are explicitly limited/duplicated |

## Recommendation eligibility verification

Result: **the requested historical-application exclusion is not currently satisfied**.

The actual chain is:

1. `backend/routes/jobs.js` `/api/jobs/open` returns discoverable open/relisted matters. It annotates applications using `status: { $ne: "withdrawn" }`, but it does not remove historically applied matters.
2. `frontend/assets/scripts/paralegal-dashboard.js` `loadAppliedJobs()` fetches `/api/applications/my`; that API itself excludes withdrawn applications.
3. The client filters the returned applications through `isActiveApplication()`, which removes `accepted`, `rejected`, `withdrawn`, and applications whose Job is no longer open.
4. `rankRecommendedMatters()` excludes only IDs in that active cache. It therefore has no memory of rejected, withdrawn, accepted, or otherwise inactive historical applications.
5. A rejected matter can reappear in recommendations but a new application is rejected by the server's existing non-withdrawn duplicate rule. A withdrawn matter can reappear and the server intentionally reuses the withdrawn Application, resets it to `submitted`, and permits reapplication.

The matching predicate itself is client-side: state **or** practice-area match, plus a mandatory minimum-years gate (`requiredYears <= paralegalYears`). Availability is not consulted. Current `matchingDiscovery.test.js` verifies visibility/state/experience basics but does not characterize any historical Application status.

## Principal source map

- Models: `backend/models/User.js`, `Case.js`, `CaseDraft.js`, `Job.js`, `Application.js`, `Message.js`, `CaseFile.js`, `Event.js`, `Task.js`, `Payout.js`, `PaymentOperation.js`, `WebhookEvent.js`, `Block.js`, and `Notification.js`. Invitations and disputes are embedded in Case data and managed through services/routes rather than separate model files.
- Lifecycle routes: `backend/routes/cases.js`, `jobs.js`, `applications.js`, `messages.js`, `uploads.js`, `events.js`, `disputes.js`, `payments.js`, `paymentsWebhook.js`, `blocks.js`, and `notifications.js`.
- Services/policies/jobs: `backend/services/applicationService.js`, `invitationService.js`, `withdrawalLifecycle.js`, `paymentLedgerService.js`, `paymentOperationService.js`, workflow policies/utilities, and `backend/scripts/run-automation-cycle.js`.
- Dashboard/read consumers: `backend/routes/attorneyDashboard.js`, `paralegalDashboard.js`, authenticated search and object-deep-link utilities; `frontend/assets/scripts/paralegal-dashboard.js`, attorney dashboard scripts, global search, notification and context-panel scripts.
- Assistant: support context resolver and workspace Assistant services/tools under `backend/services` and related route/test files.
