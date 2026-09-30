# Refund requests and settlement recovery

This bounded P8-09 work follows [original funding callbacks](PHASE8_FUNDING_EVENTS.md) and the [LPC Product North Star](../LPC_PRODUCT_NORTH_STAR.md). It is locally verified; it does not close full financial consistency or attorney readiness.

## Reproduced failures

All four original mounted-route checks failed on candidate 1: **0/4**, 16.041 seconds. An unknown refund could be requested again after the ordinary operation timeout. An already-refunded error could fabricate an `already_refunded_` identifier and close the dispute. A pending refund could also close the dispute. A failure while saving the returned refund reference could lose the only known result.

## Implementation

The shared refund helper retains an exact request in the existing audit collection before calling Stripe. The request, its claimed payment operation and the current Matter guard commit together. An uncertain result stays protected after both the operation timeout and provider idempotency-key retention. Older unconfirmed operations without retained request evidence require review; they do not receive a new provider key.

Returned references are retained independently in the operation and a deterministic audit record before settlement work. Either record can recover an interrupted write. Known refunds are retrieved and checked before reuse; a returned identifier alone is insufficient. Provider errors do not manufacture identifiers. The original charge, captured amount, currency, mode, Matter/dispute association, requested refund amount and actual refund status must agree. Pending, action-required, failed or canceled refunds retain their references and leave the dispute unsettled.

Stripe supports partial refunds and multiple refunds up to the original charge, and exposes pending, action-required, succeeded, failed and canceled outcomes. The retained helper uses those actual outcomes. [Create a refund](https://docs.stripe.com/api/refunds/create), [refund object](https://docs.stripe.com/api/refunds/object).

Full refund settlement commits its Case state, operation completion and settlement audit together. Its original request/result records remain available when settlement rolls back. Lost commit acknowledgements can be checked without making another refund. Partial settlement retains its original requested total and reuses the actual refund before the payout. Current Matter guards protect the final partial-settlement transaction. Completed local markers no longer repair financial records blindly or clear later negative evidence.

## Local evidence

- Candidate 1: **0/4 original checks passed**, 16.041 seconds.
- Candidate 2: **8/8 checks passed**, 13.87 seconds, covering the original refund cases and payment-operation claim compatibility.
- Candidate 3: **64/64 checks passed across five suites**, 97.296 seconds. This includes full-refund success, pending-to-confirmed recovery, retained-reference recovery, settlement-audit rollback and affected dispute, payout and chargeback consumers.
- The older dispute fixtures now supply complete current payment/refund evidence. Their full-refund amounts include the original recorded attorney fee. Partial fixtures return the amount actually requested: 61,000 cents in the ordinary partial settlement, and 24 cents in the rounding/delta case. The earlier placeholder returns of 10,000 and 30 cents were inconsistent with their own requests. The fee policy and requested payout calculations are unchanged.
- Candidate 4: **325/325 checks passed across thirteen suites**, 245.157 seconds. Coverage includes expanded lost-acknowledgement, old-operation, later-negative-evidence, replaced-attempt and changed-Matter checks, final partial-settlement guards and affected completion, withdrawal, funding, transfer, receipt, financial-history and payment-projection consumers.
- Candidate 5: **33/33 final refund/dispute checks passed**, 70.975 seconds. This adds explicit mismatched refund amount/currency/charge/PaymentIntent checks. Its runtime is unchanged from candidate 4.
- Runtime checks on completed candidates 3 and 4 report only the inherited unused `full` parameter in `services/support/zohoMailbox.js`.

Checkpoint: `backend/backups/attorney-v2-refund-retention-start/`, 5,070 initial source hashes and nine owned paths. The accepted runtime is candidate 4, retained in the expanded test candidate 5. The final documentation candidate is `/private/tmp/lpc-attorney-review-20260909-refund-retention-6`. Existing owned backend paths matched the accepted financial source before this checkpoint. Independently advancing root work remains separate.

Tests use Node 24.18.0, isolated synthetic Mongo and mocked Stripe. No real refunds, transfers, alerts, provider messages, production data, deployment or cohort action occurs. No frontend flow changes are part of this slice; browser/combined acceptance remains separate.

## Remaining work

Refund and chargeback callback transactions, exact current financial views, historical checkout recovery and storage retention remain open. Historical refunds with no durable reference need a reviewed reconciliation outcome. Platform financial adjustments remain distinct from attorney debt. Final combined source adoption and the populated owner walkthrough remain in the active preparation sequence.
