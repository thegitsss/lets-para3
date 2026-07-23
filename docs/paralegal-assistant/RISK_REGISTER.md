# Paralegal Assistant Risk Register

Audit date: July 23, 2026

| ID | Severity | Risk | Required control |
| --- | --- | --- | --- |
| PR01 | P0 | A paralegal reads an unrelated matter or another paralegal’s record | Relationship enforced in every database query; adversarial cross-user tests |
| PR02 | P0 | Assistant exposes attorney billing/payment credentials | Paralegal-specific projections and denied-field tests |
| PR03 | P0 | Release is stated as bank receipt | Separate lifecycle states and evidence validator |
| PR04 | P0 | Pending/estimated payout is stated as final | Finalized-source precedence and amount validator |
| PR05 | P0 | Assistant performs or claims a mutation | Read-only tools, boundary response, no false handoff/action claims |
| PR06 | P0 | Legal advice or unsupervised work product is generated | P32 boundary plus adversarial evaluation |
| PR07 | P1 | Application status is wrong because dual stores drift | Reconciliation service with precedence and provenance |
| PR08 | P1 | Invitation status is wrong because legacy pending fields disagree | Canonical invitation evaluator |
| PR09 | P1 | Pre-engagement next actor or requirement is misstated | Shared readiness service and state tests |
| PR10 | P1 | Assistant says user is hired before final assignment/funding gates | Separate accepted, selected, hired, funded, and active states |
| PR11 | P1 | Withdrawn paralegal receives active workspace data | Access evaluator with revocation/retained-history rules |
| PR12 | P1 | Other applicants or sensitive disclosures are exposed | Field-level projections and applicant isolation tests |
| PR13 | P1 | Payout setup absence is confused with Stripe outage | Explicit absent/unavailable/live/stored evidence |
| PR14 | P1 | Historical fee is recalculated from current policy | Historical snapshot precedence and provenance labels |
| PR15 | P1 | Wrong matter is selected from vague context | Authorized entity resolver and one clarification on real ambiguity |
| PR16 | P1 | Repeated follow-up triggers redundant tool calls or loses context | Durable verified entities plus evidence freshness/reuse rules |
| PR17 | P1 | Raw evidence/internal field names leak to UI | Semantic answer validator and safe fallback |
| PR18 | P1 | Legacy regex routing overrides the user’s real intent | Structural capability selection and paraphrase corpus |
| PR19 | P2 | Profile completeness or visibility is overstated | One approved definition per conclusion |
| PR20 | P2 | Unread/awaiting-reply count is inaccurate | Canonical message/viewed-state service |
| PR21 | P2 | File availability is inferred from metadata alone | Storage existence evidence or explicit limitation |
| PR22 | P2 | Duplicate or irrelevant links/actions clutter answers | One-action response UI contract and browser test |
| PR23 | P2 | Thumbs-down feedback is collected but not operationalized | Role-specific reliability aggregation and review cadence |
| PR24 | P2 | Paralegal metrics contaminate attorney rollout metrics | Separate telemetry contract, thresholds, and stage gates |

No P0/P1 item may be waived by prompt wording.
