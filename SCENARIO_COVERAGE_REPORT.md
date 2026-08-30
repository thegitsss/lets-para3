# LPC scenario coverage report

Audit date: 2026-08-29
Snapshot: `13baf5d1` plus the pre-existing working-tree changes identified in `DOMAIN_LIFECYCLE_INVENTORY.md`.

## Existing-suite baseline

Command run from `backend/`:

```text
npm test -- --ci
```

Result:

```text
Test Suites: 3 failed, 175 passed, 178 total
Tests:       5 failed, 1313 passed, 1318 total
Snapshots:   0 total
Time:        296.558 s
```

No test or production file was changed to obtain this result.

### Baseline failures

| Suite | Failed tests | Observed reason | Lifecycle interpretation |
|---|---:|---|---|
| `tests/releaseCandidate.test.js` | 3 | Release checker requires Node 24.18.0 or a newer 24.x security release; runner is Node 22.17.0. The runtime check also preempts the test that expected an npm 11.16.0 mismatch message. | Environment/release-contract failure, not evidence of a lifecycle behavior regression. The audited tree is dirty and therefore is not a release-candidate snapshot in any event. |
| `tests/supportRetention.test.js` | 1 | Privacy-policy regex expects wording matching `support-chat conversations ... 183 days`; current policy describes “Assistant conversations and associated messages—including ... support-assistant messages” and 183 days. | Copy/contract drift. The scheduled retention implementation requires separate behavioral evidence; this failure alone does not show that retention stopped running. |
| `tests/dashboardUpgradeContract.test.js` | 1 | Static contract expects `Prioritized from your current Matters, applications, messages, and payout readiness`; current paralegal dashboard markup no longer contains that exact sentence. | Dashboard markup/copy contract drift, not a server lifecycle failure. |

## Coverage by lifecycle scenario

Ratings describe present test evidence, not production quality: **strong** = direct positive, negative and/or race coverage; **partial** = principal route covered but cross-record/surface behavior is incomplete; **missing** = no direct characterization found.

| Scenario | Existing tests/evidence | Rating | Missing or contradictory coverage |
|---|---|---|---|
| Attorney registration, validation and approval | Auth/registration/admin suites plus `phase2Lifecycle.test.js` approved fixture | Partial | Registration-to-approval is separate from the characterized approved-attorney lifecycle; publication requires no payment method, while hire/funding does |
| Paralegal registration/approval/profile readiness | Auth, registration, file/profile tests | Partial | No durable fixture characterizing every recommendation field and all readiness combinations |
| Account disable/delete/session rejection | `accountDeactivation.test.js`, auth/session tests | Strong | Cross-tab already-rendered dashboards and SSE teardown are not browser-tested |
| Personal-data removal/retained ledger | `dataRemoval.test.js`, automation tests | Strong | External object deletion retry and every reference-holder combination are not exhaustive |
| Availability updates/public visibility | user/paralegal/public route tests | Partial | No test proves availability is intentionally informational for recommend/apply/invite/hire; regex false-positive for “Unavailable” uncharacterized |
| Draft create/update/delete after publish | Case draft/create-case/static tests | Partial | Publish success followed by draft-delete failure, duplicate publish and multi-tab draft conflict are missing |
| Publish Case + Job and posting constraints | `phase2Lifecycle.test.js`, `jobEscrow.test.js`, `lifecycleTransitions.test.js` | Strong for happy/validation paths and the no-payment-method publication contract | Cross-record atomicity under intermediate failure and equivalence of both posting routes are incomplete |
| Edit open matter | lifecycle/Case route tests | Partial | No test asserts every discovery-card field remains synchronized into Job and all role surfaces after edit |
| Unpublish/cancel | Delete constraints are tested | Missing as a named event | No dedicated unpublish/cancel behavior exists; UI/copy contracts should assert only actual delete/close semantics |
| Delete never-engaged matter | `lifecycleTransitions.test.js` and route tests | Partial/strong | Failure between Case/Job/Application deletions and stale notification/search links is not characterized |
| Matter expiration | No posting-expiry implementation found | Missing/not implemented | Test should explicitly pin absence or intended indefinite-open behavior before V2 assumes an expiry state |
| Browse open and relisted opportunities | `matchingDiscovery.test.js`, withdrawal lifecycle tests | Partial | Orphan Job, stale Job mirror, incomplete relist metadata, dual ID and former-applicant visibility scenarios are missing |
| State/practice/minimum-years recommendation | `matchingDiscovery.test.js` | Partial | Only basic matching/visibility/auth; no complete boundary matrix, loading-order test or server/client equivalence |
| **Historical application recommendation exclusion** | None | **Missing and currently contradicted by code** | Withdrawn, rejected, accepted and non-open/inactive applications are dropped from the client's exclusion cache. Rejected/withdrawn matters can reappear; withdrawn can be reapplied to |
| Create application/readiness/block gates | `caseFlowNotifications.test.js`, `matchingDiscovery.test.js`, `blockingRules.test.js` | Strong | No all-gates table test proving the same result in Browse CTA, Home CTA and direct POST |
| Application mirror/count reconciliation | application service and case-flow tests | Partial | Forced second-write failure, repair job and dashboard count convergence are not fully cross-role tested |
| View/shortlist/star/reject | application/case-flow tests | Strong at route level | P dashboard/status and notification/deep-link consequences are not asserted together |
| Pre-hire withdrawal | application tests | Strong at route level | Historical visibility/recommendation behavior is missing and presently wrong for the stated requirement |
| Invitation send/accept/decline/revoke | `caseFlowNotifications.test.js`, ACL tests | Strong | Accept-vs-revoke/hire multi-tab UI and invitation-history recommendation behavior are incomplete |
| Pre-engagement request/submit/changes/approve | `caseFlowNotifications.test.js` | Strong | Full surface/count notification matrix is partial; CAS behavior is better covered than UI movement |
| Concurrent hire and initial funding | `jobEscrow.test.js`, case-flow tests | Strong | Browser recovery from a claim/reconciliation response and all mirrored dashboard counts remain partial |
| Relisted funded-balance hire | withdrawal/job escrow tests | Strong/partial | Matching metadata on a newly recreated Job and prior-applicant exclusion need coverage |
| Retired direct Job hire endpoint | `lifecycleTransitions.test.js` | Strong | Static clients should also be searched/contract-tested to prevent reintroduction |
| Funding intent/confirm/reconcile/webhook | `paymentsPayouts.test.js`, webhook/payment operation tests | Strong | Duplicate implementation paths need equivalence assertions rather than independent happy-path tests |
| Active workspace authorization | `permissionsACL.test.js`, `authenticatedSearch.test.js`, message/file tests | Strong | Already-open browser tab after loss of access is not tested end to end |
| Messages send/read/edit/delete/reaction | `messagingNotifications.test.js` | Strong at API level | `/unread-count`, summary and thread aggregation consistency is missing and current predicates differ |
| Notification preferences/presence/cooldown | `notificationPreferences.test.js`, `messageNotificationPolicy.test.js`, `messagingNotifications.test.js` | Strong | Multi-tab read/clear and latest-100 badge truncation are missing |
| Upload/download/scan/file review/revision | `uploadsDownloads.test.js`, `permissionsACL.test.js` | Strong/partial | CaseFile vs embedded Case file mirror convergence and scanner callback races need explicit tests |
| Case scope task completion/reopen/revision CAS | case-flow, payment completion and ACL tests | Strong | Standalone `Task`/ChecklistTask versus Case task projection is not characterized across Assistant and dashboards |
| Deadlines/events | Event/Assistant/dashboard tests | Partial | Case date-only deadline, legacy date and owner-specific Event must be compared for A/P/Admin visibility |
| Paralegal active-matter withdrawal | `withdrawalLifecycleJobs.test.js`, case-flow concurrency tests | Strong | Cross-role browser movement and former-P deep-link/Assistant policy need one integrated scenario |
| Zero/partial/rejected withdrawal payout and expiry | withdrawal, payment, dispute, automation tests | Strong | Relisted recommendation exclusion and recreated Job metadata are missing |
| Dispute open/concurrent/settlement | `disputesRefunds.test.js`, payment tests | Strong | Dashboard counts/actions and all notification links after every settlement allocation are partial |
| Completion claim/task race/payout/archive | `paymentsPayouts.test.js`, `caseFlowNotifications.test.js` | Strong | Role dashboards, message badge disappearance, direct link and archive visibility are not asserted in one transaction-spanning test |
| Refund, transfer failure/reversal and reconciliation | `disputesRefunds.test.js`, `paymentsPayouts.test.js`, webhook tests | Strong | Persisted Case invariants after a completed payout is later reversed/refunded need a dedicated characterization test |
| Payment/receipt/earnings views | payment tests and receipt/export tests | Strong for routes | Attorney dashboard escrow total versus authoritative `/payments/summary` is not compared; current dashboard may show zero |
| Block/unblock and discovery suppression | `blockingRules.test.js`, authenticated search tests | Strong | Canonical Block vs legacy `blockedUsers` parity and cache/multi-tab behavior are not covered |
| Notification stale-action sanitization | `notificationPresentation.test.js`, object deep-link tests | Strong | New type completeness and >100 unread count remain missing |
| Global authenticated search/deep links | `authenticatedSearch.test.js`, `objectDeepLinks.test.js` | Strong | Payment and every archive/withdrawal substate are not exhaustively crossed with roles |
| Dashboard totals/section movement | dashboard route/static contract tests | Partial | Mostly endpoint or markup assertions, not A/P/Admin lifecycle projections from the same fixtures |
| Scheduled automation/idempotency | `automationCycle.test.js`, `withdrawalLifecycleJobs.test.js` | Strong | Multiple live-worker leasing/clock skew and downstream dashboard refresh are not fully exercised |
| LPC Assistant active workspace evidence | Assistant live-DB integration tests | Strong | Dashboard-to-Assistant freshness and standalone task/deadline merges remain explicit limitations |
| LPC Assistant withdrawn access | Specialized paralegal tool tests | Partial/strong | General support resolver denies withdrawn Case access while specialized tool supports cutoff-limited evidence; policy boundary needs one contract test |
| Support conversation retention | support retention tests | Partial; one contract failure | Scheduled DB deletion behavior and privacy copy need one shared constant/characterization source |

## Contradictions revealed by coverage

1. `matchingDiscovery.test.js` proves basic match behavior but gives false confidence about recommendation eligibility because it never seeds historical Application statuses.
2. Application tests correctly prove that withdrawn Applications can be reused, while the requested product rule says historical applications must prevent recommendation resurfacing. Those can coexist only if Browse/reapply remains allowed but Home recommendations retain a separate historical exclusion; no test defines that boundary.
3. Dashboard “active,” application “pending,” message “unread,” and attorney “escrow total” are covered by isolated queries with different predicates, not one shared role-transition contract.
4. Assistant tests intentionally allow a specialized withdrawn paralegal to read pre-revocation evidence, while the general support context resolver treats the Case as inaccessible. The distinction is not captured as a named product policy test.
5. The suite has strong service-level concurrency coverage for hire, withdrawal, dispute and completion, but weak browser-level characterization of what both parties see immediately afterward.

## Prioritized characterization and cross-role tests before Dashboard V2

### P0 — lock down correctness and authorization

1. **Historical recommendation exclusion matrix.** Seed one paralegal, matching/nonmatching Jobs/Cases and Applications in every exact status: `submitted`, `viewed`, `shortlisted`, `accepted`, `rejected`, `withdrawn`; also make the Job closed/assigned and later relisted. Assert Home recommendation exclusion independently from Browse visibility, Details authorization and direct apply behavior. Explicitly capture the desired rule that no historical application returns to recommendations.
2. **One fixture, three roles, full lifecycle projection.** From publish → apply → shortlist → pre-engagement → hire/fund → message/file/task/deadline → complete/payout, assert A, P and Admin Home sections, Browse/search, counts, badges, notifications and deep links after each transition.
3. **Loss-of-access matrix.** Repeat for reject, revoke, withdrawal, dispute, completion, block and account deactivation. Assert hidden UI and direct API/deep-link denial from a stale second session/tab.
4. **Money projection integrity.** After charge, payout, partial payout, refund, transfer failure/reversal and reconciliation, compare Case, Payout, PaymentOperation and webhook evidence with attorney/paralegal/admin payment views and dashboard totals.

### P1 — characterize distributed-state convergence

5. **Case/Job/Application mirror contract.** Force or simulate failure after each write; assert `needs_reconciliation`, repair behavior, posting/application counts, and all discovery surfaces. Include every editable/relisted matching field.
6. **Concurrent cross-role actions.** Exercise accept-vs-revoke, apply-vs-hire, hire-vs-delete, task-complete-vs-completion, completion-vs-dispute, withdrawal-vs-completion, and webhook-vs-manual reconciliation with dashboard reads between attempts.
7. **Unread/count equivalence.** For messages and notifications, compare summary, thread, dashboard, badge, clear/read and SSE/poll results across two tabs, including more than 100 unread notifications.
8. **Deadline/task source contract.** Define and assert how Case deadline, legacy deadline, owner Event, embedded Case tasks, standalone Task and ChecklistTask appear for A/P/Admin and LPC Assistant.

### P2 — preserve history and operational behavior

9. **Archive/purge/history contract.** Assert completed-role visibility before and after archive generation and purge, including receipts, direct links, files, messages and Assistant evidence.
10. **Account/block retention contract.** Assert deactivation/data minimization and canonical/legacy block behavior without losing financial or audit history.
11. **Automation clock/idempotency contract.** Use deterministic clocks and multiple workers for withdrawal expiry, dispute escalation, archive purge and personal-data deletion, then assert dashboards refresh to the same terminal state.
12. **Static-to-runtime dashboard contracts.** Replace brittle exact-copy-only expectations with route-backed fixtures that assert section semantics and accessible actions while leaving visual redesign out of scope.

Dashboard V2 should not begin by consolidating or renaming statuses. It should begin after P0 has established an executable, cross-role visibility contract over the exact statuses and aliases documented here.
