# Final Attorney Assistant Capability Contract

Effective: July 22, 2026

Canonical executable source: `backend/ai/attorneySupportCapabilities.js`

The attorney assistant is read-only. It answers LPC product and authenticated account/matter questions from executable workflow policy, authorized live data, approved knowledge, or a truthful limitation. It does not provide legal advice, draft legal documents or legal work product, or perform platform mutations.

## Final Status Summary

| Status | Count | Meaning |
| --- | ---: | --- |
| Implemented | 23 | Authorized tools/policy and response contracts exist; material states have deterministic coverage |
| Policy-blocked/limited | 8 | A safe partial answer or explicit limitation is implemented; the unresolved substate is not guessed |
| Boundary | 1 | Request is declined briefly; separable read-only LPC help may still be answered |

All 32 families remain in routing, state, failure, adversarial, multi-turn, database, and response validation coverage. `policy_blocked` does not mean the assistant is free to improvise; it is an implemented safe limitation.

## Capability Catalog

| ID | Runtime status | Final behavior or limitation |
| --- | --- | --- |
| A01 Matter overview | Implemented | Complete owned matter counts and lifecycle totals |
| A02 Matter details | Implemented | Owned named-matter status and participants with ambiguity handling |
| A03 Deadlines | Policy-blocked | Verified next deadline is supported; merged overdue/task authority remains unresolved |
| A04 Scope tasks | Implemented | Embedded scope-task state and completion blockers from shared policy |
| A05 Standalone tasks | Policy-blocked | Standalone and embedded task systems are not merged without an approved authority contract |
| A06 Files/deliverables | Policy-blocked | Authorized metadata/review state is supported; object retrieval readiness is not inferred |
| A07 Applications | Implemented | Owned application stores are merged and deduplicated |
| A08 Invitations | Implemented | Invitation state and shared readiness blockers |
| A09 Pre-engagement | Implemented | Selected requirements, state, and next actor from owned matter data/policy |
| A10 Hiring | Implemented | Shared-policy eligibility and all represented blockers |
| A11 Posting | Implemented | Draft/publish requirements and payment prerequisite from executable policy |
| A12 Funding | Implemented | Funding timing, state, and failures without conflating absence and outage |
| A13 Payment method | Implemented | Saved/absent/unavailable processor state without credential exposure |
| A14 Billing summary | Implemented | Complete authorized billing aggregates and history readiness |
| A15 Matter financials | Implemented | Matter amount, attorney fee/charge, paralegal gross/fee/net, and finalized source kept distinct |
| A16 Receipts | Policy-blocked | Receipt index is supported; object generation/retrieval readiness is not inferred |
| A17 Messages | Implemented | Canonical unread/reply and owned messaging permission state |
| A18 Pending paralegal | Implemented | Only explicitly attributable invitations, pre-engagement, or messages; unassigned tasks excluded |
| A19 Attention summary | Policy-blocked | Available signals are safe; a complete cross-product priority taxonomy is not claimed |
| A20 Profile/onboarding | Policy-blocked | Distinct represented readiness definitions are returned without collapsing conflicting concepts |
| A21 Preferences | Implemented | Safe preference and notification fields with represented defaults |
| A22 Security | Implemented | Global 2FA availability and safe user configuration markers; no recovery secrets |
| A23 Deactivation | Implemented | Read-only eligibility from the same service that governs deactivation |
| A24 Disputes/termination | Implemented | Owned state and represented next-step data; internal/admin notes excluded |
| A25 Withdrawal/relist | Implemented | Review, payout finalization, remaining value, and relist readiness from shared policy/snapshots |
| A26 Completion | Implemented | Completion, release, and blockers kept distinct |
| A27 Archive | Policy-blocked | Retention/purge and database readiness supported; live storage readiness is not inferred |
| A28 Moderation | Implemented | Attorney-visible flag/remediation state only |
| A29 Notes/meetings | Policy-blocked | Approved meeting-link state only; internal/admin notes remain forbidden |
| A30 Navigation | Implemented | One role-safe allowlisted destination when materially relevant |
| A31 Product knowledge | Implemented | Approved explanation subordinate to executable policy and live data |
| A32 Legal/drafting/mutation | Boundary | Brief refusal; no legal advice, work product, mutation, or false escalation |

## Evidence and Presentation Invariants

- Authenticated role and identity are server-derived; matter ownership is rechecked on every retrieval.
- Conversation memory resolves references but never proves a fact.
- Required evidence-plan tools are the only tools offered during deterministic factual/workflow turns; unrelated knowledge/navigation cannot substitute.
- Unsupported money, date, name, status, workflow, authorization, availability, mutation, and legal claims are rejected before display.
- A failed correction produces a concise safe fallback with no guessed legacy answer, unrelated action, suggestion, or review card.
- General telemetry contains allowlisted operational summaries only, not raw questions, answers, tool inputs/results, or customer identity.

## Release Boundary

The deterministic implementation is the attorney reference architecture. Package 7's approved live-model gate passed on July 22, 2026. Production acceptance is not complete until Package 9's fresh staged observation meets its thresholds. Paralegal and admin cannot be enabled by changing the manager-role environment value; the runtime role allowlist remains hardcoded to attorneys.
