# Card-dispute callbacks and reconciliation

This P8-09 slice follows [refund history](PHASE8_REFUND_HISTORY.md). The implementation and affected financial consumers are locally verified; the complete attorney experience is not ready for final review.

## Scope and source

Checkpoint: `backend/backups/attorney-v2-chargeback-events-start/`, **6,204 initial hashes, initially 16 owned paths**. The fixed starting financial source is `/private/tmp/lpc-attorney-review-20260909-refund-history-7`. The owned callback, chargeback service, payout guard, operation model and existing financial tests matched that source. The root administrator route had one existing four-line addition validating an optional chargeback ID and filtering the list by it. That relevant behavior is adopted and tested through the mounted administrator route.

The scope was extended to **17 owned paths** for `backend/tests/adminWorkflows.test.js` only after its bytes matched the checkpoint and private candidate 7 (`77041999dbb9c320700b7f72002dc4505136bc5d4c5b06c4734bf52fdbecdb49`). Its old reconciliation fixture supplied an event-style fragment instead of a retrieved dispute, charge and captured payment. The corrected synthetic provider fixture supplies those canonical objects and waits for the financial indexes. It does not weaken the expected financial outcome.

Private candidates 1–9 are retained in the checkpoint manifests. Candidate 1 has 1,578 files; candidates 2–4 have 1,579; candidates 5–9 have 1,580. Runtime candidate 8 is `/private/tmp/lpc-attorney-review-20260909-chargeback-events-8`; final documentation candidate 9 retains identical runtime and tests. The prior accepted private Case source remains pinned; concurrent root résumé/account-closure changes are preserved but are not implicitly adopted into this financial candidate.

## Implemented behavior

The five actual card-dispute callback types reread the current provider dispute, original charge and captured PaymentIntent. Exact retained original-payment references select a unique Matter. Editable metadata cannot assign one. Current charge/intent amounts, capture, currency, mode and references must agree with the original funding. The current dispute and balance transactions supply disputed principal, fees and recovery amounts; a dispute need not equal the original charge amount.

A snapshot/majority transaction retains the chargeback operation, immutable platform adjustments, business audit, exact delivery-attempt receipt and a real Matter version write together. A failed adjustment, audit or receipt leaves no partial financial observation. Lost commit acknowledgment cannot reopen a processed receipt. The retained business-event audit survives delivery-receipt expiry, detects changed contents under the same event ID, and suppresses repeated provider reads and owner alerts. Replacement delivery attempts cannot commit after their replacement. Existing verified records become quarantined if retained references or amounts conflict; their identifiers and original ledger entries remain intact.

Signed connected-account events are retained for review without calling the platform provider context. An unsigned account header cannot choose an account. Foreign or orphaned balance references, ambiguous original references, refund overlap, incomplete balance history and contradictory terminal outcomes require review. A known original Matter retains its payout hold during refund overlap. Missing event and balance-transaction dates remain missing; verification time is separate.

Administrator reconciliation is a new, explicit provider observation. It does not synthesize changed callback content under an old event ID. Its separate audit identifies the administrator and observation origin while retaining the original event ID only as correlation. Repeated checks append no duplicate money entries. Administrator role, approval, disabled/deleted state, authentication version and managed session are rechecked before reading and inside the transaction; real account/session writes serialize concurrent revocation. Changed financial sources return a 409 with instructions to reopen the card dispute. Revoked access returns 403.

Acknowledgment and eligible hold clearance also retain their operation update and audit in one transaction. Both use the current administrator and financial source guards, and repeated completed decisions are idempotent. Acknowledgment never silently clears the hold. The existing explicit won-and-verified clearance rule remains; other outcomes are not automatically cleared.

Payout position describes whether money has already been transferred. It no longer implies that all remaining work has been paid: an active review can hold the remaining Matter balance after an earlier partial payout while retaining the paid paralegal record. A verified win can be explicitly cleared only when retained earlier withdrawal decisions, remaining gross balance, paid payout rows and succeeded partial-transfer operations agree. Unknown payout status, unresolved transfer requests, missing/contradictory earlier evidence or an in-flight Matter claim prevent clearance. The administrator list uses the same hold predicate as payout requests. Transfer producers recheck the hold after retaining their request marker and before calling the provider. A provider request already in flight still requires the existing retained-reference and reconciliation path; no local transaction claims to undo an external transfer.

Financial history accepts both `dp_` and `du_` references. Processor status accepts `prevented`. Platform chargeback adjustments remain separate from attorney charges and paid paralegal earnings. No index was added. The unused metadata-led association export was removed after confirming it had no callers.

## Local verification

All database/provider observations use isolated synthetic MongoDB and mocked Stripe. Logs retain failed runs and subsequent corrections:

| Candidate | Checks | Result |
| --- | --- | --- |
| 1 | Original callback reproductions | **0/8**, 13.168 seconds: audit rollback, unavailable provider evidence, delayed snapshot, metadata-only assignment, unsigned account header, missing payout status, invented transaction date, and prevented/du support |
| 2 | Chargebacks, refund callbacks, financial history | **84/84**, 32.045 seconds |
| 3 | Chargebacks, lifecycle, callback compatibility, transfer retention | **58/59**, 24.136 seconds; the remaining old fixture supplied live-mode data under a test-mode configuration |
| 4 | Corrected mode fixture and expanded replay/reference checks | **70/70**, 41.926 seconds |
| 5 | Mounted administrator reconciliation and callbacks | **29/29**, 58.395 seconds, including access/session revocation, concurrent record changes, audit rollback, repeated observations and exact list-ID filtering |
| 6 | Additional payout/admin regressions | **0/5**, 21.759 seconds, with 29 unrelated checks not selected: past partial payout, stale verified evidence, two unaudited administrative decisions, and unknown-status hold clearance |
| 7 | Corrected callbacks/admin decisions, lifecycle, transfer retention and financial history | **139/139**, 113.902 seconds |
| 8 | Expanded affected financial consumers | **467/467** across 17 suites, 243.672 seconds |
| 8 | Existing administrator list/acknowledgment and reconciliation | **2/2**, 22.565 seconds; 12 unrelated checks not selected |
| 8 | Existing administrator eligible-win hold clearance | **1/1**, 20.381 seconds; 13 unrelated checks not selected. Its title was outside the preceding name filter |

Candidate 7/8 runtime checks report only the inherited `services/support/zohoMailbox.js:34` unused parameter. Candidate 2 also found an unused callback helper; it was removed, and later checks no longer report it. This is not a clean repository-wide runtime gate. No new frontend visual behavior was introduced here; the mounted routes and financial-history consumers are tested directly. Combined browser and owner acceptance remain separate.

## Provider contract and remaining gates

[Stripe's dispute object](https://docs.stripe.com/api/disputes/object) includes `prevented`, shows `du_` identifiers and permits zero balance transactions. Older `dp_` identifiers remain supported. [Dispute retrieval](https://docs.stripe.com/api/disputes/retrieve) supplies the current object; [balance transactions](https://docs.stripe.com/api/balance_transactions/object) supply signed amount, fee, net, currency and provenance. Current provider documentation was checked September 9. Unsupported connected-account or mismatched-currency evidence remains under review rather than being reinterpreted.

Real provider delivery/configuration, unusual provider balance-source/fee shapes, historical record reconciliation and model adoption still require non-production provider acceptance. Those are not certified by synthetic fixtures. No real provider request, financial mutation, message, deployment, cohort activation or V1 retirement was performed. Whole financial view agreement, original Checkout recovery, retention, combined source adoption and owner review remain open.
