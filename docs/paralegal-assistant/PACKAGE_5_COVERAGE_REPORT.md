# Paralegal Assistant Package 5 Coverage Report

Corpus: `2026-07-23.package5.v1`

Date: July 23, 2026

## Totals

| Measure | Result |
| --- | ---: |
| Capability families | 32/32 |
| Implemented families | 25 |
| Policy-blocked families | 6 |
| Boundary families | 1 |
| Generated cases | 551 |
| Critical cases | 551 |
| Multi-turn/compound cases | 131 |
| Failure/adversarial cases | 160 |
| Permanent regressions | 7 |
| Deterministic planner/reuse checks | 423/423 |
| Deferred semantic/clarification checks | 128 |
| Deterministic answer-oracle fixtures | 551/551 |
| Critical failures | 0 |

The 128 deferred cases are retained in the corpus and are not counted as live-model passes. They consist of semantic follow-ups, alternate natural capability wording, and clarification-only turns assigned to Package 7.

## Per-family case coverage

| Family | Status | Cases | Primary evidence/tool |
| --- | --- | ---: | --- |
| P01 Assigned overview | Implemented | 17 | case overview |
| P02 Matter details | Implemented | 18 | workspace |
| P03 Deadlines | Policy blocked | 17 | workspace |
| P04 Scope/tasks | Implemented | 17 | workspace |
| P05 Files/deliverables | Policy blocked | 17 | workspace |
| P06 Applications | Implemented | 17 | application activity |
| P07 Browse/apply | Implemented | 18 | workflow readiness |
| P08 Invitations | Implemented | 17 | invitation activity |
| P09 Pre-engagement | Implemented | 17 | invitations + workflow |
| P10 Assignment/start | Implemented | 18 | workflow readiness |
| P11 Workspace access | Implemented | 17 | workspace |
| P12 Messaging permission | Implemented | 17 | messaging state |
| P13 Message activity | Implemented | 17 | messaging state |
| P14 Payout setup | Implemented | 17 | payout setup |
| P15 Payout timing | Implemented | 19 | workflow readiness |
| P16 Payout history | Implemented | 17 | payout history |
| P17 Matter financials | Implemented | 18 | matter financials |
| P18 Platform fee | Implemented | 17 | approved knowledge |
| P19 Withdrawal eligibility | Implemented | 17 | workflow + workspace |
| P20 Withdrawal outcome | Implemented | 17 | workspace + financials |
| P21 Completion/release | Implemented | 17 | workflow + workspace |
| P22 Disputes/moderation | Policy blocked | 17 | workspace |
| P23 Profile | Policy blocked | 17 | account snapshot |
| P24 Availability/visibility | Implemented | 17 | account snapshot |
| P25 Profile documents | Policy blocked | 17 | account snapshot |
| P26 Preferences | Implemented | 17 | account snapshot |
| P27 Security | Implemented | 17 | account snapshot |
| P28 Deactivation | Implemented | 17 | deactivation eligibility |
| P29 Archive/history | Policy blocked | 17 | workspace |
| P30 Navigation | Implemented | 18 | verified navigation |
| P31 Product knowledge | Implemented | 17 | approved knowledge |
| P32 Boundary | Boundary | 17 | no tools |

Every family contains positive, absent, unavailable, unauthorized, ambiguous, adversarial, paraphrase, typo, follow-up, compound, and repeated-question coverage. Every case has routing, evidence, answer, privacy, and UI assertions.
