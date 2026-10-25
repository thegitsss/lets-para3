# Transfer callbacks and financial records

This locally verified P8-09 work follows the [LPC Product North Star](../LPC_PRODUCT_NORTH_STAR.md) and the preceding [transfer-attempt retention correction](PHASE8_TRANSFER_RETENTION.md). It does not close overall financial consistency or full attorney readiness.

## Reproduced failures

The old callback handler found a Matter by `transfer_group`, saved its payout flags, then separately updated payout rows, broad groups of payment operations and the audit trail. It could attach an older withdrawal's transfer to an unrelated pending refund, change the current Matter because an older payout changed, leave money records changed after an audit failure, and label a partial reversal as a full reversal.

All five mounted-route reproductions failed on candidate 1: **0/5 passed**, 12.252 seconds. The tests include two retained payouts for different paralegals and a separate pending refund. The original failure output is retained.

The expanded tests then reproduced three producer races: a reversal could be followed by creation of a paid ledger, a succeeded payment-operation marker, or the transfer helper clearing the reversal's review state. Candidate 3 passed 40 checks and failed these three.

## Implementation

The callback service associates an event with the exact retained transfer identifier in `Payout` and `PaymentOperation`. A transfer group alone cannot choose a money record. Duplicate references, inconsistent Matter/operation keys, amounts, currency, provider mode, source charge or retained payee metadata are recorded for review without making the suggested financial changes. A transfer-created event is an observation; it does not create a paid ledger or complete a Matter.

The matching payout and operation, any applicable current Matter projection, a deterministic audit record and the exact delivery attempt's processed outcome commit in one transaction. A replaced handler cannot commit late financial writes. A lost commit acknowledgement leaves the complete committed receipt available for deduplication. The audit record retains an event-content fingerprint and survives independent delivery receipt expiry. Missing or inconsistent evidence is not treated as an empty paid balance.

An earlier withdrawal reversal updates that withdrawal's payout and operation. It does not overwrite a later Matter payout. Current negative evidence does not reopen work, add to the available balance, erase completion dates or delete earlier payment history. Partial reversal records remain under review; only a verified full reversal is labeled fully reversed. Later positive observations cannot clear either state.

Stripe defines `amount_reversed` separately from the boolean that indicates a full reversal, and `transfer.reversed` also covers partial reversals. Its current event list describes `transfer.updated` as a metadata/description update and does not list `transfer.failed`. The retained legacy failure branch therefore requests review rather than fabricating a supported provider outcome. [Transfer object](https://docs.stripe.com/api/transfers/object), [event types](https://docs.stripe.com/api/events/types).

The existing `evidenceStatus: quarantined` value protects a transfer operation after negative provider evidence. New/reclaimed requests, reference retention, generic failure handling, successful-operation writes and payout-ledger creation preserve this marker. Payout creation takes a transactional write on its matching operation so it cannot race a reversal that arrived before the payout row existed. Existing paid rows remain subject to their exact evidence guard.

Transfer requests now retain expected net amount, provider mode and source charge before the provider call, using existing operation fields. Completion commits its payout, platform income and operation together. Reviewed withdrawal keeps its existing enclosing transaction. Both administrator settlement transfer branches commit the payout, income, Case outcome, operation and settlement audit together, with projection refresh after commit. The legacy completion save also checks current retained payout evidence in a transaction. Catch paths preserve existing failure/reversal records.

## Evidence so far

Checkpoint: `backend/backups/attorney-v2-transfer-events-start/`, **4,348 initial hashes**. The scope was extended only after verifying the unchanged completion and settlement test baselines. All archives, candidate manifests and logs are retained.

- Candidate 1: **0/5** original reproduction checks passed.
- Candidate 2: **23/24** callback/delivery/webhook checks passed. The legacy webhook fixture encountered Mongo lock timeout 24 during its new transaction. That fixture now explicitly initializes its existing core models and isolates event delivery, in addition to using complete mode/reversal fields.
- Candidate 3: **40/43** expanded event/retention checks passed. The three failing producer races are described above. The transaction/marker guards were added in candidate 4.
- Candidate 4: **223/224** checks passed across ten suites, 259.015 seconds. The remaining completion test targeted the second commit by ordinal; the new payout transaction changed that order. The test now targets the actual completion audit transaction and still simulates a lost acknowledgement after a real commit.
- Candidate 5: **281/281 checks passed across thirteen suites**, 235.894 seconds. This includes grouped producer transactions, explicit settlement rollback/retry tests, reviewed and legacy completion reversal tests, retained provider-request evidence and the affected chargeback, financial-history and payment-projection consumers. The final concurrency check covers a reversal arriving while a payout transaction holds its operation write.
- Candidate 6: **45/45 executed event/retention checks passed**, including the in-flight payout/reversal race. The completion suite could not load because a concurrent five-line résumé-reference change entered shared `cases.js` without its separate new dependency in this isolated snapshot. Root work was preserved; its exact diff is `preserved-concurrent-resume.patch`. Candidate 7 explicitly pins `cases.js` to the verified candidate 5 source, and its manifest records that source and hash. This is a financial-source verification set, not acceptance of the independent résumé change.
- Candidate 7: **89/89 final focused checks passed across three suites**, 52.455 seconds. The same fixed financial source set covers the final concurrent transaction/reversal case, all retained-reference scenarios and reviewed/legacy completion. Its runtime check again reports only the inherited Zoho parameter.
- Runtime checks on completed candidates 4 and 5 reported only the inherited unused `full` parameter in `services/support/zohoMailbox.js`. An earlier checker invocation ran before the candidate's dependency link was ready and is retained separately as `runtime-4.log`; the valid result is `runtime-4-ready.log`. Payment-route indentation was subsequently cleaned up; a parsed-program comparison confirms that cleanup changed no executable code or string values.

Tests use Node 24.18.0, isolated synthetic Mongo and mocked Stripe. Callback tests stub signature construction; they exercise the mounted handler and persisted business records. There are no real provider calls, external alerts/messages, production data writes, deployments or cohort changes. Browser/combined experience acceptance is separate.

The final documentation candidate is `/private/tmp/lpc-attorney-review-20260909-transfer-events-8`. It retains the candidate 7 runtime and the explicit Case source pin. The checkpoint owns seventeen paths; preserved concurrent root changes are distinguished from the financial candidate and its clean patch.

## Remaining work

Continue funding/refund/chargeback callback transactions, active/pending and historical checkout recovery, attorney/paralegal/admin financial agreement, exact receipts/CSV, and storage retention. Unknown historical transfers without a retained reference need an explicit reconciliation disposition; the service does not infer their association from editable provider metadata alone.

Platform income and platform financial adjustments remain distinct from attorney debt. Real provider delivery, operational reconciliation, multi-instance behavior, storage acceptance and final combined owner review are still open. Account and notification implementations developed independently have not yet been adopted into this financial candidate.
