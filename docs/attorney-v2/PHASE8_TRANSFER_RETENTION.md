# Payout transfer attempts and retained references

This bounded P8-09 correction follows the [LPC Product North Star](../LPC_PRODUCT_NORTH_STAR.md). It covers completion, withdrawal, administrator withdrawal settlement and dispute settlement transfer requests. Full callback, ledger and cross-view acceptance remains open.

## Reproduced failures

The shared transfer helper returned Stripe's transfer only after two chargeback bookkeeping writes. If either write failed, callers lost a successful provider result before assigning their local transfer variable or recording its reference. The reviewed withdrawal claim consequently could lack the known transfer even though its provider request succeeded.

The payment-operation claim also allowed an unknown provider result to be reclaimed after its ordinary timeout. A provider exception does not establish that no transfer occurred. Stripe documents that idempotency keys can be removed after at least 24 hours, and that reusing a pruned key makes a new request. An unresolved local request therefore needs its own lasting barrier. [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

All three original reproductions failed on candidate 1: **0/3 passed**, 1.629 seconds. They demonstrated loss of the operation reference, a repeated claim three days after a lost provider response, and omission of the owning Matter's reference callback.

## Correction

The shared helper requires an actual claimed payment operation and writes a majority-acknowledged request marker before contacting Stripe. The marker uses the existing `evidenceStatus` field and exact operation identity, attempt number and attempt time. Competing invocations and replaced attempts cannot issue another transfer. An unknown provider outcome keeps the marker indefinitely; the ordinary retry path and a generic caller failure cannot clear it. No model, schema or index was added.

When Stripe returns a known transfer, the helper retains its identifier and requested amount in the exact payment operation and invokes the owning Matter's reference callback before chargeback bookkeeping. Both retention attempts complete independently. If an evidence write fails, a second reconciliation write attempts to retain the known reference. If all later database writes fail, the original request marker remains. A transfer reference is not a completed payout ledger or a completed Matter.

Completion and reviewed withdrawal retain their claim references immediately. A completion failure preserves existing failed/reversed/reconciliation evidence and the original account-access error. New provider metadata carries the exact operation key for subsequent callback association. All four production transfer call sites use this authority. The existing development bypass also records its operation and does not call Stripe.

Unknown results are described as requiring payment review. They are not presented as an invitation to release the payment again. Known-transfer settlement recovery continues to reuse its retained reference. Earlier refunds without optional transfer fields preserve their ordinary retry behavior; an old failed caller cannot downgrade a completed operation or a later attempt.

## Local evidence

Checkpoint: `backend/backups/attorney-v2-transfer-retention-start/`, with **4,247 initial hashes**. The checkpoint retains each fixed candidate, the original failures and bounded source changes.

- Candidate 2: **116 passed, 42 failed across seven suites**. Forty-one failures came from the completion suite's independent Mongo startup hook timing out before its tests ran. One legacy payout assertion still expected an unknown provider exception to mean retryable failure. The completion suite now uses the established isolated test database and mocks event delivery; the legacy assertion now expects retained reconciliation.
- Candidate 3: **156 passed, 4 failed across seven suites**. The restored completion suite found that the new catch path could overwrite three negative processor projections and mask an account-revocation response. The corrected path preserves all three negative states and the public access error.
- Candidate 4: **164/164 passed across all seven suites**, 144.071 seconds. It includes the corrected cases, explicit unknown-result coverage for all three transfer operation kinds, required-claim coverage, an older-refund compatibility case, and real-route completion/withdrawal bookkeeping-failure recovery. Existing chargeback holds and settlement recovery passed.
- **24/24 selected browser recovery checks passed** across Chromium, Firefox and WebKit, 2.6 minutes. They cover blocked/reversed payment states, lost responses, stopping the wait, retention across Matter tabs and account changes. Payment decision responses are intercepted in these browser scenarios; the mounted-route backend tests above exercise the actual transfer authority with mocked Stripe.
- Runtime bindings on final runtime candidate 4 reported only the inherited unused `full` parameter in `services/support/zohoMailbox.js`. All nine owned backend source/test files still matched the tested candidate. No frontend source changed.

Tests use Node 24.18.0, isolated local Mongo and mocked Stripe, receipts, notifications and archive delivery. No actual provider transfer, production data change, external message, deployment, cohort activation or V1 retirement occurred. The independently advancing Account and notification implementations still require adoption into the combined attorney candidate; their checklist notes are preserved separately from this financial runtime.

The final documentation candidate is `/private/tmp/lpc-attorney-review-20260909-transfer-retention-5`; runtime remains identical to candidate 4. The checkpoint owns twelve paths, including nine backend source/test files and three documents.

## Remaining financial work

Transfer callbacks still need exact operation/payout association, delivery-attempt fencing inside business transactions and preservation of earlier withdrawal history. Signed callback evidence must distinguish a partial reversal from a full reversal and must not turn a transfer-created notification into proof of a paid local ledger. Existing historical unknown requests without this new marker require an explicit reconciliation disposition; this change does not infer their provider outcome.

Funding/refund/chargeback handler transactions, active/pending and original checkout recovery, attorney/paralegal/admin totals, receipts/CSV agreement, retention and real provider/operational acceptance remain open. This slice does not make the full attorney experience ready for final review or production release.
