# Paralegal Assistant Package 4 Implementation

Status: complete

Date: July 23, 2026

## Outcome

Package 4 added a paralegal-specific response pipeline after planning and authorized tool selection. Generated answers are now semantically checked against the selected evidence, corrected within a bounded loop, filtered to the paralegal UI contract, and replaced with a deterministic safe fallback if correction is exhausted.

The paralegal manager remains disabled. The pipeline is executable and tested in isolation but is not yet user-visible.

## Semantic validation

`backend/ai/paralegalResponseValidator.js` checks:

- money amounts and paralegal fee percentages;
- explicit dates, matter names, attorney names, and lifecycle statuses;
- payout release, bank receipt, payout setup, messaging, assignment, application, invitation, workspace authorization, and availability claims;
- unavailable and unauthorized evidence limitations;
- required sections for compound questions;
- raw evidence labels, internal fields, attorney billing leakage, false mutations, phantom handoffs, manual-review claims, and legal-boundary violations;
- answer length, clarification count, suggestions, navigation, and duplicate inline/button links.

Conversation history, user wording, and page context do not satisfy these checks. Only the selected authorized tool evidence does.

## Bounded correction and fallback

`backend/ai/paralegalResponsePipeline.js`:

1. passes the selected paralegal evidence contract to a generator;
2. validates and UI-filters the result;
3. returns the answer when valid;
4. supplies structural failure classes for at most two correction attempts;
5. renders a deterministic evidence-backed fallback when correction is exhausted;
6. validates that fallback and reduces it to a truthful no-data response if the rendered fallback is itself unsafe.

The fallback does not re-enter legacy role logic and never adds generic actions, suggestions, or a review card.

## Response UI contract

`backend/ai/paralegalResponseUiPolicy.js` enforces:

- zero or one verified navigation destination;
- no inline link when the same destination has a button;
- zero or one relevant suggestion;
- multiple suggestion choices only for an explicit, tested required clarification;
- removal of unsupported navigation and generic web links;
- no review card based on a bare availability flag;
- a review card only when an allowed escalation reason contains proof of an executed path and a real reference ID.

## Verification

- Package 2–4 paralegal gate: 9/9 suites and 73/73 tests.
- Package 4-focused response gate: 4/4 suites and 27/27 tests.
- Syntax checks pass for the validator, UI policy, pipeline, and evidence contract.
- The attorney assistant source remains unchanged.
- The attorney regression gate remains 15/15 suites and 210/210 tests.
- The manager role allowlist remains attorney-only.

## Deliberately deferred

- Generated regression corpus: Package 5.
- Synthetic database and browser integration: Package 6.
- Sanitized live-model evaluation: Package 7.
- Reliability telemetry and operations: Package 8.
- Paralegal-only rollout controls and enablement: Package 9.
