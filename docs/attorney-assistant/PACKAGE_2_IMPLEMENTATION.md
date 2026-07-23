# Attorney Assistant Package 2 Implementation

Date completed: July 22, 2026

Scope: executable attorney workflow policy, authoritative read-only tools, evidence contracts, and route/tool parity. This package does not enable legal drafting, legal advice, record-changing assistant actions, or new paralegal/admin assistant capabilities.

## Outcome

Package 2 replaces prompt-memory workflow answers with shared code and authenticated evidence. Enforcing routes and the attorney assistant now consume the same policy evaluators for posting, applications, invitations, pre-engagement, hiring and funding, workspace access, messaging, completion, withdrawal/relisting, termination, and archive readiness. Platform percentages, the $400 minimum, charge timing, and six-month archive retention are centralized.

The attorney capability manifest now contains all 32 audited question families. Implemented families name their authorized tools. Unresolved product-policy families are marked `policy_blocked` and return a bounded limitation instead of inventing an answer.

## Shared Executable Policy

The policy source is `backend/services/attorneyWorkflowPolicy.js`. Route enforcement consumes it in:

| Workflow | Enforcing source | Shared evaluator or value |
| --- | --- | --- |
| Matter posting | `routes/cases.js`, `routes/jobs.js` | `evaluateMatterPosting`, `MIN_MATTER_AMOUNT_CENTS` |
| Applications | `routes/applications.js` | `evaluateApplicationEligibility` |
| Invitations | `routes/cases.js` | `evaluateInvitationEligibility` |
| Pre-engagement | `routes/cases.js` | `evaluatePreEngagementRequest` |
| Hiring and funding prerequisites | `routes/cases.js`, `routes/payments.js` | `evaluateHiringEligibility`, charge-timing policy |
| Workspace access | support context and readiness tools | `evaluateWorkspaceAccess` |
| Matter messaging | `routes/messages.js` | `evaluateMessagingPermission` |
| Completion and release prerequisites | `routes/cases.js` | `evaluateCompletionEligibility` |
| Withdrawal and relisting | `routes/cases.js` | `evaluateWithdrawalAndRelist` |
| Termination/dispute initiation | `routes/cases.js` | `evaluateTerminationEligibility` |
| Archive download and retention | `routes/cases.js` | `evaluateArchiveReadiness`, `calculateArchivePurgeAt` |

`backend/services/platformFeePolicy.js` is the single current percentage/charge-timing source used by the case model and case/payment routes. Historical cases retain their stored fee snapshots.

## Authoritative Tool Contract

`backend/ai/supportAgentTools.js` now enforces these invariants:

- Authenticated user identity and role come from server context; the model cannot supply a different account identity.
- Attorney-only tools are absent from paralegal and admin allowlists.
- Matter lookups require ownership before fields are projected.
- Runtime argument validation rejects missing, extra, incorrectly typed, and invalid enum values.
- Every result carries an evidence state plus source and observation time.
- Verified absence, unknown state, processor unavailability, unauthorized access, and not-applicable state remain distinct.
- Tool exceptions become structured, retryable failures without raw stack traces or secrets.
- Dates, currency amounts, statuses, and identifiers are normalized.
- Application evidence merges owned embedded applicants and owned Job/Application records with de-duplication.
- Unread-message evidence follows the canonical `messageLastViewedAt`/receipt semantics.
- Aggregate results expose matching, returned, and truncation/completeness metadata; arbitrary result caps were removed where a complete answer is promised.
- Payment-method lookup failure is never reported as “no payment method.”
- Matter financials distinguish attorney charge, attorney fee, paralegal gross, paralegal fee/net, and withdrawal payout source.
- Incomplete embedded scope tasks are not attributed to a paralegal because those records have no assignee.

New attorney tools include matter readiness, complete billing summary, and account-deactivation eligibility. The capability contract verifies that every non-boundary family has an authorized tool and that required authoritative tools are present.

## Package 1 Findings Resolved

| Finding | Resolution |
| --- | --- |
| WP-01 inconsistent matter minimum | Cases and Jobs use the shared $400 minimum. |
| WP-02 ambiguous charge timing | Policy, tool output, prompt copy, and FAQ state that the card is charged when hire is confirmed and the charge must succeed. |
| WP-03 knowledge timing conflict | Approved knowledge copy was aligned to actual hire-time charging. |
| WP-08 split application stores | Attorney application activity merges and de-duplicates both authoritative stores. |
| WP-09 unread-count mismatch | Tool logic now follows canonical last-viewed/read-receipt semantics. |
| WP-10 false paralegal task attribution | Unassigned embedded tasks are excluded from “waiting on a paralegal.” |
| WP-11 archive metadata overclaim | Readiness reports storage as unverified until checked; the download route performs the live object check. |
| WP-12 duplicated fee constants | Current percentages and timing are centralized; historical snapshots remain authoritative. |

## Explicit Remaining Policy Blocks

These are visible capability limitations, not hidden “implemented” claims. They move into later packages or require product/legal decisions:

- Approve the legal/product term for funds held through the payment workflow; the assistant must not independently label it escrow.
- Choose one authoritative attorney profile-completion definition.
- Define how standalone `Task` records relate to embedded `Case.tasks`.
- Complete the file-store migration/authority contract and add live object readiness where promised.
- Define the complete account-wide attention and overdue-deadline taxonomy.
- Classify which case notes, if any, are attorney-visible to the assistant; internal/admin notes remain excluded.
- Add live storage verification to the general archive/receipt tools where exact readiness is requested. The archive download route itself already verifies storage.

## Verification Evidence

- Policy, capability, tool-contract, and manager tests: 4 suites, 46 tests passed.
- Attorney support API regression suite: 1 suite, 123 tests passed.
- Payments/hiring, lifecycle, messaging, case-notification, and deactivation regressions: 5 suites, 41 tests passed.
- Total recorded Package 2 automated coverage: 10 suites, 210 tests passed.
- Syntax checks passed for all changed Package 2 JavaScript sources, `git diff --check` passed, and the Package 2 checklist contains no unchecked item.
- The retention regression test caught and permanently covers UTC-safe six-month calculation across daylight-saving changes.

Package 3 has not begun. It will use these evidence and policy contracts to improve manager reasoning, clarification, multi-turn continuity, and response composition without weakening the Package 2 boundaries.
