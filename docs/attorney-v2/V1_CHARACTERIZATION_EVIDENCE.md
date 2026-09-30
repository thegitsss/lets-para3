# Attorney V1 Characterization Evidence

Status: **Synthetic repository evidence; not production acceptance and not V2 implementation**

Recorded: September 4, 2026

## Result

The focused attorney-relevant lifecycle suite passed:

- Test suites: **12 passed / 12 total**
- Tests: **125 passed / 125 total**
- Snapshots: **0**
- Duration: **81.283 seconds**
- Data: local ephemeral in-memory MongoDB records
- External services: email/object storage/Stripe replaced by repository test doubles or test stubs where applicable
- Production access: none
- Runtime files changed to obtain the result: none

Command:

```text
npm test -- --runTestsByPath tests/phase2Lifecycle.test.js tests/phase3AccessLoss.test.js tests/permissionsAcl.test.js tests/messagingNotifications.test.js tests/paymentsPayouts.test.js tests/disputesRefunds.test.js tests/uploadsDownloads.test.js tests/profileSettingsRegression.test.js tests/authenticatedSearch.test.js tests/notificationPresentation.test.js tests/lifecycleTransitions.test.js tests/caseFlowNotifications.test.js
```

## Evidence adopted by Attorney V2 Phase 0

| Existing suite | Attorney V2 dependency characterized | Fixture scenarios |
|---|---|---|
| `phase2Lifecycle.test.js` | Payment required at hire rather than posting/application; one Case/Job/Application across draft, publish, apply, pre-engagement, fund/hire, collaboration, completion and role projections | S01–S08, S12, S15 |
| `phase3AccessLoss.test.js` | Reject, invitation revocation/stale acceptance, hire access change, withdrawal, dispute, completion, block, deactivation, managed-session revocation and Assistant boundary | S00, S04–S08, S13, S14, S16–S18 |
| `permissionsAcl.test.js` | Ownership, participant, role, legacy owner alias, invitation and file authorization | S00, S05, S08, S10 |
| `messagingNotifications.test.js` | Message creation/read/edit/delete/reaction, unread and notification behavior | S09, S17 |
| `paymentsPayouts.test.js` | Funding/payout/receipt and payment evidence behavior under test provider | S07, S12, S15 |
| `disputesRefunds.test.js` | Dispute settlement, refund, allocation and payment consequences | S14, S15 |
| `uploadsDownloads.test.js` | Upload/download authorization, object-storage boundaries and file behavior | S10 |
| `profileSettingsRegression.test.js` | Attorney/paralegal settings persistence and role-conditional behavior | S00, S01, S16 |
| `authenticatedSearch.test.js` | Role-safe authenticated search and visibility | S08, S13, S16, S17 |
| `notificationPresentation.test.js` | Notification copy, actor/object presentation and safe links | S04–S07, S12–S14, S17 |
| `lifecycleTransitions.test.js` | Allowed/forbidden transition boundaries and retired direct paths | S02–S07, S12–S15 |
| `caseFlowNotifications.test.js` | Application, invitation, pre-engagement, hiring, completion/withdrawal concurrency and cross-role notification signals | S04–S07, S12–S14, S17 |

## What this passing result proves

- The observed backend snapshot has executable synthetic coverage for the primary attorney Matter lifecycle.
- Core attorney, paralegal, and admin projections are exercised from shared authoritative records.
- Major access-loss events have route-level coverage.
- Payment and dispute tests operate against doubles/test identifiers, not live Stripe.
- Phase 0 can adopt this evidence instead of creating a parallel lifecycle interpretation.

## What this result does not prove

- Browser-visible V1 behavior, responsive layout, keyboard/screen-reader behavior, focus restoration, or visual parity.
- The exact behavior of every query/hash/deep-link combination in `routes.json`.
- Real email, bookmark, access-log, CDN, service-worker, or legacy redirect usage.
- Production data compatibility or production Stripe behavior.
- Complete equivalence among all message unread endpoints, especially multi-tab and more than 100 unread records.
- Complete CaseFile/embedded file-mirror convergence under scanner callback races.
- Correct resolution of A-01 through A-17; green tests may characterize current behavior without deciding that behavior is correct.
- V1/V2 differential behavior, because Attorney V2 does not exist.

## Remaining executable work before Phase 1

The technical Phase 0 artifact package is stronger with this result, but the following should still be captured or explicitly deferred by the owner:

1. Browser route/deep-link characterization for all entries and parameters in `routes.json`.
2. Accessibility baselines, including WCAG 2.2 AA scans and named screen-reader/keyboard checks.
3. Responsive screenshots at the approved viewports.
4. Performance/request/SSE/poll/listener baselines under representative volumes.
5. Dedicated unread equivalence, deadline/task source, payment-summary equivalence, and shared-file-mirror tests tied to A-01, A-02, A-06, and A-09.

These are characterization gaps, not permission to modify current behavior.
