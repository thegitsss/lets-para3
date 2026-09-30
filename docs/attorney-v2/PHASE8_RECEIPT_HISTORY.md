# Matter receipt history

Recorded September 9, 2026. This is a bounded continuation of P8-04 and the full final-review preparation sequence. It does not finish Payments or financial reconciliation.

## Implemented behavior

Both attorney receipt screens now offer a choice of original Matter funding and retained withdrawal decisions. Receipt history lists 25 choices per page, with an actual total, stable record IDs and exact selection beyond the first page. Original funding remains separately accessible after a withdrawal, preserving the original captured payment, attorney fee and processed/pending refund treatment. Choosing a receipt in V2 gives it an exact `receiptId` link that survives refresh. The current dashboard changes the receipt within its existing dialog.

A withdrawal decision amount is explicitly distinguished from a confirmed payout. The list does not call the payment provider or issue a PDF. The selected receipt is checked separately against the original funding evidence or its specific payout record. Missing, conflicting or unavailable records remain visible as an explanation rather than an invented receipt, a fallback to another receipt or a successful empty history. Failed list reads have their own recovery; over 4,000 retained withdrawal records produces an explicit review-limit response.

History can be canceled. Navigation, dialog close and account changes discard late reads. The browser verifies account identity before and after history and receipt JSON as well as PDF delivery. Exact selection IDs and displayed receipt revisions bind downloads to the selected financial document. No receipt content is added to persistent browser storage.

## Financial authority

The original funding path retains the prior capture, ownership, currency, duplicate-intent, chargeback and complete refund-evidence checks. Explicit original-funding selection does not use a later remaining Matter balance or a withdrawal amount as the original charge.

Earlier withdrawals now use their own retained decision and exact payout pointer. If a pointer is absent, compatibility requires an unambiguous single decision and payout for that paralegal. Several assignments cannot borrow the latest payout. A single transfer cannot substantiate two distinct decisions. Duplicate identical Case/history mirrors are deduplicated; conflicting amounts require review. Pending, failed, reversed or reconciliation-needed Payout records cannot issue a paid receipt.

The selected raw payout must belong to this Matter and this withdrawn paralegal. Its stored net amount, actual transfer ID, provider mode when known, assignment timing when recorded and valid gross amount are checked. The gross amount cannot exceed the original Matter amount. Zero-payout decisions remain explicit and cannot coexist with contradictory positive payout evidence. Missing payout dates remain unavailable instead of being replaced by the withdrawal decision date. Arrival in the paralegal's bank account is not confirmed by these receipts.

The service rechecks account and Case sources and re-reads the payout evidence. PDF delivery re-runs receipt review after rendering. A reversal, changed decision or account change during rendering suppresses delivery. These separate reads do not constitute an atomic database/provider snapshot; full webhook and cross-view convergence remains in P8-09.

## Scope and compatibility

`GET /api/payments/receipt/attorney/:caseId/history` is an account-bound, private/no-store read. Existing attorney receipt review/download routes accept an optional explicit `receiptId`, preserving the current default selection for older callers. Unknown exact selections never fall back to that default. The response exposes bounded receipt choices and financial presentation fields, not private Case notes, raw history, payout pointers or participant IDs.

The shared receipt module and stylesheet serve both attorney interfaces. Payments links now say Review Matter receipts. The PDF renderer, provider mutations, financial/lifecycle writes, storage, schema, paralegal receipt API and administrator controls are unchanged by this slice.

Two existing root-tree presentation edits were inspected before adoption: the receipt module's optional Matter-title display and removal of repeated introductory/payout wording, and the Payments page's shorter heading treatment. Those edits were preserved in the new baseline. Other unowned attorney, admin, paralegal and public-page changes remain excluded from the private runtime candidates.

## Verification

Checkpoint: `backend/backups/attorney-v2-receipt-history-start/`, with 3,738 initial file hashes and 18 owned paths after baseline extensions. The private runtime candidates are individually manifested. Candidate 3 contains 1,535 files and the final runtime; the subsequent candidate carries documentation only.

The initial backend/client run passed **75/75 across four suites**: receipt history, its client helper, existing attorney receipts and the existing receipt client. The final expanded run passed **77/77**, adding missing-date, invalid gross amount, provider-mode and earlier-assignment checks. Mongo data, payment-provider responses and server PDF bytes were synthetic. No actual payment or storage service was mutated. The PDF renderer is unchanged; this run does not claim a new rendered-PDF or live-provider acceptance.

The combined browser run passed **90/90** across Chromium, Firefox and WebKit, using one worker and no retries. It includes the new history journeys, existing current/V2 receipt controls and Payments navigation. Tests cover more than one page of historical decisions, actual downloaded bytes and filename, exact older links through refresh, current-dialog selection, mismatched responses, failed/conflicting pages, missing/malformed links, account changes, cancellation and safe long labels. The final shared spacing change passed all **6/6 phone/desktop/keyboard scenarios** from the new and existing receipt suites, recorded in `logs/browser-final-3.log`.

Phone and current-dashboard desktop screenshots from the combined run were inspected. The inspection led to additional spacing and separators within the named receipt-history section. Final WebKit phone and current-dashboard desktop screenshots were inspected after that correction. Full LPC shell/typography/context acceptance remains a later whole-experience pass.

The API source check resolves **457 frontend literals against 425 mounted patterns**. Supplemental owned-source hygiene covers seven frontend modules/styles, with no issues and 97 reachable entry-graph scripts. The runtime checker retains the pre-existing unowned unused parameter in `services/support/zohoMailbox.js:34`. These are private-candidate results, not a clean whole-root release claim.

## Remaining work

P8-04 remains open for the complete financial summary, event history and CSV export. P8-03, P8-06 and P8-09 retain funding/budget, withdrawal/relisting and full Case/operation/payout/refund/webhook reconciliation work. Shared financial projections must not infer a paid total from a Matter status or a completed request. Account/global tools, inventory, copy/layout and the populated owner walkthrough remain in [FINAL_REVIEW_PREPARATION.md](FINAL_REVIEW_PREPARATION.md). Production activation and V1 retirement remain separate.
