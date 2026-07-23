# Attorney Assistant Hardening Checklist

Created: July 22, 2026

Purpose: control the attorney-assistant hardening program from discovery through production acceptance. This is the authoritative completion checklist for the attorney assistant. Paralegal and admin assistants remain out of scope until this checklist reaches final sign-off.

## Checklist Rules

- `[ ]` means not verified.
- `[x]` means implemented and verified with recorded evidence.
- An item may be marked complete only when its implementation artifact and verification evidence are both recorded.
- Passing a nearby test does not complete an item unless that test exercises the stated behavior.
- A product decision, unavailable dependency, or policy restriction must be recorded as a blocker; it must not be silently treated as complete.
- Every defect discovered during this program must receive a permanent regression test before its checklist item can be closed.
- Critical financial, authorization, privacy, workflow-policy, and record-ownership checks require 100% pass rates.
- At final reconciliation, search this document for unchecked items. The attorney assistant cannot be declared complete while an unexplained unchecked item remains.

## Scope Guardrails

- [x] Attorney assistant is the only assistant being changed.
- [x] Paralegal assistant behavior is confirmed unchanged.
- [x] Admin assistant behavior is confirmed unchanged.
- [x] Assistant remains read-only.
- [x] Assistant cannot claim to approve, reject, hire, pay, refund, message, upload, edit, submit, or escalate unless a future explicitly authorized action system performs and verifies that action.
- [x] Legal advice remains out of scope.
- [x] Legal-document drafting and legal work product remain out of scope.
- [x] Conversation history is used for reference resolution only, never as authoritative platform evidence.
- [x] Sensitive payment, identity, and internal-record data are not exposed through tool output or assistant responses.

## Package 1 — Source-of-Truth and Response-Contract Inventory

### Attorney capability inventory

- [x] Account identity, role, approval, and profile questions are inventoried.
- [x] Account preferences, notifications, security, and settings questions are inventoried.
- [x] Saved payment method and billing-readiness questions are inventoried.
- [x] Matter-posting requirements and failure states are inventoried.
- [x] Application, applicant, invitation, and pre-engagement questions are inventoried.
- [x] Hiring and funding requirements and failure states are inventoried.
- [x] Matter counts, statuses, participants, and lifecycle questions are inventoried.
- [x] Tasks, files, deliverables, and review-state questions are inventoried.
- [x] Messages, unread state, response state, and messaging-permission questions are inventoried.
- [x] Deadlines and overdue-state questions are inventoried.
- [x] Matter amount, attorney fee, total charge, paralegal fee, payout, invoice, and receipt questions are inventoried.
- [x] Dispute, withdrawal, termination, payout-finalization, and relisting questions are inventoried.
- [x] Completion, release, archive, download, and purge questions are inventoried.
- [x] Navigation and technical-troubleshooting questions are inventoried.
- [x] Legal-advice, drafting, mutation, privacy, and permission boundaries are inventoried.

### Evidence mapping

- [x] Every question family identifies its authoritative backend route or enforcement point.
- [x] Every question family identifies its authoritative service or policy module.
- [x] Every account fact identifies its model and exact source fields.
- [x] Every matter fact identifies its model and exact source fields.
- [x] Every processor-derived fact identifies the processor API or verified stored snapshot used.
- [x] Every general explanation identifies the approved knowledge source.
- [x] Every capability identifies its authorized assistant tool or an explicit missing-tool gap.
- [x] Every tool identifies role, ownership, and record-access requirements.
- [x] Every capability identifies all meaningful empty, normal, exceptional, and unavailable states.
- [x] Every capability defines what constitutes verified, absent, unknown, temporarily unavailable, unauthorized, and not applicable.
- [x] Every capability defines the required answer, forbidden claims, clarification behavior, and navigation behavior.

### Contradiction and gap audit

- [x] Duplicate workflow rules across routes are identified.
- [x] Conflicting route behavior, UI copy, knowledge content, prompts, and tests are identified.
- [x] Rules enforced by code but absent from assistant evidence are identified.
- [x] Assistant facts that are not enforced or represented by product code are identified.
- [x] Missing fields, ambiguous fields, stale snapshots, and processor-only facts are identified.
- [x] Unsupported attorney questions are listed explicitly rather than hidden behind generic fallback language.
- [x] Each discovered gap has an owner, severity, recommended resolution, and verification requirement.

### Package 1 artifacts and exit gate

- [x] Attorney source-of-truth matrix is complete.
- [x] Attorney workflow-policy inventory is complete.
- [x] Attorney data-availability and permission matrix is complete.
- [x] Attorney response behavior contract is complete.
- [x] Contradiction and risk register is complete.
- [x] Evaluation specification is complete.
- [x] Every ready capability has an authoritative source, an authorized retrieval path, and a response contract.
- [x] Every non-ready capability is explicitly documented as blocked or deferred.
- [x] Package 1 evidence and open decisions are reviewed before Package 2 begins.

## Package 2 — Executable Policies and Authoritative Tools

### Shared executable policy

- [x] Posting eligibility rules use a shared policy consumed by both route enforcement and the assistant.
- [x] Application eligibility rules use a shared policy consumed by both route enforcement and the assistant.
- [x] Invitation and pre-engagement requirements use shared policy where applicable.
- [x] Hiring eligibility rules use a shared policy consumed by both route enforcement and the assistant.
- [x] Funding and payment-timing rules use a shared policy consumed by both route enforcement and the assistant.
- [x] Minimum matter requirements use shared policy where applicable.
- [x] Workspace-access rules use shared policy where applicable.
- [x] Messaging-permission rules use shared policy where applicable.
- [x] Completion and funds-release requirements use shared policy where applicable.
- [x] Withdrawal, dispute, termination, and relisting rules use shared policy where applicable.
- [x] Archive, download, retention, and purge rules use shared policy where applicable.
- [x] No executable workflow requirement relies solely on model memory, prompt text, UI copy, or knowledge retrieval.

### Tool contracts

- [x] Every attorney capability has the smallest sufficient authorized tool set.
- [x] Tool descriptions clearly state when the manager must use each tool.
- [x] Tool input schemas reject unsupported parameters.
- [x] Tools derive user identity and role from authenticated context, not model-supplied IDs.
- [x] Matter tools enforce attorney ownership before returning data.
- [x] Tools return explicit evidence-state values.
- [x] Tools distinguish missing records from failed lookups.
- [x] Tools include safe provenance and freshness information where material.
- [x] Tools return normalized dates, currencies, statuses, and identifiers.
- [x] Tool results omit secrets, full payment credentials, unnecessary personal information, and internal-only fields.
- [x] Aggregate tools do not silently omit relevant records because of arbitrary limits.
- [x] Processor failures remain distinguishable from a user having no configured payment method.
- [x] Tool failures are structured and safe for retry or truthful limitation handling.

### Package 2 verification and exit gate

- [x] Route-policy parity tests cover every shared executable rule.
- [x] Tool-schema tests cover valid and invalid arguments.
- [x] Role and ownership tests cover authorized and unauthorized records.
- [x] Evidence-state tests cover verified, absent, unknown, unavailable, unauthorized, and not-applicable results.
- [x] Processor success, missing-state, and failure-state tests pass.
- [x] Capability contract reports no missing or unauthorized attorney tools.
- [x] Package 2 evidence and remaining gaps are reviewed before Package 3 begins.

## Package 3 — Manager Reasoning and Conversation Behavior

### Evidence selection

- [x] Manager instructions define the evidence hierarchy: executable policy, live scoped data, approved knowledge, then truthful limitation.
- [x] Factual answers require successful authoritative tool evidence.
- [x] Workflow-prerequisite questions require the relevant executable-policy tool.
- [x] Matter-specific financial questions require matter financial evidence.
- [x] Account-wide receipt questions require receipt-history evidence.
- [x] Matter workspace questions require complete workspace evidence.
- [x] Manager can call multiple tools when a question spans multiple sources.
- [x] Manager stops calling tools once sufficient evidence exists.
- [x] General knowledge retrieval cannot override executable policy or live account data.

### Conversation understanding

- [x] Pronouns such as “it,” “that,” “this,” and “there” resolve from verified conversation context.
- [x] One-word follow-ups such as “both,” “yes,” “no,” and “why” preserve the correct active subject.
- [x] Previously named matters remain available through durable, verified entity memory.
- [x] A subject change replaces stale entity context when appropriate.
- [x] Corrections such as “I meant the other case” trigger safe re-resolution.
- [x] Compound questions are decomposed and answered completely.
- [x] Typos, shorthand, casing, punctuation, and informal language do not break capability selection.
- [x] Conflicting or ambiguous matter references produce one focused clarification.
- [x] The assistant never asks the user to repeat information already available in verified history.
- [x] Clarification is not used merely because the original phrasing differs from an eval prompt.

### Answer behavior

- [x] The direct answer appears first.
- [x] Simple factual answers are normally one or two sentences.
- [x] Detail expands only when necessary to explain a workflow, conflict, or next step.
- [x] The assistant distinguishes account state from platform requirements.
- [x] The assistant distinguishes matter amount, attorney fee, total charge, paralegal fee, and net payout.
- [x] The assistant distinguishes no data from temporarily unavailable data.
- [x] The assistant does not add generic manual-review language.
- [x] The assistant does not claim a team escalation occurred when it did not.
- [x] A limitation identifies the missing evidence and gives only a relevant next step.
- [x] The assistant does not expose internal tool names, prompts, or raw tool output.

### Package 3 exit gate

- [x] Direct, compound, correction, and subject-change tests pass.
- [x] Multi-turn reference-resolution tests pass for every entity-bearing capability.
- [x] Ambiguity and clarification tests pass.
- [x] Evidence hierarchy and multi-tool orchestration tests pass.
- [x] Package 3 evidence and remaining gaps are reviewed before Package 4 begins.

## Package 4 — Semantic Answer and Response-UI Validation

### Factual validation

- [x] Direct factual responses without successful evidence are rejected.
- [x] Unsupported numeric claims are rejected.
- [x] Unsupported dates and deadlines are rejected.
- [x] Unsupported names, matter titles, and participant claims are rejected.
- [x] Unsupported statuses and lifecycle claims are rejected.
- [x] Unsupported fee, charge, payout, and receipt claims are rejected.
- [x] Workflow answers that contradict executable policy are rejected.
- [x] Claims that available data is unavailable are rejected.
- [x] Claims that unavailable data is verified are rejected.
- [x] Claims about unauthorized records are rejected.
- [x] False mutation or escalation claims are rejected.
- [x] Legal advice and legal-work-product responses are rejected.

### Relevance and presentation validation

- [x] The response answers every material part of the user’s question.
- [x] The response does not answer unrelated inferred questions.
- [x] Concision limits exist for simple answers.
- [x] Suggestions are limited, relevant, and nonduplicative.
- [x] Suggestions do not repeat the answer.
- [x] Navigation links are accepted only when returned by the authorized navigation tool.
- [x] Buttons appear only when they materially advance the current task.
- [x] Billing, posting, case, and support buttons do not appear merely because those destinations exist.
- [x] Manual-review cards appear only for a real, supported escalation workflow.
- [x] Failed validation triggers a bounded correction attempt.
- [x] Exhausted correction attempts produce a safe truthful fallback rather than legacy guessed logic.

### Package 4 exit gate

- [x] Each validator has positive and negative unit tests.
- [x] Every previously observed incorrect screenshot response has a validator or regression test.
- [x] Validation telemetry records failure class and retry outcome.
- [x] Package 4 evidence and remaining gaps are reviewed before Package 5 begins.

## Package 5 — Comprehensive Evaluation Generation

### Evaluation dimensions

- [x] Every capability has canonical prompts.
- [x] Every capability has paraphrases.
- [x] Every capability has typo and shorthand variants.
- [x] Every capability has short and incomplete-language variants.
- [x] Every applicable capability has negative-question variants.
- [x] Every applicable capability has compound-question variants.
- [x] Every entity-bearing capability has vague-reference and multi-turn variants.
- [x] Every applicable capability has correction and subject-change variants.
- [x] Every capability has relevant empty-state scenarios.
- [x] Every capability has normal populated-state scenarios.
- [x] Every capability has exceptional and conflicting-state scenarios.
- [x] Every external dependency has success, absence, timeout, and failure scenarios.
- [x] Authorization-sensitive capabilities have inaccessible-record scenarios.

### Evaluation assertions

- [x] Evaluations specify required tools, not merely a list of any acceptable tools.
- [x] Evaluations specify required factual assertions.
- [x] Evaluations specify forbidden factual assertions.
- [x] Evaluations specify whether clarification is permitted or forbidden.
- [x] Evaluations specify allowed navigation and buttons.
- [x] Evaluations specify concision or expanded-detail expectations.
- [x] Evaluations inspect final answer quality, not only initial tool routing.
- [x] Critical financial, policy, privacy, authorization, and ownership cases are clearly labeled.
- [x] Every production defect automatically becomes a named permanent regression case.

### Package 5 exit gate

- [x] Evaluation generation covers every ready attorney capability.
- [x] No capability has only single-turn happy-path coverage.
- [x] All deterministic routing evaluations pass.
- [x] All deterministic final-answer evaluations pass.
- [x] All critical evaluation cases pass at 100%.
- [x] Coverage report lists capability, state, language, multi-turn, failure, and assertion coverage.
- [x] Package 5 evidence and remaining gaps are reviewed before Package 6 begins.

## Package 6 — Database-Backed Integration and End-to-End Verification

### Fixtures and scenarios

- [x] Isolated attorney fixtures cover no, one, and multiple matters.
- [x] Fixtures cover every material matter lifecycle state.
- [x] Fixtures cover applicants, invitations, pre-engagement, and assigned paralegals.
- [x] Fixtures cover tasks, files, deliverables, messages, and deadlines.
- [x] Fixtures cover payment-method states and processor failures.
- [x] Fixtures cover matter fees, charges, payouts, and receipts.
- [x] Fixtures cover disputes, withdrawals, termination, settlement, and relisting.
- [x] Fixtures cover completion, archives, downloads, and purge state.
- [x] Fixtures cover inaccessible and cross-user records.
- [x] Synthetic fixture data contains no production customer information.

### Integrated behavior

- [x] Real manager-to-tool-to-validator flow is exercised.
- [x] Real database queries are exercised against isolated data.
- [x] Route enforcement and assistant policy produce matching results.
- [x] Processor interactions use contract-faithful isolated mocks or an approved sandbox.
- [x] Final assistant text is asserted for required and forbidden content.
- [x] Conversation state persists and resolves verified active entities correctly.
- [x] Navigation and suggestion payloads are asserted.
- [x] Tool and validation failures produce the intended safe fallback.
- [x] Support drawer renders concise messages, links, suggestions, and feedback controls correctly.
- [x] Tests do not mutate production records or rely on production state.

### Package 6 exit gate

- [x] All attorney integration scenarios pass.
- [x] All attorney support-drawer Playwright scenarios pass.
- [x] No cross-user or cross-role data exposure is observed.
- [x] Package 6 evidence and remaining gaps are reviewed before Package 7 begins.

## Package 7 — Sanitized Live-Model Evaluation

### Safety and authorization

- [x] Live evaluation uses synthetic data only.
- [x] Evaluation content contains no customer records, secrets, credentials, or prohibited restricted data; the internal manager instructions and tool schemas were included only under explicit approval.
- [x] External evaluation is permitted by workspace and organizational policy.
- [x] Any required explicit approval is obtained before sending evaluation content externally.
- [x] Live evaluation was permitted; the prohibited-evaluation alternative path was not needed.

### Reliability evaluation

- [x] Required-tool routing is tested over repeated model runs.
- [x] Final factual accuracy is tested over repeated model runs.
- [x] Multi-turn reference resolution is tested over repeated model runs.
- [x] Compound and correction behavior is tested over repeated model runs.
- [x] Conflicting and unavailable evidence behavior is tested over repeated model runs.
- [x] Prompt-injection-like content inside records is treated as data, not instructions.
- [x] Concision and UI relevance are measured.
- [x] Critical policy, financial, privacy, authorization, and ownership cases have zero failures.
- [x] Noncritical reliability thresholds are defined before evaluation results are reviewed.
- [x] Failures are classified, fixed, and rerun rather than waived informally.

### Package 7 exit gate

- [x] Live-model report records model, configuration, dataset version, run count, and results.
- [x] All critical cases meet the zero-failure requirement.
- [x] All noncritical metrics meet their predefined thresholds.
- [x] Package 7 evidence and remaining gaps are reviewed and reconciled with later packages.

## Package 8 — Production Telemetry, Failure Classification, and Safe Operation

### Privacy-conscious telemetry

- [x] Manager availability is measured.
- [x] Capability selection is measured.
- [x] Tool selection, success, failure class, and latency are measured.
- [x] Evidence availability state is measured.
- [x] Validation failures and retry outcomes are measured.
- [x] Safe-fallback frequency is measured.
- [x] User feedback and repeated-question signals are measured.
- [x] Unrecognized question families are clustered without exposing unnecessary message content.
- [x] Telemetry retention and access follow product privacy requirements.
- [x] Sensitive raw tool output is not written to general telemetry.

### Operational thresholds and response

- [x] Launch and rollback thresholds are documented.
- [x] Critical validator failure thresholds are zero-tolerance.
- [x] Manager-unavailable and tool-failure alert thresholds are documented.
- [x] Unhelpful-feedback thresholds are documented.
- [x] Capability-level reliability can be inspected independently.
- [x] Failure reports link classifications to reproducible synthetic tests.
- [x] Unknown-question clusters feed the source-of-truth and evaluation backlog.
- [x] Safe fallback remains concise and does not route into guessed legacy behavior.
- [x] Reliability reporting distinguishes missing telemetry from successful behavior.

### Package 8 exit gate

- [x] Reliability report is reproducible and read-only.
- [x] Alerts and dashboards are verified with synthetic events.
- [x] Rollback or disable controls are verified.
- [x] Package 8 evidence and remaining gaps are reviewed before Package 9 begins.

## Package 9 — Staged Rollout, Acceptance, and Replication Package

### Attorney rollout

- [x] Attorney-only feature flag and role gating are verified.
- [x] Paralegal and admin remain on their existing behavior during attorney rollout.
- [x] Deployment and restart requirements are documented.
- [x] Staged rollout population and duration are defined.
- [x] Stage reports use an explicit observation start and verify exact rollout contract, stage, and percentage telemetry.
- [x] Stage advancement fails closed on missing duration, sample, reliability, prior-stage, ownership, incident, or acceptance evidence.
- [x] Daily reliability review is assigned during observation.
- [x] Critical stop and rollback conditions are defined.
- [x] Production issues receive regression tests before resolution is closed.
- [x] A small curated attorney acceptance script verifies representative workflows.
- [x] Manual acceptance is used as confirmation, not primary defect discovery.

### Documentation and replication

- [x] Attorney capability contract reflects final production behavior.
- [x] Tool, policy, validator, evaluation, and telemetry documentation is current.
- [x] Known limitations are explicit and user-facing where necessary.
- [x] Operations and incident-response instructions are current.
- [x] Reusable architecture is separated from attorney-specific permissions and data sources.
- [x] Paralegal replication requirements are documented without enabling them.
- [x] Admin replication requirements are documented without enabling them.
- [x] Future attorney-supervised paralegal work-product functionality remains separately scoped and deferred.

### Package 9 exit gate

- [ ] Attorney staged-rollout thresholds are met.
- [x] No unresolved critical defect remains.
- [x] No unexplained reliability gap remains.
- [ ] Attorney acceptance is recorded.
- [ ] Package 9 evidence is complete.

## Final Checklist Reconciliation

### Mechanical completeness audit

- [x] Search this document for every remaining unchecked item.
- [x] Each remaining unchecked item is completed or recorded in the final blocker table.
- [x] No blocked item is mislabeled as implemented.
- [x] Every checked item has an implementation or documentation artifact.
- [x] Every checked behavioral item has direct verification evidence.
- [x] Every fixed defect has a permanent regression test.
- [x] Test counts and coverage counts in the execution tracker match current output.
- [x] Changed files are reviewed for accidental paralegal or admin behavior changes.
- [x] Changed files are reviewed for secrets, sensitive logging, and unsafe data exposure.

### Final verification suite

- [x] Syntax and static checks pass for every changed backend and frontend file.
- [x] Attorney unit tests pass.
- [x] Attorney policy and tool-contract tests pass.
- [x] Attorney manager and validator tests pass.
- [x] Attorney generated routing evaluations pass.
- [x] Attorney generated final-answer evaluations pass.
- [x] Attorney database-backed integration tests pass.
- [x] Attorney support-drawer Playwright tests pass.
- [x] Sanitized live-model evaluation passes or an approved policy-compliant alternative is documented.
- [ ] Production reliability report meets launch thresholds.
- [x] Paralegal regression tests pass without behavior expansion.
- [x] Admin regression tests pass without behavior expansion.

### Critical invariants

- [x] No unsupported financial claim can be displayed.
- [x] No workflow answer can contradict executable policy.
- [x] No unauthorized record can influence or appear in an answer.
- [x] No missing lookup can be represented as a verified absence.
- [x] No assistant response can falsely claim a record-changing action occurred.
- [x] No legal advice or legal work product is produced.
- [x] No irrelevant escalation, button, or suggestion is added automatically.
- [x] No silent legacy attorney fallback can return guessed logic.

### Final completion decision

- [ ] Final blocker table is empty, or every remaining blocker is explicitly accepted by the product owner with impact documented.
- [ ] All nine package exit gates are complete.
- [x] Final evidence summary is attached to this document or linked from the execution tracker.
- [ ] Attorney assistant is approved as the reference implementation.
- [ ] Only after attorney approval may paralegal or admin replication begin.

## Evidence Log

Record evidence as work proceeds. Each entry should identify the checklist item, artifact or command, result, date, and any limitations.

| Date | Checklist item | Artifact or verification command | Result | Limitations or follow-up |
| --- | --- | --- | --- | --- |
| July 22, 2026 | Package 1 capability and evidence inventory | `docs/attorney-assistant/SOURCE_OF_TRUTH_MATRIX.md` and `DATA_PERMISSION_MATRIX.md` | 32 attorney question families, exact field families, 16 current attorney tools, evidence states, ownership, and explicit gaps recorded | No full family is classified ready; Package 2 must implement authoritative policy/tool contracts |
| July 22, 2026 | Package 1 workflow contradiction audit | `docs/attorney-assistant/WORKFLOW_POLICY_INVENTORY.md` and `RISK_REGISTER.md` | 12 named policy conflicts and 32 owned/severity-ranked risks recorded | P0/P1 product/payment/legal decisions remain implementation inputs, not waived blockers |
| July 22, 2026 | Package 1 response and evaluation contract | `docs/attorney-assistant/RESPONSE_CONTRACT.md` and `EVALUATION_SPEC.md` | Response behavior defined for A01–A32; fixtures, semantic oracles, tool traces, security suites, and pass gates specified | Behavioral tests are intentionally deferred to their implementation packages |
| July 22, 2026 | Package 1 mechanical reconciliation | `awk` check for unchecked Package 1 items; `rg` heading/ID inventory; `git diff --check -- docs/...` | 0 unchecked Package 1 items; 108 capability/policy/risk ID references; document diff check passed | Documentation-only package; no runtime tests required and no assistant behavior changed |
| July 22, 2026 | Package 2 executable policy and tool contracts | `docs/attorney-assistant/PACKAGE_2_IMPLEMENTATION.md`; policy/capability/tool/manager, support API, and workflow regression suites | Shared route/tool policy for 12 stages; 32 capability families; 10 suites and 210 tests passed | Product-policy blocks remain explicitly labeled and are not represented as verified answers |
| July 22, 2026 | Package 2 mechanical reconciliation | Package-scoped unchecked-item scan; 24 changed-file syntax checks; `git diff --check` | 0 unchecked Package 2 items; all syntax checks and diff check passed | Package 3 did not begin during reconciliation |
| July 22, 2026 | Package 3 reasoning and conversation contract | `docs/attorney-assistant/PACKAGE_3_IMPLEMENTATION.md`; conversation-policy, resolver, capability, manager, tool, and support API suites | Intent-specific evidence, compound orchestration, durable verified entities, correction/ambiguity handling, and answer validators implemented | Semantic corpus scoring and response-UI validation remain Package 4 work |
| July 22, 2026 | Package 3 mechanical reconciliation | `npm test -- attorneyConversationPolicy.test.js attorneyConversationResolver.test.js attorneySupportCapabilities.test.js supportManagerAgent.test.js supportAgentTools.test.js supportAssistant.test.js`; 12 syntax checks; Package-scoped unchecked-item scan; `git diff --check` | 6 suites and 186 tests passed; 0 syntax failures; 0 unchecked Package 3 items; diff check passed | Package 4 did not begin during reconciliation |
| July 22, 2026 | Package 4 semantic response and drawer-control validation | `docs/attorney-assistant/PACKAGE_4_IMPLEMENTATION.md`; validator, manager, response-UI, policy, resolver, tool, capability, and support API suites | 8 suites and 215 tests passed; invalid factual responses retry or fall back safely; manager action, suggestion, and review-card limits verified | Database-backed fixtures remained Package 6 work at completion |
| July 22, 2026 | Package 5 generated evaluation corpus | `docs/attorney-assistant/PACKAGE_5_IMPLEMENTATION.md` and `PACKAGE_5_COVERAGE_REPORT.md`; `npm run test:eval:attorney-support-coverage` | 558/558 routing cases, 558/558 structured answer-oracle cases, and 558/558 critical cases passed across all 32 capability families | Live model calls are not claimed; they remain Package 7 |
| July 22, 2026 | Package 6 isolated database and manager integration | `backend/tests/helpers/attorneySupportFixtures.js`; `backend/tests/attorneySupportDatabaseIntegration.test.js`; `npm run test:integration:attorney-support` | 12/12 scenarios passed using synthetic Mongo records and isolated processor mocks; manager/tool/validator, lifecycle, money, memory, navigation, failures, and ownership boundaries verified | Object-storage existence remains policy-blocked and correctly reports `archiveStorageChecked: false`; live model scoring remains Package 7 |
| July 22, 2026 | Package 6 support-drawer browser verification | `npm run test:playwright:support` and `backend/tests/playwright/support/support.spec.js` | 4/4 Playwright scenarios passed, including concise manager response, verified inline link, suggestions, feedback, and quiet validation fallback | Browser server and account are synthetic local fixtures only |
| July 22, 2026 | Package 6 regression and mechanical reconciliation | Package 2–6 ten-suite Jest command; Package 6 unchecked-item scan; JavaScript/JSON syntax checks; `git diff --check` | 10 suites and 242 tests passed; Package 6 has zero unchecked items | Sanitized repeated live-model evaluation is the next package |
| July 22, 2026 | Package 8 privacy-conscious reliability telemetry and operations | `docs/attorney-assistant/PACKAGE_8_IMPLEMENTATION.md`; `PACKAGE_8_OPERATIONS.md`; `backend/services/support/attorneyReliabilityService.js`; synthetic report and Package 8 tests | Manager/capability/tool/evidence/validation/fallback/feedback/repeat/unknown/missing signals implemented with allowlisted telemetry, opaque clustering, independent capability metrics, and zero-tolerance gates | Package 7 external live-model gate remains open pending explicit transmission approval; Package 9 production rollout has not begun |
| July 22, 2026 | Package 8 regression and mechanical reconciliation | 14-suite Package 2–8 Jest command; `npm run test:playwright:support`; synthetic reliability report; syntax/JSON/diff/checklist scans | 14/14 suites and 272/272 tests passed; 4/4 browser scenarios passed; synthetic 120-message gate passed; zero unchecked Package 8 items | Synthetic results verify operations machinery, not production rollout acceptance |
| July 22, 2026 | Package 9 rollout controls and curated acceptance | `backend/services/support/attorneyRolloutService.js`; `npm run test:acceptance:attorney-support`; `PACKAGE_9_ROLLOUT_AND_ACCEPTANCE.md` | Attorney-only kill switch, stable cohorts/allowlist, role isolation, rollout telemetry, and 11/11 acceptance scenarios passed | Product-owner confirmation waits for production gate |
| July 22, 2026 | Package 9 production reliability snapshot | `npm run report:attorney-support-reliability -- --days=30` | Read-only privacy projection executed; gate failed with 13 manager messages, 3 safe fallbacks, 4 critical validator classifications, and 11 missing-current-contract events | Evidence-plan tool filtering fixed the identified routing cluster; deployment and fresh staged observation required |
| July 22, 2026 | Package 9 full deterministic verification | 15-suite Package 2–9 Jest command; generated corpus; Package 7 dry-run; Playwright | 15/15 suites and 284/284 tests; 558/558 generated cases; 86-case/172-request sanitized dry-run; 4/4 browser scenarios | External Package 7 calls were not made; production window remains below gate |
| July 22, 2026 | Package 7 sanitized live-model evaluation and reconciliation | `docs/attorney-assistant/PACKAGE_7_RELEASE_THRESHOLDS.md`; configured `gpt-5.6-terra`; routing and end-to-end runners; final 15-suite regression | Routing 172/172; end-to-end 28/28; 0 critical failures; 0 threshold failures; deterministic/database 15/15 suites and 286/286 tests | Package 7 closed; Package 9 production observation remains open |
| July 22, 2026 | Package 9 pre-deployment stage-gate enforcement | `backend/services/support/attorneyRolloutService.js`; reliability report stage options; rollout/reliability/API regressions; synthetic pass/fail stage evidence | Curated acceptance 11/11; 15/15 suites and 288/288 tests; complete synthetic General gate passed; incomplete Internal gate exited nonzero | No deployment or production configuration change; staged production observation remains open |
| July 22, 2026 | Localhost paralegal-payout timing regression | `PD007_general_paralegal_payout_timing_false_limitation`; planner/tool/manager/validator/policy/route regressions; curated and full-suite commands; Package 7 v2 dry-run | General and pronoun follow-ups now use executable workflow policy; false limitations are rejected; verified deterministic fallback is available; curated acceptance 13/13, generated corpus 559/559, 15/15 suites with 297/297 tests, and the 15-scenario synthetic dry-run preflight passed | No deployment or new external model run performed; restart the local backend before manual confirmation; Package 9 production observation remains open |
| July 22, 2026 | Localhost post-hire lifecycle regression | `PD008_post_hire_workflow_generic_fallback`; shared hire/workspace/completion policy; planner/tool/manager/validator/fallback regressions; Package 7 v3 dry-run | Exact, paraphrased, and follow-up wording now uses executable workflow evidence; the generic fallback is rejected and replaced with a verified lifecycle answer; curated acceptance 15/15, generated corpus 560/560, 15/15 suites with 304/304 tests, and the 16-scenario synthetic dry-run preflight passed | No deployment or new external model run performed; restart the local backend before retesting; Package 9 production observation remains open |
| July 22, 2026 | PD009 and final pre-deployment reconciliation | `PD009_general_hiring_raw_evidence_leak`; structural capability/tool boundary; semantic completeness and untrusted-record validators; Package 7 v4 live runners; final 15-suite command | PD009 is generated into the corpus; 561/561 corpus cases, 172/172 live routing runs, 34/34 full-pipeline live runs, 15/15 suites with 207/207 tests, 15/15 curated acceptance cases, and 4/4 Playwright cases passed | The historical 304 total preceded the structural rewrite: 115 prompt-specific/duplicative assertions were replaced to produce 189, then 18 structural tests were added to reach 207. The full 15-suite run had no skipped tests and no `.skip`/`.only`; the separate acceptance command intentionally selects its 15 named cases. No deployment occurred; production observation and owner acceptance remain open. |
| July 23, 2026 | Human-contact navigation | Shared human-contact intent handling; verified `contact.html` navigation for attorney, paralegal, and admin; support API, final 15-suite, and support-drawer browser commands | Requests for a human, representative, customer service, or another real person now receive a concise Contact Us response and verified action without a false handoff claim; 136/136 support API tests, the current 15/15-suite attorney gate with 210/210 tests, and 4/4 drawer scenarios passed | This is a verified navigation response, not an assertion that a person has already been contacted. The historical 304 reconciliation is unchanged: the 189 structural baseline plus 21 current structural tests produces 210. No deployment occurred. |

## Final Blocker Table

This table must be empty at final sign-off unless the product owner explicitly accepts a documented residual limitation.

| Checklist item | Blocker | User impact | Required resolution | Owner | Acceptance decision |
| --- | --- | --- | --- | --- | --- |
| Package 9 staged-rollout thresholds | Current production report fails zero-tolerance/rate gates and has 13 manager messages; required observation duration has not elapsed | Attorney reference implementation cannot be approved for general rollout | Deploy current fixes/controls; begin Internal stage; collect at least 100 fresh manager messages and satisfy every stage duration/threshold | LPC product operations + backend on-call | Pending |
| Package 9 attorney acceptance | Automated acceptance passes, but product-owner confirmation must follow a passing production window | Final product acceptance is not recorded | Complete the controlled-account confirmation after the staged production gates pass | Product owner | Pending |
