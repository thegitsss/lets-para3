# Reviewed hiring and funding

Active final-review work. Checkpoint: `backend/backups/attorney-v2-phase5-hiring-start/`, with 1,885 initial file hashes and exact baselines for 13 owned paths. The payment setup checkpoint is finalized separately.

## Implementation

`GET /api/cases/:caseId/hiring-review/:applicantId` reads current owner/session, selected application and mirrors, paralegal approval/payout setup, blocks, pre-engagement requirements, original locked amount, exact fee, saved card and applicable prior funding. Normal new funding uses the locked amount. Replacement work preserves the earlier recorded original amount when a lock is missing, and separately displays the remaining funding; it does not fabricate a new amount lock or card charge.

The existing hire endpoint accepts the displayed `reviewedRevision` and owner. Reviewed hires acquire the Matter using an atomic match of its raw reviewed facts and increment its retained version. The final save retains Mongoose validation, save hooks and unknown untouched fields while adding the exact current claim/review conditions through the supported document `$where` save filter. A changed Matter cannot be silently overwritten after a charge. Existing clients retain their route contract.

Approved pre-engagement belongs to the exact selected applicant and must retain the requested acknowledgements/disclosures. Approval for another applicant is not hiring permission. Current account and paralegal facts are checked again before the financial action.

Unknown charge results retain `needs_reconciliation`; they are not released as failed charges or automatically resubmitted. When a known attempt can be retrieved and the provider confirms cancellation with zero received amount, the failed attempt is retained as PaymentOperation evidence before the old funding key/claim is cleared. A new review is then required. An interrupted hire with a verified successful charge for the same owner/Matter/applicant can be explicitly finished without creating another charge or requiring a new saved card. Revocation after acquiring that recovery claim preserves the successful-charge reference.

The browser shows the exact Matter/applicant/card and original amount, fee and total before a named confirmation. Replacement hiring and finishing a funded hire use different zero-new-charge confirmations. Unknown requests remain in tab memory and recover by reading actual current records. The application list refreshes after a verified save. No navigation or generic `success` boolean can stand in for the exact hiring acknowledgement.

Charge handling follows [Stripe's error categories](https://docs.stripe.com/error-handling?lang=node) and [PaymentIntent cancellation contract](https://docs.stripe.com/api/payment_intents/cancel). Real provider behavior remains an operational gate.

## Local verification

- The first run exposed a missing BSON-constructor qualifier in the new claim branch; all seven affected write scenarios stopped before charging. Correcting `Types.ObjectId` to the existing `mongoose.Types.ObjectId` preserved the test scenarios and assertions.
- Candidate 2 passed 29 backend/consumer checks.
- Candidate 3 passed **63/63** checks across reviewed hiring (24), browser-independent client model/API (5), existing escrow (9), and existing cross-role lifecycle/notifications (25 combined). Checks include exact amounts/card, stale changes, approved requirements for a different applicant, last-read account revocation, raw claim races, two simultaneous hires, post-charge scope changes, unknown charge retention, cancellation failure, verified-charge resumption, original/remaining replacement funding, inherited completed task indexes, earlier missing locks, canonical Application/Job/Case outcomes and preserving recovery evidence after revocation.
- **27/27 browser scenarios passed** on candidate 4 across Chromium, Firefox and WebKit, one worker and no retries. They cover exact amount/card/fee confirmation, cancellation, stale review, lost-response recovery, explicit recorded-charge resumption, replacement funding, blocked actions, late account-change responses and narrow/wide keyboard/visual checks. Financial read/write and subsequent application projections are explicit synthetic fixtures; backend tests exercise actual storage and route behavior with a mock provider. The browser tests do not make real Stripe charges.
- All **1,409 fixed source files** remained unchanged. The 320px/1366px Chromium confirmation screenshots were visually inspected: named Matter/applicant, exact amount/fee/charge/card, effect and both confirmation/return actions are readable. Scoped Axe checks passed. Full editorial/brand and page composition acceptance remains open.
- API contract passes with 421 frontend literals against 402 mounted patterns. Hygiene retains the 19 independently owned admin/paralegal-preview findings and no attorney finding.

## Next closure: application withdrawal interlock

Read-only follow-up found that the current paralegal Application revoke route checks an earlier funding snapshot, writes the canonical status first, then removes the Case mirror without a hire-claim condition. Its late update can race with a hire. Reproduce and close this under a bounded P5-07 checkpoint before final acceptance; this page's passing tests do not cover that unmodified route yet.

A candidate implementation to verify is to bind the Case mirror removal/version increment to current funding/assignment/claim facts before canonical revocation, and require the existing hire candidate lookup to retain an active Case mirror when a canonical Application exists. This would establish the shared Case as the linearization point without requiring a new multi-document transaction contract for existing clients. Handle partial mirror/application failures as explicit reconciliation and preserve the canonical status comparison; do not blindly overwrite a newer accepted/rejected Application or claim that a failed write means already revoked. First confirm actual race behavior and exact compatibility cases.

Full workspace, collaboration, Payments, account/Help, inventory, editorial, and final populated owner review remain open. No release, real financial operation, cohort change, commit or deployment is included.
