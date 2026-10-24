# Payment callback delivery attempts

This bounded P8-09 correction follows the [LPC Product North Star](../LPC_PRODUCT_NORTH_STAR.md). It protects delivery-receipt outcomes. It does **not** finish the individual funding, transfer, refund or chargeback handlers, nor certify overall financial consistency or release readiness.

## Reproduced failures

The existing handler allowed a processing delivery to be reclaimed after ten minutes, but marked success using only event ID and processing status, and marked failure using only event ID. An older handler could therefore finalize a newer handler's receipt, mark an active replacement failed, or reopen a replacement that had already completed.

All three mounted-route reproductions failed on the original handler: **0/3 passed**, 8.428 seconds. The earlier success returned 200 instead of refusing the stale update. Both late-failure cases changed the replacement record to `failed`. Tests used two independently paused handler invocations and the actual persisted attempt counter. No real provider request or financial mutation was used.

## Correction

Success and failure updates now match the exact record, event ID, processing state, attempt number and attempt start time returned by the atomic claim. These are existing fields; no model, schema, index or migration was added. Claim and outcome writes request majority acknowledgement.

A stale handler cannot change its replacement's receipt or send a fresh failure alert for that replacement. A lost acknowledgement after a committed processed write also cannot reset the receipt to failed; the provider's retry sees the processed receipt and is deduplicated. A current handler's actual failure still records the error, sends the existing alert and allows normal retry.

Handling requires the existing unique event-ID index. The guard reads the index inventory and returns retryable 503 while it is unavailable; it creates no index and performs no handler work. Signed envelopes without a usable event ID/type are also refused before handling. Financial handler logic, provider signatures/secrets and the existing receipt-retention period are unchanged.

## Local evidence

Checkpoint: `backend/backups/attorney-v2-webhook-delivery-start/`, with **4,153 initial hashes** and six owned paths. Corrected runtime candidate: `/private/tmp/lpc-attorney-review-20260909-webhook-delivery-2`.

- **75/75 checks passed across three suites**, 34.81 seconds: twelve new delivery scenarios, seven existing webhook scenarios and 56 funding checks. Coverage includes all three reproduced races, a lost processed-write acknowledgement, current failure/retry, competing fresh deliveries, immutable processed receipts, missing unique index and invalid signed-envelope identity.
- Runtime bindings reported only the inherited unused `full` parameter in `services/support/zohoMailbox.js`; the changed webhook source passed. Frontend code and API routes are unchanged, so no browser rerun was added for this receipt-only correction.
- Tested owned runtime files remained unchanged. The independently recorded P9-01–03 account checklist closures were preserved, with their exact documentation diff retained. Account implementation files have not yet been adopted into this isolated financial candidate; combined integration remains open.
- Tests used Node 24.18.0, an isolated local Mongo replica set and synthetic signed-event substitutes. Alerts were mocked. No production data, external messages, real provider operations, deployment or V1 retirement occurred.

The final documentation candidate is `/private/tmp/lpc-attorney-review-20260909-webhook-delivery-3`; its runtime is unchanged from candidate 2. Exact manifests, source archives and the bounded patch are retained in the checkpoint.

## Remaining P8-09 work

The receipt fence does not make older handlers' business writes atomic. Transfer callbacks still need exact operation/payout association and preservation of later reversals/withdrawal decisions. Funding and refund callbacks need stable current evidence and Case/ledger/audit transactions. Current payout helpers must retain a known transfer even if their following database update fails. Active/pending totals, attorney/paralegal/admin agreement, original checkout recovery and retention/provider acceptance remain open.
