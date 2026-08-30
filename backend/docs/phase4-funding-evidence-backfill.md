# Phase 4 funding-evidence backfill procedure

Status: candidate procedure only. Counsel is not implicated. Production execution and deployment are not authorized.

## Safety contract

`scripts/backfill-funding-evidence.js` is dry-run only unless both `--apply` and the exact confirmation phrase are supplied. Its Stripe client calls are limited to retrieving PaymentIntents, Charges, and Balance Transactions. It never creates, confirms, captures, cancels, or updates a PaymentIntent; creates a Charge; or creates a refund, transfer, payout, customer, or payment method.

The utility never estimates a processing fee. It can follow a stored Case PaymentIntent reference or a related legacy Charge or Balance Transaction reference back to the PaymentIntent. A funding operation is eligible only when the Case, successful PaymentIntent, successful non-refunded/non-disputed Charge, and Stripe Balance Transaction agree on identity, amount, currency, and mode. Missing, ambiguous, refunded, disputed, duplicated, or inconsistent evidence is reported for manual review and blocks apply mode.

Reports contain masked internal and Stripe references. They contain no customer names, email addresses, customer IDs, payment-method IDs, card brands, card numbers, or bank details.

The Phase 4 schema intentionally does not declare new indexes on the added Stripe-evidence fields. LPC's existing unique `PaymentOperation.operationKey` remains the idempotency authority. Unique indexes for PaymentIntent, Charge, or Balance Transaction evidence must not be introduced until a separately authorized Phase 4B production-readiness check has proved that the candidate fields contain no duplicates and a controlled migration has been approved.

## Review and execution procedure

1. Deploy the reviewed code without running the backfill. Confirm application health and current payment reconciliation queues.
2. Create an Atlas on-demand snapshot or other point-in-time recoverable database checkpoint. Record the checkpoint identifier and retention deadline in the change ticket.
3. Run `npm run backfill:funding-evidence` with production read credentials and the correct Stripe key. Save the masked JSON report in restricted operational evidence storage.
4. Resolve every `reviewRequired` item. Do not apply while the report contains unmatched, ambiguous, refunded, disputed, duplicate, or inconsistent transactions.
5. Record the exact expected mutation count as `expectedCreates + expectedUpdates`. Separately record expected creates, expected updates, test-mode records, live-mode records, gross charges, processing fees, and net charges.
6. Immediately before execution, create or verify a fresh recoverable checkpoint and run a second dry run. The second report must exactly match the approved record counts and aggregate cents. Any difference cancels the change window.
7. Run the guarded command:

   `node scripts/backfill-funding-evidence.js --apply --confirm=apply-reviewed-funding-evidence --expected-records=<EXACT_COUNT>`

8. Confirm `appliedCreates + appliedUpdates` equals the approved exact count. Run the dry run again; it must report zero expected creates, zero expected updates, and the approved count as unchanged verified evidence.
9. Reconcile test and live modes separately against Stripe exports: PaymentIntent count, Charge count, Balance Transaction count, gross cents, fee cents, net cents, refunded cents, and LPC payout-ledger cents. Never combine test and live totals.
10. Run payment, payout, refund, dispute, webhook, dashboard-projection, receipt, admin, and full Jest verification. Review payment-operation and webhook reconciliation queues before closing the change.

## Rollback

If any count, identifier, mode, or aggregate differs after apply, stop application traffic that can alter the affected financial projections and restore the pre-change database checkpoint using the documented Atlas point-in-time restore procedure. Because the utility only creates funding `PaymentOperation` records or fills previously absent funding-evidence fields, Stripe requires no rollback: no Stripe object was mutated and no attorney charge, payout, transfer, or refund can have been triggered by this utility.

Do not attempt an ad hoc compensating Stripe transaction. Preserve the failed apply report and database snapshot for reconciliation, restore the database checkpoint, rerun the dry run, and investigate before scheduling another change window.

## Required Phase 4B follow-ups

- Add canonical, idempotent chargeback evidence through the existing `PaymentOperation` architecture.
- Add immutable platform-income reversal or adjustment evidence without deleting or rewriting the original `PlatformIncome` record.
- Confirm production unique-index readiness before proposing a controlled index migration.
- Conduct a separately authorized, read-only production dry run of this historical funding-evidence backfill.
- Reconcile test-mode and live-mode historical transactions separately.
- Require separate authorization before applying any production backfill.
