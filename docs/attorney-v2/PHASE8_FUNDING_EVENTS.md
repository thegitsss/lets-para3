# Original funding callbacks

This locally verified P8-09 work follows the [LPC Product North Star](../LPC_PRODUCT_NORTH_STAR.md), [funding controls](PHASE8_FUNDING.md), and [transfer callback transactions](PHASE8_TRANSFER_EVENTS.md). The full attorney experience remains in preparation for final review.

## Reproduced failures

The original callback saved the Matter before its funding ledger and swallowed ledger failures. Its audit and delivery receipt were separate writes. A delayed success could turn released escrow back into funded escrow and replace the first verification date. Nonterminal events trusted old snapshots and metadata before retained payment identifiers, allowing an unrelated intent to change the Matter. Separately, checking the original payment could erase a later refund or chargeback status.

All ten targeted mounted-route checks failed on candidate 1: **0/10**, 35.212 seconds. Six reproduce callback failures; four cover later payment statuses during an explicit original-funding check. Logs retain the original failures.

## Implementation

Funding events associate with exact retained PaymentIntent references in the Matter or its funding operation. Metadata alone cannot attach a payment. Ambiguous references, mismatched current evidence, duplicate retained charges or balance transactions, and authenticated connected-account funding events are recorded for review without changing financial records. Platform funding reads use the authenticated event's account context; an unsigned account header cannot redirect the provider lookup.

The handler retrieves the current PaymentIntent and verifies its captured charge and balance transaction. Amount, currency, mode, owner/customer, Matter metadata, transfer group, charge identity and original gross/fee/net evidence must agree. Stripe does not guarantee event ordering; its API supports retrieving the current payment object. These checks use that current object instead of allowing a delayed snapshot to regress the payment. [Stripe webhook guidance](https://docs.stripe.com/webhooks), [retrieve a PaymentIntent](https://docs.stripe.com/api/payment_intents/retrieve).

The matching funding operation, applicable Matter projection, deterministic audit and exact delivery attempt commit in one transaction. Source inventories are rechecked across the provider read. A replaced attempt cannot commit late writes. Audit identity and event fingerprint survive delivery-receipt expiry; a changed event cannot reuse the retained business identity. A lost commit acknowledgement leaves the complete processed receipt available for deduplication.

Original funding verification is separate from available escrow and current work. Later refund/payout/settlement/dispute records, retained claims, closed or withdrawn work, first verification dates and remaining amounts are preserved. Historical refunded or disputed charge evidence stays under review; it is not used to invent a new available balance. Valid first funding requires eligible current participants before opening work. Manual original-funding checks share capture validation and payment-state protection with callbacks.

Post-commit notifications and refreshes are best effort. Notification failure cannot reset a committed funding receipt. No callback creates a charge, transfer or refund.

## Local evidence

- Candidate 1: **0/10 original checks passed**, 35.212 seconds.
- Candidate 2: **80/85 checks passed**, 44.327 seconds. The five failures identified one compatibility issue: Case's existing save hook stores empty settlement amounts as zero. The new lifecycle guard initially treated those defaults as a settlement. Zero defaults are now distinguished from actual settlement evidence. The existing success fixture was also updated to retain the original PaymentIntent and provide complete current charge/balance evidence.
- Candidate 3 contains expanded tests but was superseded before testing when the zero-default cause was identified.
- Candidate 4: **106/106 checks passed across four suites**, 57.215 seconds. Coverage includes ordinary funding, exact captured amounts, mismatch review, provider failure, changed source, pending refund protection, interrupted receipts/commits, replacement deliveries, retained audit deduplication and historical refunds.
- Candidate 5: **309/309 checks passed across thirteen suites**, 145.177 seconds. This includes authenticated account-context, payout-state, unavailable-paralegal, duplicate-charge and post-commit-notification checks, plus affected funding/client, escrow/hiring, completion, withdrawal, financial history, receipt history, transfer and payment-projection consumers.
- Runtime checks on completed candidates 4 and 5 report only the inherited unused `full` parameter in `services/support/zohoMailbox.js`.

Checkpoint: `backend/backups/attorney-v2-funding-events-start/`, 4,691 initial source hashes and nine owned paths. Candidates preserve the preceding financial baseline's pinned Case route; independently advancing Account/Security/résumé changes in the root workspace remain separate from these financial tests. The accepted runtime candidate is `/private/tmp/lpc-attorney-review-20260909-funding-events-5`; the final documentation candidate is `/private/tmp/lpc-attorney-review-20260909-funding-events-6`.

Tests use Node 24.18.0, an isolated synthetic Mongo replica and mocked Stripe. Signature construction is stubbed in callback tests. No real provider, external message, production, deployment or cohort action occurs. This backend callback slice changes no frontend flow; prior browser evidence is separate.

## Remaining work

Refund and chargeback handlers still need exact retained association and transactional business/delivery outcomes. Original checkout recovery, active/pending records, attorney/paralegal/admin financial agreement, receipts/CSV and storage retention remain open. Financial adjustments belong to the platform; they must not be presented as attorney debt. Final combined source adoption, provider/operational acceptance and the populated owner walkthrough remain separate gates.
