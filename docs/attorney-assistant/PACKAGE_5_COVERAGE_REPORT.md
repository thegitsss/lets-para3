# Attorney Assistant Package 5 Coverage Report

Corpus version: `2026-07-22.package5.v1`

Generated: July 22, 2026

Scope: attorney assistant only. Paralegal and admin evaluation/runtime behavior remains frozen.

## Gate Summary

| Measure | Result |
| --- | ---: |
| Audited capabilities | 32 |
| Implemented/ready capabilities | 23 |
| Policy-blocked capabilities (still explicitly evaluated) | 8 |
| Boundary capabilities | 1 |
| Generated evaluation cases | 561 |
| Multi-turn cases | 81 |
| Failure/adversarial cases | 90 |
| Permanent production-defect regressions | 9 |
| Deterministic routing results | 561/561 passed |
| Deterministic final-answer oracle results | 561/561 passed |
| Critical results | 561/561 passed (100%) |
| Missing attorney tools | 0 |
| Corpus validation errors | 0 |

The deterministic result verifies corpus construction, exact evidence routing, and the structured final-answer oracle. It does not claim that 561 live model calls have passed. Package 6 database-backed integration and Package 7 sanitized repeated live-model scoring are complete.

## Dimension Definitions

Every capability includes three canonical prompts, three natural paraphrases, a typo, shorthand, and a short/incomplete prompt. Every non-boundary capability also includes negative-question and compound variants.

Every capability includes normal, relevant empty/not-applicable, and exceptional/conflicting states. Authorization-sensitive capabilities include an inaccessible-record state. External payment-processor, object-storage, and knowledge-registry dependencies each include success, absence, timeout, and failure.

Every entity-bearing capability includes vague-reference, pronoun follow-up, correction, and subject-change turns. The A15 financial regression also includes its prior “Both” dimension follow-up.

Every case asserts exact required tools, forbidden/unrelated tools, required claims, forbidden claims, evidence state, clarification range, allowed navigation, allowed buttons, maximum action count, suggestion relevance/uniqueness, direct-answer placement, concision, final-answer presence, authorization protection, and critical risk labels.

## Per-Capability Coverage

`L` is the number of distinct language/conversation prompt classes, `S` the number of state classes, `M` the number of multi-turn classes, and `F` the number of failure classes. Full class names are emitted by `npm run test:eval:attorney-support-coverage`.

| Capability | Status | Cases | L | S | M | F |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A01 matter overview | implemented | 15 | 8 | 4 | 0 | 2 |
| A02 matter details | implemented | 18 | 11 | 4 | 4 | 2 |
| A03 deadlines | policy blocked | 19 | 12 | 4 | 4 | 2 |
| A04 scope tasks | implemented | 18 | 11 | 4 | 4 | 2 |
| A05 task records | policy blocked | 18 | 11 | 4 | 4 | 2 |
| A06 files | policy blocked | 22 | 11 | 7 | 4 | 6 |
| A07 applications | implemented | 18 | 11 | 4 | 4 | 2 |
| A08 invitations | implemented | 18 | 11 | 4 | 4 | 2 |
| A09 pre-engagement | implemented | 18 | 11 | 4 | 4 | 2 |
| A10 hiring | implemented | 24 | 12 | 7 | 4 | 6 |
| A11 posting | implemented | 15 | 8 | 4 | 0 | 2 |
| A12 funding | implemented | 22 | 11 | 7 | 4 | 6 |
| A13 payment method | implemented | 18 | 7 | 7 | 0 | 6 |
| A14 billing summary | implemented | 14 | 7 | 4 | 0 | 2 |
| A15 case financials | implemented | 19 | 12 | 4 | 5 | 2 |
| A16 receipts | policy blocked | 22 | 11 | 7 | 4 | 6 |
| A17 messages | implemented | 18 | 11 | 4 | 4 | 2 |
| A18 pending paralegal | implemented | 19 | 12 | 4 | 4 | 2 |
| A19 attention | policy blocked | 14 | 7 | 4 | 0 | 2 |
| A20 profile | policy blocked | 14 | 7 | 4 | 0 | 2 |
| A21 preferences | implemented | 14 | 7 | 4 | 0 | 2 |
| A22 security | implemented | 14 | 7 | 4 | 0 | 2 |
| A23 deactivation | implemented | 14 | 7 | 4 | 0 | 2 |
| A24 disputes/termination | implemented | 18 | 11 | 4 | 4 | 2 |
| A25 withdrawal/relist | implemented | 18 | 11 | 4 | 4 | 2 |
| A26 completion | implemented | 18 | 11 | 4 | 4 | 2 |
| A27 archive | policy blocked | 22 | 11 | 7 | 4 | 6 |
| A28 moderation | implemented | 18 | 11 | 4 | 4 | 2 |
| A29 notes/meetings | policy blocked | 18 | 11 | 4 | 4 | 2 |
| A30 navigation | implemented | 14 | 7 | 4 | 0 | 2 |
| A31 product knowledge | implemented | 19 | 8 | 6 | 0 | 5 |
| A32 boundary | boundary | 11 | 5 | 3 | 0 | 1 |

No capability has only a single-turn happy path: even non-entity families include multiple language forms, empty/not-applicable state, exceptional/conflicting evidence, and authorization or boundary failures where applicable.

## Permanent Production Regressions

The production-defect registry is automatically converted into permanent corpus cases:

1. `PD001_platform_fee_unavailable_noise`
2. `PD002_deadline_phantom_escalation`
3. `PD003_pending_paralegal_generic_fallback`
4. `PD004_completed_count_reported_unavailable`
5. `PD005_both_financial_dimensions_missing`
6. `PD006_payment_method_requirement_contradiction`
7. `PD007_general_paralegal_payout_timing_false_limitation`
8. `PD008_post_hire_workflow_generic_fallback`
9. `PD009_general_hiring_raw_evidence_leak`

Adding a valid entry to `backend/ai/attorneySupportProductionDefects.js` automatically creates a named `regression.<defect-id>` case. Contract tests prove this registration behavior and reject malformed or unasserted corpus cases.

## Reproduction

Run from `backend/`:

```text
npm run test:eval:attorney-support-coverage
npm test -- --runInBand attorneySupportEvalCorpus.test.js
```

The coverage command emits per-capability language, state, multi-turn, failure, assertion, and critical-case coverage as machine-readable JSON and exits nonzero for any missing tool, corpus error, routing failure, answer-oracle failure, or critical failure.
