# Shared withdrawal expiry

September 9, 2026. The [LPC Product North Star](../LPC_PRODUCT_NORTH_STAR.md) controls this bounded correction. Full attorney review readiness remains open.

## Proven defects

The older `finalizeExpiredDisputeWindow` changed a previously loaded Mongoose document, opened its Job, generated receipt copies, and returned for the caller to save the Case. The completed-history GET, Matter GET and legacy hiring route called it.

Two tests reproduced defects on the preceding immutable candidate:

- An administrator began a permitted payout after the withdrawal deadline. While its provider response was paused, Matter GET loaded fields that omitted the active withdrawal claim. It finalized an automatic zero payout over the in-flight decision. The first test failed because `payoutFinalizedAt` became non-null during that claimed transfer.
- Completed-history GET passed its narrow display projection into expiry. Without the full Matter fields and no existing Job, posting creation failed because `practiceArea` was missing; the final outcome remained unrecorded. The old helper also derived its remaining amount from this incomplete projection. A separate existing-Job regression now verifies that the full cents are retained.

Both initial reproduction tests failed as expected (0/2 passed, 15.913 seconds), with the missing-practice-area error retained in the log. Do not describe that second run as observed balance corruption: the posting validation stopped its final Case save.

## Correction

Scheduled and request-time expiry now use `attorneyWithdrawal.expire`. It loads raw current Case data inside a transaction, checks the deadline, withdrawal/assignment state, owner aliases, closed state, disputes, all financial claims, original/remaining balance, earlier withdrawal evidence, payout/operation records and related Job.

An eligible automatic decision commits the zero outcome, remaining amount, posting status and system audit together. The service uses the same existing posting validation and synchronization as reviewed withdrawal decisions. It creates no payout, charge or provider request. Invalid balance, current payout evidence, refund request, held payment or broken posting leaves the decision unfinalized for review. The worker excludes known closed/assigned/claimed cases from its candidate batch and rechecks every candidate in the transaction.

Callers reload the committed projection. They never save the earlier display document. Legacy hiring reloads and checks ownership, assignment and closure after an expiry attempt. Receipt copies and projection refreshes follow a confirmed commit; they cannot reopen a Job after a later hire. A durable expiry audit identifies a commit whose response was lost, without another expiry write or repeated best-effort side effects.

Earlier finalized withdrawals remain intact and are deducted once. New Jobs retain the original Matter budget required by the existing Job contract; the exact remaining assignment amount remains on Case. P5/P8 cross-view amount and posting convergence remain separate work. An expiry with no remaining funds does not announce that work is available to relist.

## Evidence and boundaries

Checkpoint: `backend/backups/attorney-v2-withdrawal-expiry-start/`, 3,914 initial hashes and eight owned paths. It starts from the verified withdrawal candidate with no implicit adoption of concurrent root edits.

- Candidate 1: both original defects reproduced, 0/2.
- Candidate 2: 101/101 checks passed across the corrected expiry routes, reviewed withdrawal, lifecycle jobs, payouts and cross-role Case flow (59.095 seconds).
- Candidate 3: 99/99 checks passed across expanded expiry, lifecycle jobs, withdrawal and disputes (67.102 seconds). They cover competing expiry calls, retained earlier payouts, claims/closure, uncertain amounts and refunds, audit rollback, dispute insertion during the transaction, later hiring during receipt work, and raw aliases/unrendered fields.
- Candidate 4: 37/37 final expiry, lifecycle-job and scheduled-automation checks passed (49.004 seconds), including the existing-Job balance regression. All 461 frontend API literals resolve to 429 mounted routes. The runtime checker reports only the inherited `services/support/zohoMailbox.js:34` unused parameter. All nine browser smoke checks of the unchanged withdrawal/completion controls against the corrected shared reads passed across Chromium, Firefox and WebKit (1.2 minutes). There is no new browser UI in this slice; the preceding 39-case withdrawal UI acceptance remains separate evidence.

All data and provider responses are synthetic. There is no production expiry run, real message, provider/storage mutation, deployment, cohort activation, V1 retirement, commit or push. Receipt-copy failures remain best-effort after the durable decision. Whole financial callback/ledger reconciliation, storage retention, remaining funding controls and the complete attorney review remain open.
