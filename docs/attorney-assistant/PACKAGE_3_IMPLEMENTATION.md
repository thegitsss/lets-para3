# Attorney Assistant Package 3 Implementation

Date completed: July 22, 2026

Scope: attorney-only evidence planning, multi-tool reasoning controls, verified conversation memory, entity correction, clarification behavior, and answer-contract validation. Paralegal and admin manager behavior remains disabled.

## Outcome

Package 3 makes the attorney manager reason against an explicit evidence plan instead of treating any successful tool as adequate grounding. Each supported question is decomposed into the authoritative evidence it requires. The final-answer validator rejects missing, unrelated, or repeated evidence; unsafe state conversions; unlabeled financial dimensions; generic review/escalation language; internal tool references; and unnecessarily long routine facts.

The conversation now maintains a bounded list of verified matter entities. The active matter can change without deleting earlier verified references, every reuse is ownership-checked again, and an account-wide topic clears stale active-matter context. A correction such as “the other case” selects the sole verified alternative or asks one focused clarification when more than one alternative remains.

## Evidence Planning and Orchestration

`backend/ai/attorneyConversationPolicy.js` defines deterministic evidence requirements for:

- matter financials;
- account-wide receipts and billing summaries;
- complete matter-workspace questions;
- matter-specific executable readiness;
- general posting/application/hiring/funding prerequisites;
- saved payment-method state;
- matter totals, named matter state, deadlines, applications, messages, pending paralegal activity, attention, account/profile state, deactivation, knowledge, and navigation.

Compound questions produce multiple requirements. For example, “Do I have a saved payment method, and do I need one before posting?” requires both the live billing-method tool and executable workflow policy. A general product explanation cannot substitute for either.

`backend/ai/supportManagerAgent.js` now:

- gives the model the explicit evidence hierarchy and current evidence plan;
- requires the relevant successful tool, not merely any successful tool;
- permits a truthful limitation after the relevant dependency was attempted;
- rejects repeated successful calls and unrelated evidence;
- supports parallel tools for compound questions;
- retries an invalid answer using existing evidence before requesting more;
- keeps general knowledge subordinate to executable policy, live scoped data, and historical matter snapshots;
- remains hard-locked to attorneys even if an environment variable lists paralegal or admin.

## Conversation Understanding

Verified entities are persisted through `SupportConversation.metadata.support.verifiedEntities`, with the current entity stored separately. The state passed to the manager includes the active entity, up to six verified entities, recent capabilities, and requested dimensions.

Resolution behavior now follows these rules:

- Pronouns and short follow-ups reuse verified active context.
- “Both” preserves an unresolved financial dimension and requires both labeled values.
- A newly named owned matter is resolved before old active memory.
- A general account-wide subject change clears the active matter but retains verified history.
- “The other case” uses a unique verified alternative; multiple alternatives require clarification.
- Similarly named owned matters return safe candidate titles instead of silently choosing the most recently updated matter.
- The authoritative manager never infers a recent matter when a reference fails.
- Conversation history is not concatenated into a database entity query, preventing old matter names from contaminating a new lookup.
- Common payment, receipt, message, application, paralegal, completion, and “before” typos/shorthand are normalized for evidence planning.

Every audited entity-bearing capability now generates pronoun, subject-change, and correction routing cases.

## Answer Contract Enforcement

The manager validator enforces:

- direct answer before background;
- normally one or two sentences for a concise simple fact;
- expanded detail only when the response declares an expanded workflow/conflict mode;
- separate statements for current account state and platform requirements;
- explicit matter amount, attorney platform fee, total attorney charge, paralegal platform fee, and net payout labels when requested;
- complete “both” answers using the verified attorney charge and paralegal net payout;
- `absent`, `unknown`, and `temporarily_unavailable` as different outcomes;
- no generic manual-review panel language or phantom team escalation;
- at most one relevant next step for a limitation;
- no raw tool name, system prompt, schema, or raw output references;
- navigation only when the authorized navigation tool returned the exact destination.

## Verification

- Conversation policy, entity resolver, capability coverage, manager orchestration, tool-contract, and complete support API suites: 6 suites and 186 tests passed.
- The support API coverage includes persisted manager entity memory and an account-wide subject change.
- Frozen paralegal/admin behavior remains on the prior assistant path; the support regression suite exercises both roles.
- All 12 changed Package 3 JavaScript/test files passed syntax checks.
- `git diff --check` passed, and the Package 3 checklist contains zero unchecked items.

## Remaining Work

Package 3 validates deterministic reasoning contracts and mocked manager orchestration. Package 4 must evaluate semantic answer completeness against the larger generated corpus and validate the rendered response UI. Live-model and production reliability thresholds remain later-package work. Package 2 policy-blocked product decisions remain explicitly blocked and are not converted into improvised answers.

At Package 3 completion, Packages 4, 5, and 6 were complete and Package 7 had not begun. Package 7 subsequently passed on July 22, 2026; see `PACKAGE_7_RELEASE_THRESHOLDS.md`.
