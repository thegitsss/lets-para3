# Refund history, totals and CSV

This P8-04/P8-09 work connects the [separate refund evidence](PHASE8_REFUND_EVENTS.md) to attorney financial history. It follows the [LPC editorial standard](EDITORIAL_STANDARD.md). Whole financial agreement, chargeback handling and final attorney readiness remain open.

## Behavior

Financial history now distinguishes a completed refund, pending refund, action-required refund, failed refund and canceled refund. A combined settlement's payout status does not substitute for its refund status. Older requests without independent evidence remain unconfirmed. The refund date comes from the retained provider date; a missing date is not replaced by the operation's creation or verification date.

Recorded refunds have a separate currency total. Original funding and paralegal payout totals keep their existing meaning. Refunds awaiting completion, failed/canceled attempts and unverified records stay outside the completed-refund total. The screen and CSV use the same outcome and amount descriptions. Action-required refunds appear in the review filter.

Certification requires the exact original payment, retained refund/charge references, positive recorded refund amount, compatible currency/mode, current evidence status and a recorded verification time. Conflicting funding references, duplicate refund references anywhere in the operation collection and impossible active-refund totals require review. Global duplicate checks expose no other owner's records. Stable snapshots include the new refund fields and global references, so a changed refund cannot be exported using an earlier reviewed revision. Reads perform no financial repair or provider request; the existing receipt review performs its explicit current provider check.

The browser validates the separate totals and the relationship between refund state, amount and description. A contradictory response clears earlier amounts and disables CSV export. These presentation changes add no financial writer, schema field or index. The previously introduced optional refund evidence fields still have their own deployment-adoption gate.

## Evidence

- Candidate 1: **0/4 original refund display checks passed**, 37.957 seconds. It showed a verified refund as unconfirmed, lacked a separate completed-refund total, confused combined-settlement status with refund status, and substituted the operation date for a missing provider date.
- Candidate 2: **39/39 history and client checks passed**. The third suite's database setup timed out before its funding assertions, producing a 39/99 overall result, 66.797 seconds. On the unchanged candidate, the focused funding suite passed **60/60**, 38.205 seconds. The setup failure remains retained.
- Candidate 3: **147/147 checks passed across five suites**, 47.377 seconds. This includes explicit outcome/mismatch, global duplicate, aggregate, stale CSV and actual-callback-to-history checks, plus the affected receipt and callback consumers.
- Candidate 4: the strengthened actual callback/history/current-receipt comparison passed **1/1**, with 54 unrelated cases not selected, 44.417 seconds. A 10,000-cent refund agrees between history and the receipt, whose original 48,800-cent payment becomes 38,800 cents after the refund. The history itself makes no additional provider read.
- Candidate 5 also prevents unsupported minor-unit currencies from receiving a verified refund description; the added check requires an unavailable amount and consistent review state. **All 60/60 final history/client checks passed**, 67.67 seconds, including the strengthened callback-to-receipt comparison.
- Candidate 5 browser acceptance: **33/33 scenarios passed** across Chromium, Firefox and WebKit, 5.9 minutes. This includes all refund outcomes, separate totals, contradictory-response clearing, complete 505-row CSV bytes, exact Matter filters/links, cancellation, account changes, keyboard focus and automated AA checks at 320/390/768/1366 pixels.
- Candidate 6 removes the awkward `Recorded on: Date not recorded` phrase and captures the heading/summary before the lower records at each width. **All 3/3 final layout scenarios passed**, 3.0 minutes. Chromium desktop/phone and WebKit phone captures were visually inspected. The final documentation candidate also corrects singular `1 has` wording; that final copy-only change passes JavaScript syntax checking.
- Runtime checks on candidates 2 and 5 report only the inherited unused `full` parameter in `services/support/zohoMailbox.js`. The supplemental candidate 4 frontend check found no issues or unreachable imports in the two owned modules; it does not replace the whole-repository check.

Checkpoint: `backend/backups/attorney-v2-refund-history-start/`, **5,643 initial source hashes and nine owned paths**. All six existing implementation/test sources matched the preceding fixed financial candidate before work. The inherited private Case source and separate concurrent root résumé changes remain as recorded in [transfer callback evidence](PHASE8_TRANSFER_EVENTS.md).

The accepted backend is candidate 5; the final frontend wording and documentation are retained in `/private/tmp/lpc-attorney-review-20260909-refund-history-7`. Supplemental frontend checks on candidates 4 and 6 found no owned-module issues or unreachable imports. Tests use Node 24.18.0, isolated synthetic Mongo and mocked Stripe. Backend financial checks and browser rendering checks are recorded separately. No real refund, transfer, provider message, deployment or cohort activation is part of this work.

## Remaining work

The legacy payment summary/history/export adapters, Home totals, active/pending funding treatment, paralegal earnings and administrator records still require full agreement. Chargeback transactions and original checkout recovery remain open. Final combined source adoption, accessibility/provider/device acceptance and the populated owner walkthrough remain in the preparation sequence.
