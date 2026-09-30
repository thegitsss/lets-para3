# Refund callbacks and separate settlement evidence

This bounded P8-09 work follows [refund request retention](PHASE8_REFUND_RETENTION.md). It protects callback records and settlement producers; financial views and overall attorney readiness still require acceptance.

## Reproduced failures

The original handler failed all seven candidate 2 checks: **0/7**, 30.614 seconds. It could leave financial writes behind when the audit failed, clear a separate paralegal payout after an attorney refund, regress a successful refund from an old failed snapshot, miss a full refund made through multiple partial refunds, associate an unrelated payment through metadata, acknowledge unavailable provider evidence, or certify a pending refund from a charge aggregate. Candidate 1 was not tested; its pending fixture amount was corrected to match the retained request before the red run.

## Implementation

The handler reads the current refund, original charge, captured PaymentIntent and complete charge refund list. It verifies the retained Matter/payment association, original amount, currency, mode and refund references. Duplicate pages, incomplete lists, changed snapshots and unavailable provider reads require a retry. Metadata alone cannot assign a refund to a Matter or recover an interrupted request. Recovery without a returned reference requires the signed event's original idempotency key to match the durable request, along with its exact operation, charge, payment, amount and currency.

All observed refund operations, the Case payment projection, deterministic event audit and exact delivery receipt commit in one transaction. A replaced delivery cannot commit. A lost commit acknowledgement cannot reopen the recorded business event. The audit retains the event identity after delivery-receipt expiry and rejects changed content under the same event ID.

Refund evidence is independent of a combined dispute settlement's payout leg. Four optional PaymentOperation fields retain `refundStatus`, `refundEvidenceStatus`, `refundVerifiedAt` and `refundCreatedAt`; the last remains absent when no provider date is available. Old records are not automatically certified. The shared refund producer writes verified success evidence, and payout creation and settlement completion check it. A failed callback cannot be overwritten by an in-flight settlement producer. A refund never clears an independently paid paralegal transfer, reopens the Matter or restores its remaining amount. Later unknown payment states and chargeback holds remain protected.

The supported events follow Stripe's actual event catalog: `charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated` and `refund.failed`. The legacy `refund.succeeded` branch records an unsupported event for review. Connected-account refund events are retained for review; an unsigned request header cannot select a different provider account. See [Stripe event types](https://docs.stripe.com/api/events/types), [refund outcomes](https://docs.stripe.com/api/refunds/object) and [webhook ordering](https://docs.stripe.com/webhooks).

## Local evidence

- Candidate 2: **0/7 original checks passed**, 30.614 seconds.
- Candidate 3: **54/54 checks passed across four suites**, 44.474 seconds, covering the corrected callback and affected refund, transfer and operation consumers.
- Candidate 4: **64/64 checks passed across five suites**, 72.59 seconds. This adds complete paging, signed original-request recovery, changed-source/reference rejection, failed-refund treatment, rollback, stale attempts, lost acknowledgements and receipt-expiry deduplication. Legacy webhook fixtures now provide actual supported event types and complete canonical provider evidence.
- Candidate 5: **369/372 checks passed across fourteen suites**, 283.173 seconds. All thirteen other suites passed, including settlement completion/payout guards for pending, action-required, failed, canceled and missing refund evidence, plus the real callback-versus-settlement race. The dispute suite had one opening timeout and two settlement failures. Its log records background event-service startup and a Mongo collection IX-lock timeout during the reversal check; these failures are retained, not counted as passing acceptance.
- Candidate 6 isolates the dispute test's unrelated event publisher and waits for its financial collections/indexes before running. **All 12/12 focused dispute checks passed**, 17.771 seconds. The settlement assertions remain intact; financial runtime is unchanged from candidate 5. The other thirteen candidate 5 suites passed all 360 checks.
- The candidate 4 runtime check reports only the inherited unused `full` parameter in `services/support/zohoMailbox.js`.

Checkpoint: `backend/backups/attorney-v2-refund-events-start/`, **5,224 initial hashes and 15 owned paths** after adding the verified unchanged dispute test to ownership for its fixture correction. Existing owned backend files matched the accepted refund-retention candidate before work. The fixed financial source continues to inherit the accepted Case implementation; the independently advancing root résumé-reference addition remains preserved and awaits combined source adoption.

The final documentation candidate is `/private/tmp/lpc-attorney-review-20260909-refund-events-7`; its backend source matches candidate 6. Tests use Node 24.18.0, isolated synthetic Mongo and mocked Stripe. This slice changes no frontend flow and performs no real financial or provider operations. No new indexes are introduced. Deployment compatibility and adoption of the optional evidence fields, real provider acceptance and combined browser acceptance remain separate gates.

## Remaining work

Financial history, CSV, receipts and other role projections must consume the separate refund evidence without inferring success from the combined settlement status. Chargeback transactions, original checkout recovery, remaining financial agreement and the full preparation sequence remain open. Platform adjustments remain distinct from attorney debt.
