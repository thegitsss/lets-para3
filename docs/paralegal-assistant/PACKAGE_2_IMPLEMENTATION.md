# Paralegal Assistant Package 2 Implementation

Status: complete

Date: July 23, 2026

## Outcome

Package 2 added the paralegal-specific executable policy, capability, evidence, validation, and least-privilege tool foundation. It did not enable the upgraded manager for paralegals, alter the attorney assistant, deploy code, or make the new model path user-visible.

## Implemented contracts

- A P01–P32 executable capability registry with independent paralegal IDs, required tools, sources, authored evaluation prompts, boundary states, and explicit policy-blocked limitations.
- A canonical workflow policy for application, invitation acceptance, pre-engagement response, assignment/workspace, messaging, task completion, payout readiness, withdrawal, and archive access.
- Behavior-preserving policy integration with existing paralegal mutation gates:
  - application submission delegates through the paralegal policy to the existing executable platform rule;
  - paralegal messaging uses the paralegal evaluator over the same funded-workspace authority;
  - invitation acceptance, pre-engagement submission, and withdrawal use the matching paralegal evaluators after existing authentication and record checks.
- Fourteen read-only paralegal tools for authorized matter/workspace data, applications, invitations, attention, payout setup/history/amounts, account state, deactivation, workflow readiness, messaging, approved knowledge, and navigation.
- Explicit reconciliation across `Application`, `Case.applicants`, `Case.invites`, `pendingParalegalId`, and matching `Case.preEngagement`.
- Least-privilege matter queries that require the authenticated paralegal relationship before any workspace, file, task, message, completion, withdrawal, or financial projection.
- Evidence envelopes that distinguish verified, absent, unknown, unavailable, unauthorized, not-applicable, and policy-blocked conclusions.
- Financial output that keeps gross amount, paralegal platform fee, estimated/finalized net, LPC release, payout record, and external bank receipt separate.
- A single-CTA paralegal navigation allowlist. Tool output cannot request both an inline link and a duplicate button.
- Initial paralegal conversation-plan, tool-trace, evidence-normalization, safe-rendering, and semantic-validator contracts for Packages 3–4.

## Privacy and authorization

- Tool execution rejects missing identity, attorneys, and admins before database lookup.
- Matter resolution includes the authenticated paralegal relationship directly in the database query.
- Unrelated matter lookups return unauthorized without confirming record details.
- Other applicants, other invitees, attorney billing/payment methods, raw Stripe identifiers, transfer IDs, storage keys, internal notes, and admin/risk fields are not projected.
- Withdrawn access is separately labeled and read-only.
- The tool set is read-only; it cannot apply, accept, decline, message, upload, complete, withdraw, change profile data, or alter payout settings.

## Verification

- Package 2 focused contract gate: 6/6 suites, 39/39 tests.
- Existing paralegal case-flow route regression: 16/16 tests.
- Attorney assistant non-regression gate: 15/15 suites, 210/210 tests.
- Attorney-only rollout assertion remains passing; paralegal and admin still use the existing fallback.
- Syntax checks pass for all new paralegal AI modules, the workflow policy, and the three integrated route files.
- No live-model test was required or run in Package 2; that remains Package 7.

## Deliberately deferred

- Manager wiring and durable conversation memory: Package 3.
- Full generation/repair/fallback/UI integration: Package 4.
- Generated regression corpus: Package 5.
- Synthetic database and browser integration: Package 6.
- Sanitized live-model evaluation: Package 7.
- Reliability telemetry and operations: Package 8.
- Paralegal-only rollout controls and enablement: Package 9.
