# Application decisions — local verification

September 7, 2026. Owner instruction: continue the attorney build until it is ready for final review. This document records one dependency of that build; it does not declare the full attorney experience ready. The isolated V2 release remains disabled with no attorney cohort.

## Implemented behavior

Current and V2 application review share explicit star, remove-star, shortlist, return-to-submitted and rejection controls. Each change names the applicant and Matter, explains its effect and requires confirmation. Shortlisting does not assign a paralegal or fund a Matter. Rejection preserves the application and its history.

The server binds decisions to the application and Matter reviewed by the attorney, revalidates account, application, profile and block eligibility, and commits Application, Case applicant mirror, Job count and a durable decision acknowledgement in one MongoDB transaction. A conflict rolls the transaction back. There is no standalone-database fallback or automatic transaction retry. The existing star/reject endpoints use the same service and retain their response fields and cross-role refresh signals.

The Case applicant schema supports pending, accepted and rejected. Canonical submitted, viewed and shortlisted applications therefore retain a pending Case mirror. Earlier Case-only applications can be starred or rejected without inventing a canonical Application; shortlist and return require a canonical record. Updates preserve other attorneys' stars, unknown fields, cover letters and unrelated applicants.

An unconfirmed browser response retains only account-private request metadata in memory. Checking the saved result performs a read and verifies the exact request, reviewed revision, action and resulting state. It never resubmits the write. A missing acknowledgement asks the attorney to review the current application before deciding again. Account loss clears the private state and discards late responses.

Application decisions increment the Matter version atomically. Hiring claims are now conditional on the version examined before payment-method lookup, preventing a hire that read an application before a committed decision from overwriting that decision. Existing funding and reconciliation behavior remain authoritative.

## Scope and evidence

Checkpoint: `backend/backups/attorney-v2-final-review-start/`, including the initial 1,701-file manifest, exact owned baselines and logs. Node 24.18.0 on macOS; synthetic MongoDB replica set and provider doubles only. No real payment mutation or rollout is part of this work.

The first decision/read/model verification had 110 passing checks and one incorrect assertion expecting 403 for a paralegal; Matter access deliberately returns 404. After correction, the four focused decision/read/résumé/model suites passed 116 checks. The cross-role suite initially failed during newly introduced blanket model initialization because an existing unrelated LpcEvent partial index uses an unsupported `$ne` expression. Limiting initialization to the required new decision index restored the intended fixture setup; all 10 cross-role checks passed. This does not resolve or certify the unrelated LpcEvent index. A workspace-wide Jest harness lock also correctly refused one run while another test process was active; that process was left untouched.

The decision and existing hiring regression suites passed 40/40 checks in 158.686 seconds after the hire-claim interlock was added. This includes canonical and earlier-only rejection-before-hire checks with no charge, alongside the hire-before-decision rollback check and existing successful-funding recovery cases.

Application review now includes the LinkedIn address retained on the Application, or the earlier Matter entry when no canonical record exists. The current User profile is never substituted. Only validated linkedin.com HTTP(S) addresses without credentials become external links; the client validates them independently and uses an explicit new-tab label and no-referrer policy. The link does not claim that LinkedIn content is an immutable submission snapshot. No external address is fetched by the server.

Latest repository checks resolve 404 frontend API literals against 397 mounted route patterns. Runtime bindings currently fail only on an unowned unused parameter in `services/support/zohoMailbox.js`. Frontend hygiene reports 19 unowned admin/paralegal-preview findings. These are product-wide candidate gates, not waived by the attorney slice. The initial runtime command used a nonexistent `.js` extension; the real checker is `.mjs` and its result is retained separately.

Stored-reference and application-model verification passed 41/41 checks. The fresh-hire follow-up passed 42/42 across decision and existing hiring suites; Case disables Mongoose's version key, so the claim reads the retained revision with `doc.get("__v")`. The index-readiness follow-up passed 39/39 across decision and decision-model suites, including refusal to offer or accept decisions without the required unique acknowledgement index. These runs overlap and must not be added together as a distinct total.

## Browser acceptance and diagnosis

The final complete browser run passed **39/39 across Chromium, Firefox and WebKit**, with one worker, no retries and a 90-second maximum per multi-step scenario. It exercised both current and V2 controls, all five real decisions and their paralegal status/history, cancellation, lost responses and read-only recovery, stale reviews, withdrawal, late responses after account changes, recorded-reference link restrictions, keyboard confirmation, mobile/desktop layout and automated accessibility checks.

The first run was stopped after an unexpected conflict. Its current-dashboard five-action journey passed, but the V2 save did not. Unchanged-source diagnosis first encountered a local Mongo startup timeout, then publication failures before application decisions were reached. Fixed private candidates isolated subsequent tests from concurrent workspace edits. Traces distinguished a still-pending request at the assertion deadline from MongoDB `LockTimeout` and `WriteConflict` responses. A diagnostic driver wrapper logged only collection/method and lock-error details; it preserved results and did not retry writes.

The decision model now registers at server startup, and review checks required index readiness before offering actions. The attorney browser configuration also completes its core collection/index initialization before opening the HTTP port. Its temporary Mongo startup allowance is 60 seconds, matching the Jest harness; action assertions, scenario budgets, conflict checks and retry policy were not weakened. Other browser configurations retain their existing startup behavior. Production index/configuration readiness remains a release gate.

The passing run used `/private/tmp/lpc-attorney-review-20260907-decisions-3`, with 1,381 exact file hashes in `isolated-candidate-3.json`. No environment files were copied. The installed backend dependencies were shared through a read-only-use symlink; lockfile bytes are in the manifest. Earlier private candidates are retained. The original workspace continued into the separately checkpointed pre-engagement work only after the decision candidate was fixed.

Chromium current/V2 screenshots at 320px and 1366px were visually inspected: confirmation names the applicant and Matter, the effect and cancel action remain readable, focus is visible, and controls fit the viewport. Full authenticated branding, broader wording review, real-device/screen-reader acceptance and ordinary attorney workflows remain open. No broader phase gate is closed by this document alone.
