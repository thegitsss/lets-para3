# Paralegal Assistant Package 7 Implementation

Date completed: July 23, 2026

Scope: repeated sanitized external-model capability selection and complete response-pipeline evaluation. The paralegal manager remains disabled; the attorney assistant was not changed.

## What Package 7 added

- A synthetic-only live-evaluation contract with secret, identity, credential, connection-string, and payload preflights.
- Structural tool narrowing from the production paralegal evidence plan, with no prompt-specific question branch.
- Trusted synthetic active-matter context for any positive evaluation whose planned tool requires a matter reference.
- An 86-case routing set covering P01–P32, paraphrases, multi-turn follow-ups, compound questions, and unavailable evidence.
- A 17-scenario MongoMemoryServer pipeline set covering planning, authorized tools, evidence, external answer generation, semantic validation, bounded regeneration, UI filtering, and fallback.
- Package scripts for dry-run and live routing/full-pipeline execution.
- Regression coverage for the live-evaluation contract and bank-receipt negation.

## Structural corrections found by live evaluation

1. The first routing pilot exposed that all fourteen tools were offered without the production evidence plan. The evaluator was replaced with the same structural capability selection pattern used by the reference architecture: build the production evidence plan, offer only planned tools, and grade semantic follow-ups against that plan.
2. Positive matter-scoped fixtures could say “this matter” without supplying an identified synthetic matter. The harness now adds one trusted synthetic active matter whenever a planned tool structurally requires `case_reference`.
3. The bank-receipt validator treated an explicit limitation such as “I can’t confirm it reached your bank” as a positive receipt claim. It now evaluates the full sentence and permits explicit uncertainty while continuing to reject affirmative receipt claims without evidence.
4. Several first-pass failures were false-negative graders: a safe access limitation used “can’t access”; the valid task could come from either embedded scope or the standalone task collection; and bank-claim matching ignored negation. The graders were corrected to evaluate the semantic contract rather than one literal wording.

No exact-question, keyword-only, or regex routing branch was added.

## Retained failure history

### Routing

| Attempt | Result | Retained failure | Response ID(s) | Classification | Disposition |
| --- | ---: | --- | --- | --- | --- |
| Initial pilot | 23/32 | Nine capabilities omitted or substituted tools because the evaluator offered the full tool catalog without the production evidence plan | `resp_01d299d251629b4a016a625756b520819eb8e6825ac93f36ef`, `resp_0223425dcaefd07a016a625756d75c819d804f8933e5af68bf`, `resp_0cf665192dba634b016a625757c07881a0acd0ef67ed7e3151`, `resp_0d2caa790ef6a9e7016a625759db4c81a18a8f3d31cb881f29`, `resp_0a989894c79ad5f9016a62575ab9c881a3a7db23a649d8b8ff`, `resp_08bb48cc2f214305016a62575c94d881a2be82c3c044bd724e`, `resp_0d40121725c9a064016a62575d2ca481a0b6d56c29d7960efc`, `resp_0af0df3fd7b01a9a016a62575d3cb0819db2f335701daa6d15`, `resp_0394f8acdd0359c8016a625762427081a1af8462a8d1b29d0a` | Evaluator architecture/policy conflict | Added production structural evidence planning and tool narrowing |
| Corrected pilot | 31/32 | `P07_browse_apply.positive.1` had no active matter for a required matter-scoped tool | `resp_0b646069fd36a1b1016a6257f183c48192a175e268e7cdf343` | Synthetic fixture | Added a schema-driven trusted synthetic matter context |
| First repeated run | 170/172 | `P08_invitations.follow_up` correctly used invitation plus workflow evidence, but the deferred semantic oracle expected invitation only | `resp_02537307c48a5093016a6258786ee08191bba327121a8b4aec`, `resp_0886a37e9ca46fbc016a625879a1fc819f8067039980dfd428` | Semantic evaluation contract | Grade semantic follow-ups against the production evidence plan |
| Final repeated run | 172/172 | None | — | Passed | All thresholds satisfied |

### Full response pipeline

| Attempt | Result | Retained failure | Response ID(s) | Classification | Disposition |
| --- | ---: | --- | --- | --- | --- |
| Initial pilot | 13/17 | Bank negation exhausted validation; access limitation, record-injection answer, and unavailable answer failed literal graders despite safe answers | `resp_05292939e542ad19016a6259587614819fabe2094dcdb83c42`, `resp_08a393af43127238016a62595a44b081a38ee80f9258bc184b`, `resp_027ab95b22998ebe016a62595ba65c819e8f17fab0c9d657d7`, `resp_0b0ae918385b4a59016a6259619414819f9d5b4de3e374f823`, `resp_030d6fcee604c408016a6259632e3c819fb98c5df93ffa965c`, `resp_0293c89ba8f70eff016a625966297481a2bf229aee6eafcb5f` | Validator plus evaluation-contract defects | Added sentence-aware bank negation and corrected semantic graders |
| Bank target rerun | 0/1 | Correct answer “not been confirmed as received” was outside the literal expected phrase | `resp_0ef5253f6eea59d8016a6259dc802c81a286bde17c68e4f2d8`, `resp_037ee789f9f04ea5016a6259de426c8192b154a58c1f23ab3e` | Evaluation-contract defect | Accepted equivalent explicit receipt limitations |
| First all-scenario rerun | 15/17 | Valid standalone task was not in the literal task grader; negative bank sentence matched a positive forbidden phrase | `resp_0a271618bc37d067016a6259fd2c2c81a3aef474cd13d1aadd`, `resp_0d5dfa4b4817cafa016a625a0729608191b1c14073ad3b6157` | Evaluation-contract defect | Covered both authoritative task stores; delegated bank safety to the semantic validator |
| Clean pilot | 17/17 | None | — | Passed | Full pilot clean |
| Final repeated run | 34/34 | None | — | Passed | All thresholds satisfied |

No failure was waived, deleted from its original denominator, or converted into a prompt-specific routing rule.

## Verification

- Sanitized routing preflight: 172/172 requests accepted, synthetic only, `store: false`.
- Final external routing: 172/172 passed.
- Sanitized full-pipeline preflight: 36 external requests across 34 runs accepted, synthetic only, `store: false`.
- Final external full pipeline: 34/34 passed.
- Full paralegal Package 2–7 regression: 12/12 suites and 105/105 tests passed.
- Generated corpus: 423/423 deterministic planner/reuse checks and 551/551 answer oracles passed.
- Paralegal support drawer: 2/2 Playwright scenarios passed.
- Attorney non-regression: 15/15 suites and 210/210 current tests passed.
- External payment-processor calls: zero.
- Production database reads: zero.
- Critical failures in final runs: zero.
- Paralegal manager enabled: no.
- Deployment performed: no.

Package 8 owns privacy-safe reliability telemetry, alerting, runbooks, and rollback operations. Package 9 owns gated enablement and product-owner acceptance.
