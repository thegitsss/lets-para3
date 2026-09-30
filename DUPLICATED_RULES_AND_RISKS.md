# LPC duplicated rules and lifecycle risks

Audit date: 2026-08-29. Findings are based on the current repository snapshot and are intentionally read-only. “Risk” does not mean the verified production workflow is known to be broken; it identifies a place where distributed state, untested history, concurrency or refresh behavior can diverge from that baseline.

## Priority summary

| Priority | Finding | Present consequence |
|---|---|---|
| P0 | Historical Application statuses are not a durable recommendation exclusion | Withdrawn/rejected/inactive matters can return to Home recommendations; withdrawn can be reapplied to |
| P0 | Case, Job and Application are separately written/read authorities | Posting fields, candidate mirrors and counts can disagree after edit, relist or partial failure |
| P0 | Money state is spread across Case, Payout, PaymentOperation, Stripe and webhook projections | Reversal/retry/reconciliation may disagree with dashboard/payment presentation unless all paths converge |
| P0 | Authorization changes faster than already-rendered dashboard state | A stale tab can display obsolete actions/content until the next request, though target APIs generally re-authorize |
| P1 | Dashboard totals use nonidentical status and data predicates | Active/pending/unread/escrow numbers can disagree with lists and authoritative payment views |
| P1 | Workspace tasks, files and deadlines have multiple representations | Assistant, dashboard and workspace can show different evidence after a missed mirror/fallback |
| P1 | Eligibility/readiness logic is repeated across apply, invite, hire and discovery | A new gate or legacy value can be enforced in one path but not another |
| P2 | Notification/read counts and refresh channels are windowed/client-specific | Badges can be stale or understated, especially in multiple tabs or above 100 unread items |

## Duplicated business rules

### 1. Matter/publication eligibility

Implemented in:

- `backend/routes/cases.js` Case creation, edit, delete, detail and relist behavior.
- `backend/routes/jobs.js` direct Job creation and `/open` discovery.
- `backend/services/withdrawalLifecycle.js` `ensureCaseJobOpen` and relist finalization.
- workflow policy/status utilities and frontend Case-state display helpers.

Differences/risk:

- Case creation creates both a Case and Job, while the Job route is another posting path with its own validation.
- Editing an open Case updates experience requirements in its Job mirror but does not synchronize every discovery field such as title, practice area, details, budget, state and deadline.
- A relisted Job can be recreated from Case/User data with a different field set; state may come from the attorney and matching requirements can be omitted.
- “Open,” relisted and finalized-withdrawal eligibility is reconstructed in several queries rather than one projection.

Required characterization: field-by-field equivalence after create, every allowed edit, withdrawal relist, partial mirror failure and repair.

### 2. Case status normalization and “active” predicates

Implemented in:

- Case model invariant/normalization helpers.
- Case route transitions and workflow policies.
- `backend/routes/attorneyDashboard.js` and `paralegalDashboard.js`.
- search, messages/files/workspace guards, payment and Assistant services.
- frontend status helpers.

Differences/risk:

- Persisted canonical value is `in progress`, but `in_progress` and older aliases are accepted or queried in various places.
- Attorney dashboard's active numeric metric uses an active-status set, while its active summary query is broader (`not completed/closed/cancelled`) and can include open, paused or disputed Cases.
- Some code checks status alone; core workspace invariants also require assignment, hire timestamp, verified funding, no archive/read-only state and no access revocation.

Required characterization: one status/alias fixture matrix asserted against every list, count, guard and deep link before any cleanup.

### 3. Application state and candidate mirrors

Implemented in:

- `Application` as historical authority.
- `Case.applicants` as an embedded mirror.
- `Job.applicationsCount` as a derived count.
- application/invitation/Case routes and `backend/services/applicationService.js`.
- paralegal dashboard active-application cache.

Differences/risk:

- Active filters consistently omit `accepted`, `rejected`, `withdrawn`, but those filters are incorrectly reused as the recommendation exclusion source.
- `/api/applications/my` excludes withdrawn records before the client can reason about history.
- Rejection remains a non-withdrawn duplicate and prevents a second application, while withdrawal is intentionally reusable. The Home recommendation surface does not express that distinction.
- Mirror failures are recorded as `needs_reconciliation`, but dashboards may read different sides before repair.

Required characterization: every exact Application status across Home, Browse, search, Details, Applications, attorney candidate queue and direct POST.

### 4. Paralegal readiness and availability

Implemented in:

- account approval guards.
- photo review, Stripe connected-account/payout and KYC helpers.
- application, invitation and hire routes.
- profile/public directory and dashboard scripts.
- structured `availabilityDetails` and legacy `availability` endpoints/fields.

Differences/risk:

- Availability filters the public directory but is not a recommendation, apply, invite or hire gate.
- `/users?available=true` uses a case-insensitive `/available/` match and can also match the word `Unavailable`.
- Similar readiness failures can produce different copy/status handling across apply, invite and hire.

Required characterization: a table-driven readiness test over approved/disabled/photo/KYC/payout/availability combinations for each action and surface.

### 5. Hiring and funding

Implemented in:

- Case hire route, which charges/verifies initial funding and performs lifecycle mirrors.
- `/payments` start-escrow, intent, confirm and reconcile routes.
- Stripe webhook processing.
- funding-integrity utilities, PaymentOperation and Case model invariants.

Differences/risk:

- External charge/intent state and local hire claim cannot be one database transaction.
- Initial hire and relisted funded-balance hire have different funding paths.
- Webhook and manual reconciliation can update the same Case around the same time; idempotency records reduce but do not eliminate projection timing differences.

Required characterization: externally successful/locally failed and locally claimed/webhook-delayed cases, with dashboard/payment reads at each boundary.

### 6. Payment, payout, refund and receipt projection

Implemented in:

- Case escrow/payment/payout fields.
- `Payout` ledger.
- `PaymentOperation` state.
- Stripe intents, charges, transfers and refunds.
- withdrawal finalization Case records.
- `/payments` summaries/receipts and both dashboard routes.

Differences/risk:

- Paralegal earnings intentionally merge Payout records with partial-withdrawal Case fallback and de-duplicate by Case.
- Attorney dashboard escrow total attempts to use an optional `Payment` model that is not present, so it returns zero while dedicated payment-summary routes use Case/Payout evidence.
- A transfer reversal/refund handler can clear `paymentReleased` after Case completion; the Case model normally requires completion and payout evidence to agree. Save/update path differences could yield validation failure or a completed-but-unreleased projection.

Required characterization: compare all five evidence sources and all role views for success, failure, retry, partial payout, refund and reversal.

### 7. Blocking

Implemented in:

- canonical `Block` records and block utilities/routes.
- legacy `User.blockedUsers` routes/fields.
- apply, invite, hire, discovery, profile, search, message and deep-link guards.

Differences/risk:

- New canonical pair checks and legacy per-user arrays can disagree.
- Every newly added interaction surface must remember to call the same pair check.

Required characterization: parity fixtures containing canonical-only, legacy-only, inactive/unblocked and qualifying-source Blocks across every interaction.

### 8. Tasks, files, submissions and deadlines

Implemented in:

- embedded `Case.tasks` with `completed` and `taskRevision` as completion-scope authority.
- standalone `Task` (`todo`, `in progress`, `review`) used by Assistant evidence.
- attorney `ChecklistTask`/personal productivity data.
- embedded Case file metadata plus `CaseFile` scan/review records.
- Case date-only deadline plus legacy Date field and owner-specific `Event` records.

Differences/risk:

- There is no one “submission” aggregate; review is expressed through files and task completion.
- Assistant capability code explicitly merges or limits multiple task/deadline sources, while dashboards/workspaces use narrower sources.
- Owner-specific Events are not a shared Case calendar simply because they reference a Case.

Required characterization: one fixture holding all representations, then compare A/P/Admin workspace, dashboard, search and Assistant responses.

### 9. Unread messages and notifications

Implemented in:

- Message `readBy`/read receipts.
- `User.messageLastViewedAt`.
- message unread-count, summary and threads endpoints.
- Notification `read`/`isRead`, latest-100 list, SSE/polling and client badge code.
- message presence/cooldown notification policy.

Differences/risk:

- Message unread-count/summary use last-viewed where present; thread aggregation ignores that shortcut and relies on receipts/readBy.
- Opening a message thread updates last-viewed; explicit mark-read updates both representations.
- Notification client badges are computed from at most the latest 100 fetched records.
- Presence/cooldown suppression can publish a refresh without creating a persistent Notification/email.

Required characterization: two sessions, both read mechanisms, reconnect/SSE fallback and >100 notifications.

### 10. LPC Assistant authorization and evidence

Implemented in:

- general support context resolution.
- specialized attorney/paralegal workspace Assistant tools.
- direct Case/message/file/task/event query authorization.

Differences/risk:

- General support context treats a withdrawn paralegal as unable to access the Case.
- Specialized paralegal Assistant access allows read-only evidence created before `paralegalAccessRevokedAt`.
- Workspace evidence is labeled live/fresh, but some inputs merge standalone and embedded records with explicit capability limitations.

Required characterization: name the support-versus-workspace distinction and test the exact cutoff, file-content exclusion and cross-user denial.

## Stale-state, race, refresh and deep-link risks

| Risk | Trigger | Current mitigation | Remaining exposure |
|---|---|---|---|
| Recommendation initialization race | Jobs/profile/application requests complete in different order | Client rerenders after loaders | A transient recommendation may appear before application cache is ready; historical cache remains incomplete even after refresh |
| Apply/hire race | P applies while A hires another P | Server rechecks Job/Case state and claims | Already-rendered Apply CTA fails only on submit; count/mirror refresh is asynchronous |
| Invite accept/revoke/hire race | Actions in different sessions | Status/CAS checks and reconciliation flags | Stale modal/list remains until refetch; accepted Application mirror may temporarily differ |
| Case edit vs open-feed cache | A edits while P is browsing | Request-time fetch | Existing tab retains old card; Job mirror may remain persistently stale for unsynchronized fields |
| Delete cascade partial failure | Sequential Case/Job/Application deletions | Error handling/route checks | Orphan Job/Application, stale search result or notification is possible without a transaction/repair characterization |
| Funding external/local split | Stripe succeeds before local lifecycle write or vice versa | idempotency, claims, integrity and reconciliation | Dashboard can show pending/zero while payment route has evidence; manual recovery path must be exercised |
| Webhook replay/concurrency | Stripe retries or worker dies during processing | unique event ID, processing lease/stale recovery | A Case update concurrent with manual reconcile/complete can expose intermediate projections |
| Task vs complete/withdraw/dispute | Role actions at same revision | `taskRevision` and claims/CAS | Dashboards fetched before terminal write remain stale; all transitions do not share one projection version |
| Withdrawal decision/expiry race | Attorney decision near scheduled 24-hour expiry | claims/idempotent payment operations | Relist/payout/notification ordering across workers and tabs needs cross-role test |
| Transfer reversal after completion | Stripe reversal/refund after completion write | webhook repair/reconciliation fields | Completed invariants and active/history/payment totals may disagree or update at different times |
| Access revocation in open tab | Hire ends, withdrawal/dispute/completion/block/deactivation occurs | Every subsequent protected request re-authorizes | Rendered messages/files may remain visible locally; pending compose/upload action fails only when sent |
| Notification deep-link staleness | Target rejected, revoked, deleted, blocked or finalized | presentation sanitizer and destination authorization | New notification types/actions can omit sanitizer policy; existing page may already be open |
| Multiple-tab unread state | Read/clear in one tab | SSE/poll and refresh events | Message endpoints use different read models; other tab may show an inconsistent badge/thread count |
| Notification >100 | Recipient accumulates more than list limit | latest-100 API | Client-derived badge undercounts older unread records |
| Legacy alias/data | Old status/assignment/deadline/availability record | normalization and alias queries | Not every query normalizes the same aliases; dashboard, search and Assistant may disagree |
| Relist Job reconstruction | Missing/closed Job after withdrawal | `ensureCaseJobOpen` | Recreated Job can omit minimum experience or use a different state source, changing recommendations |
| Archive purge partial deletion | Object-store failure during scheduled purge | automation retries/status fields | File/archive metadata and physical objects can be temporarily inconsistent |
| Assistant evidence freshness | Domain changes after context is assembled | live read tools and freshness metadata | Conversation response can be based on a prior read; general/specialized withdrawn access policies differ |

## Historical and archive preservation risks

- Active queues intentionally hide rejected, withdrawn, accepted and completed records. That makes it unsafe to use an active queue as a historical eligibility ledger, as the recommendation defect demonstrates.
- Case deletion removes related Applications for never-engaged matters; deactivation instead preserves financial and engagement history. Dashboard V2 must not infer a common “archive” policy for both.
- Completed Cases preserve receipt/audit history even after archive payload purge. Paralegals use completed/receipt views rather than live Case workspace access.
- Notification records can outlive actionable targets; their safe presentation depends on type-specific sanitization and destination authorization.
- Application/Invitation sync and payment operations explicitly admit `needs_reconciliation`. Dashboard projections must not silently treat that as a new Case status.

## What not to normalize during Dashboard V2

Until characterization tests pass, do not:

- rename or collapse `in progress`/legacy aliases in stored data;
- replace Application history with `Case.applicants` or vice versa;
- derive payment truth from a dashboard total;
- treat availability as a gate without a product decision;
- invent unpublish, cancellation or matter-expiration statuses;
- merge owner Events with the shared Case deadline as if they are equivalent;
- merge standalone Task, ChecklistTask and Case scope tasks;
- broaden withdrawn-paralegal workspace access based on the specialized Assistant exception;
- remove reconciliation fields or legacy query paths solely because the happy-path tests pass.

The immediate engineering recommendation is characterization first: encode the P0 cross-role scenarios in `SCENARIO_COVERAGE_REPORT.md`, then use those tests to decide where a single shared predicate/projection can safely replace duplication.
