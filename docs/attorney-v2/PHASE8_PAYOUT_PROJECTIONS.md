# Recorded payout projections

This P8-09 payout evidence slice is locally verified after [card-dispute transactions](PHASE8_CHARGEBACK_EVENTS.md). The complete attorney experience and combined-source lifecycle acceptance remain open.

Checkpoint `backend/backups/attorney-v2-payout-projections-start/` retains 6,643 initial hashes and nine owned paths. The starting financial source is `/private/tmp/lpc-attorney-review-20260909-chargeback-events-9`; the existing projection service, financial-history service and their two test files matched the accepted runtime bytes before ownership was recorded. Earlier private Case-source boundaries remain intact.

The shared earnings projection currently accepts missing/null/empty payout status, estimates historical withdrawal payments without a payout row, and loses an earlier paid assignment when another paralegal starts work. It can also count an older paid row after a negative transfer or Matter outcome. Seven initial synthetic checks characterize these cases before correction. All seven failed on candidate 1 in 8.984 seconds. Candidate 2 then passed 84/84 payout/history/chargeback checks in 32.456 seconds.

Use actual retained payout and transfer evidence consistently with attorney financial history. Preserve already-paid paralegal amounts and original withdrawal decisions; do not turn an unconfirmed decision into money or charge platform losses to the attorney. Retain source-change and amount/currency/date uncertainty. No provider reads, repair writes, real financial mutations, deployment or cohort activation are part of this slice. Attorney summary/active/pending/history/CSV and broader administrator agreement remain in P8-09 after the bounded payout evidence work.


## Current implementation and evidence

The shared payout predicate from attorney financial history now also supplies the retained earnings projection. It checks actual paid status, transfer reference, assignment/withdrawal/settlement context, current negative outcomes, linked operation state and amounts, and conflicting global transfer references. Both readers include global reference inventory in their source comparison; a new foreign reference invalidates an older CSV revision without revealing the other Matter.

The earnings projection uses bounded raw persisted records, rechecks the complete relevant source before returning, and makes no repair or provider calls. Historical withdrawal decisions alone do not create earnings. Earlier paid assignments survive a replacement hire. Missing payout dates remain missing and are excluded from time-period totals. Supported currencies are grouped separately in the internal projection. The existing three dashboard fields remain USD values; additional currency and review-state presentation is still part of whole financial-view acceptance.

The settlement operation's original `amount` can describe a gross decision, whereas `transferAmount` describes the net payout. That distinction was found during source review after candidate 2 and is explicitly handled and tested in candidate 3. Ordinary payout operations retain exact net-amount agreement. Existing projection tests now expect a recorded decision without a payout to contribute no paid money; the normal paid fixture retains its exact transfer reference.

Candidate 1 has 1,582 files; candidates 2–5 have 1,583. Runtime candidate 3 is `/private/tmp/lpc-attorney-review-20260909-payout-projections-3`; candidate 4 adds the final mounted-dashboard checks, and final candidate 5 retains identical runtime/tests with the completed evidence record. The ten-suite candidate 3 run passed **211/212** checks in 180.783 seconds: nine suites passed, and the Phase 2 full lifecycle journey stopped on the inherited private Search mismatch described below. Candidate 4 passed **73/73** payout/history checks in 56.208 seconds, including the actual dashboard route. Runtime candidates 2 and 3 report only the inherited `services/support/zohoMailbox.js:34` unused parameter. No frontend files or payment-writing authority changed.


## Combined-source issue found during the wider run

The candidate 3 Phase 2 lifecycle journey stopped at its second checkpoint (published search), before payment activity: private `routes/cases.js:2336` calls `validateSearchRead`, which the older private `authenticatedSearch.js` does not export. The current root search service does export it. Its root SHA-256 at inspection was `a21dbd3485f6fbe1e7a50c1f07744185f885abedc7791f348472cb26cd71219b`; the private service was `82c0620731637e2ef292e90a8336b405528bb88a0987424f840b871ca01a238e`. This is an inherited private-source assembly mismatch, not a new payout calculation failure. The broader journey is not accepted. Adopt and verify the complete current Search dependency set in the combined candidate; do not fix it with a test-only validator or silently overlay unrelated root sources.

The final focused test file also mounts the actual paralegal dashboard router to verify retained totals, account separation, wrong-role denial and unavailable-record responses independently of that blocked search journey. These checks do not replace the open complete lifecycle acceptance.


## Acceptance boundary

No payout/Case/operation/model/index repair or payment-policy write was introduced. The shared administrator `SUCCESSFUL_PAYOUT_MATCH` now requires an explicit paid status; broader administrator amount/currency/source agreement remains in P8-09. No frontend source changed, and this slice does not add browser certification. The existing dashboard fields still present USD; review counts and other-currency presentation remain part of whole-view convergence. Full phase-2 lifecycle, current Search dependency adoption, older attorney summaries/active/pending/history/CSV, original Checkout recovery and the final combined owner walkthrough remain open.
