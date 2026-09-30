# Completion payout evidence

September 7, 2026. Bounded dependency for P8-05/P8-09; neither full workflow is closed by this correction.

The existing completion route used the newest current-paralegal Payout regardless of its status, reversal evidence or whether it belonged to a partial payout. It also fabricated paid ledgers from Case/PaymentOperation transfer identifiers and returned already-closed success without checking the payout. These paths could contradict the stricter existing receipt checks.

`completionPayoutEvidence` now reads raw stored records so schema defaults cannot promote an earlier record without status to paid. Completion requires a unique paid, unreversed payout for the correct Matter, current assignment, completion operation (or unambiguous earlier-format record), expected remaining amount and retained fee rate. A present operation must agree on kind, Matter, amount, currency, status and transfer. Partial payouts are not completion evidence. Conflicting aliases, duplicate legacy evidence, foreign transfers, reversals, incomplete operations and identifiers without a paid ledger return reconciliation, without creating another transfer or rewriting payment records. Valid paid evidence still permits lifecycle completion without new money movement.

The shared payout ledger writer now preserves pending, failed, reversed and reconciliation records. Attaching an operation key to existing paid evidence uses a conditional update; a reversal between lookup and update cannot be overwritten as paid, and another operation cannot adopt the transfer.

The existing tests that expected a Case-only transfer or an uncertain operation to fabricate paid ledgers were revised to require reconciliation. This is an intentional correction to the completion behavior, not a claim of unchanged legacy semantics. No administrative reconciliation endpoint, schema, payment arithmetic, provider call or production record was changed. All storage, notifications and Stripe activity in these checks was synthetic/mocked.

## Evidence

Checkpoint: `backend/backups/attorney-v2-phase8-completion-evidence-start/`, 2,710 initial file hashes. Candidate 2 contains 1,487 verified source files.

- Candidate 1: **76/76** checks in completion evidence, payments/payouts, paralegal completion lifecycle, chargebacks and payment operations.
- Candidate 2: **92/92** in completion evidence, payments/payouts, dispute refunds, ledger migration, chargebacks and withdrawal jobs, including the shared ledger's conditional update and reversal race.
- API contract: **448** frontend literals / **417** mounted patterns.
- Runtime bindings: only the previously recorded unowned `services/support/zohoMailbox.js:34` unused parameter remains.

No frontend changed in this dependency. Browser acceptance belongs to the actual completion controls that follow. Final source hashes, before/after archives and the exact patch are retained in the checkpoint; the final documentation-only candidate is candidate 3.

## Remaining completion work

The attorney review/confirmation, displayed-version binding, exact interrupted-request recovery, fresh account checks and final lifecycle transaction remain to be implemented. The existing route still has a nontransactional interval between its final payout evidence read and lifecycle save. Whole-file/archive mutation interlocks, chargeback event ordering and all P8-09 accounting projections remain open. Do not expose a new completion control or claim full completion acceptance from this dependency alone.
