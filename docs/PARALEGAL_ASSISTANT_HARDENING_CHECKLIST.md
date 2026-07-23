# Paralegal Assistant Hardening Checklist

Status: Packages 1–9 implementation complete; latest live-model rerun, deployment, and production acceptance pending

Reference branch: `agent/paralegal-assistant-hardening`

The attorney assistant supplies reusable architecture only. Paralegal capabilities, evidence, permissions, workflow policy, validation, evaluation, and rollout must be approved independently. The paralegal manager remains disabled until every pre-rollout gate below passes.

## Non-negotiable boundaries

- [x] Keep the manager role allowlist attorney-only during Package 1.
- [x] Treat authenticated identity and role as server-derived authority.
- [x] Limit matter evidence to assigned, invited, applied-to, withdrawn-from, or otherwise explicitly authorized records.
- [x] Keep application, invitation, assignment, completion, payment release, Stripe payout, and bank deposit as distinct states.
- [x] Never expose attorney billing credentials, other applicants, internal/admin notes, fraud signals, raw processor objects, secrets, or unrelated matters.
- [x] Keep legal advice, legal conclusions, unsupervised legal drafting, filing, and external communication outside support-chat scope.
- [x] Keep attorney-supervised paralegal work-product tools deferred as a separate future product.
- [x] Keep the assistant read-only; no applying, accepting, declining, messaging, uploading, completing, withdrawing, disputing, changing profile data, or altering payout settings through chat.

## Package 1 — independent capability and evidence audit

- [x] Define the paralegal capability catalog P01–P32.
- [x] Map each family to current code/data sources and evidence states.
- [x] Record role, record, and field-level permissions.
- [x] Inventory the application, invitation, pre-engagement, assignment, work, completion, payout, withdrawal, and archive workflows.
- [x] Record contradictions and missing authorities instead of choosing rules in prompts.
- [x] Define the response contract and evaluation dimensions.
- [x] Create a severity-ranked risk register.
- [x] Confirm the upgraded manager cannot be enabled for paralegals through configuration alone.
- [x] Confirm Package 1 makes no runtime behavior change.

Evidence:

- `docs/paralegal-assistant/SOURCE_OF_TRUTH_MATRIX.md`
- `docs/paralegal-assistant/DATA_PERMISSION_MATRIX.md`
- `docs/paralegal-assistant/WORKFLOW_POLICY_INVENTORY.md`
- `docs/paralegal-assistant/RISK_REGISTER.md`
- `docs/paralegal-assistant/RESPONSE_CONTRACT.md`
- `docs/paralegal-assistant/EVALUATION_SPEC.md`
- `docs/paralegal-assistant/PACKAGE_1_IMPLEMENTATION.md`

## Package 2 — executable policy, capability, and tool contracts

- [x] Create a canonical paralegal workflow policy shared by chat and mutation routes.
- [x] Create executable P01–P32 capability definitions and evidence plans.
- [x] Replace broad shared tools with paralegal-specific, least-privilege projections.
- [x] Add complete application/invitation/pre-engagement reconciliation.
- [x] Add assigned-matter workspace, tasks, files, messages, completion, and withdrawal tools.
- [x] Add payout setup, payout history, payout amount, release, and bank-timing tools with explicit evidence states.
- [x] Add account/profile/preferences/security/deactivation snapshots.
- [x] Add role-safe navigation.
- [x] Prove all paralegal tools reject attorney, admin, other-paralegal, and unrelated-record access.
- [x] Keep manager execution disabled.

Evidence:

- `backend/services/paralegalWorkflowPolicy.js`
- `backend/ai/paralegalSupportCapabilities.js`
- `backend/ai/paralegalSupportAgentTools.js`
- `backend/ai/paralegalConversationPolicy.js`
- `backend/ai/paralegalEvidenceContract.js`
- `backend/ai/paralegalResponseValidator.js`
- `backend/tests/paralegalWorkflowPolicy.test.js`
- `backend/tests/paralegalSupportCapabilities.test.js`
- `backend/tests/paralegalSupportAgentTools.test.js`
- `backend/tests/paralegalConversationPolicy.test.js`
- `backend/tests/paralegalEvidenceContract.test.js`
- `backend/tests/paralegalResponseValidator.test.js`
- `docs/paralegal-assistant/PACKAGE_2_IMPLEMENTATION.md`

## Package 3 — conversation planning and memory

- [x] Build a paralegal evidence planner; do not reuse attorney capability IDs or evidence rules.
- [x] Resolve named matters, applications, invitations, and pronouns only from authorized durable memory.
- [x] Handle subject changes, corrections, “both/all,” and follow-up dimensions without repeated tool calls.
- [x] Ask one clarification only when ambiguity materially blocks a safe answer.
- [x] Prevent conversation history or page context from becoming factual proof.
- [x] Keep compound answers concise and ordered by the user’s question.

Evidence:

- `backend/ai/paralegalConversationPolicy.js`
- `backend/ai/paralegalConversationResolver.js`
- `backend/tests/paralegalConversationPolicy.test.js`
- `backend/tests/paralegalConversationResolver.test.js`
- `docs/paralegal-assistant/PACKAGE_3_IMPLEMENTATION.md`

## Package 4 — response validation and UI controls

- [x] Validate names, dates, amounts, fees, statuses, workflow claims, authorization claims, and availability claims against selected evidence.
- [x] Reject raw evidence dumps, internal field names, generic verified-information prose, and unsupported certainty.
- [x] Retry/repair within a bounded loop, then use an evidence-backed safe fallback.
- [x] Limit navigation/actions to one relevant destination and suppress duplicate inline/button links.
- [x] Keep suggestions at zero or one unless a tested clarification requires choices.
- [x] Never display a manual-review card unless a real escalation path exists.

Evidence:

- `backend/ai/paralegalResponseValidator.js`
- `backend/ai/paralegalResponseUiPolicy.js`
- `backend/ai/paralegalResponsePipeline.js`
- `backend/ai/paralegalEvidenceContract.js`
- `backend/tests/paralegalResponseValidator.test.js`
- `backend/tests/paralegalResponseUiPolicy.test.js`
- `backend/tests/paralegalResponsePipeline.test.js`
- `docs/paralegal-assistant/PACKAGE_4_IMPLEMENTATION.md`

## Package 5 — generated regression corpus

- [x] Generate positive, absent, unavailable, unauthorized, ambiguous, adversarial, paraphrase, typo, follow-up, compound, and repeated-question cases for P01–P32.
- [x] Include every production defect permanently.
- [x] Add routing, evidence, answer-oracle, privacy, and UI expectations.
- [x] Require zero critical failures and full family coverage.

Evidence:

- `backend/ai/paralegalSupportEvalCorpus.js`
- `backend/ai/paralegalSupportProductionDefects.js`
- `backend/scripts/eval-paralegal-support-coverage.js`
- `backend/tests/paralegalSupportEvalCorpus.test.js`
- `backend/tests/paralegalConversationPolicy.test.js`
- `docs/paralegal-assistant/PACKAGE_5_IMPLEMENTATION.md`
- `docs/paralegal-assistant/PACKAGE_5_COVERAGE_REPORT.md`

## Package 6 — isolated database and browser integration

- [x] Build synthetic paralegal, attorney, matter, application, invitation, message, file, task, payout, and Stripe fixtures.
- [x] Test assigned, invited, applied, rejected, completed, withdrawn, disputed, archived, and inaccessible records.
- [x] Exercise the complete manager/tool/validator/fallback pipeline with processor mocks.
- [x] Verify the real drawer renders concise answers, a single action, feedback, and safe fallback.

Evidence:

- `backend/tests/helpers/paralegalSupportFixtures.js`
- `backend/tests/paralegalSupportDatabaseIntegration.test.js`
- `backend/playwright.paralegal-support.config.js`
- `backend/tests/playwright/paralegal-support/global.setup.js`
- `backend/tests/playwright/paralegal-support/paralegal-support.spec.js`
- `docs/paralegal-assistant/PACKAGE_6_IMPLEMENTATION.md`

## Package 7 — sanitized live-model evaluation

- [x] Use synthetic data only; do not transmit source code, real user data, or the full evaluation corpus.
- [x] Run repeated capability-selection and complete response-pipeline evaluations.
- [x] Preserve every failure and its structural disposition.
- [x] Require factual, authorization, financial, workflow, privacy, conversation, and UI thresholds.
- [x] Rerun every scenario after any structural correction.

Evidence:

- `backend/ai/paralegalSupportLiveEval.js`
- `backend/scripts/eval-paralegal-support-manager.js`
- `backend/scripts/eval-paralegal-support-e2e.js`
- `backend/tests/paralegalSupportLiveEval.test.js`
- `backend/tests/paralegalResponseValidator.test.js`
- `docs/paralegal-assistant/PACKAGE_7_RELEASE_THRESHOLDS.md`
- `docs/paralegal-assistant/PACKAGE_7_IMPLEMENTATION.md`

## Package 8 — reliability and operations

- [x] Add paralegal-specific reliability telemetry with no raw prompts, answers, identities, or tool results.
- [x] Measure manager availability, evidence completeness, validation retries/exhaustion, fallbacks, repeated questions, tool failures, and unhelpful feedback.
- [x] Define role-specific alert thresholds, owner, review cadence, incident procedure, and rollback.
- [x] Ensure attorney and paralegal metrics cannot be conflated.

Evidence:

- `backend/services/support/paralegalReliabilityService.js`
- `backend/scripts/report-paralegal-support-reliability.js`
- `backend/services/support/conversationService.js`
- `backend/tests/paralegalSupportReliability.test.js`
- `backend/tests/supportAssistant.test.js`
- `docs/paralegal-assistant/PACKAGE_8_OPERATIONS.md`
- `docs/paralegal-assistant/PACKAGE_8_IMPLEMENTATION.md`

## Package 9 — rollout and acceptance

- [x] Add a paralegal-only kill switch, allowlist, stable cohorts, and fail-closed configuration.
- [x] Enforce Internal, Limited, General, and Full stage gates mechanically.
- [x] Pass deterministic, generated, database, browser, and curated acceptance gates on the latest Package 9 source state.
- [ ] Pass the repeated live-model routing and full-pipeline gates on the latest Package 9 source state. The July 23 rerun was blocked by external `insufficient_quota`; this is not counted as a behavioral pass or failure.
- [ ] Rerun the complete gate on the final release commit.
- [ ] Complete the required fresh production observation window.
- [ ] Record product-owner acceptance before enabling the manager for paralegals.
- [x] Do not begin admin replication until the paralegal reference implementation is accepted.

Evidence:

- `backend/ai/paralegalSupportManagerAgent.js`
- `backend/services/support/paralegalRolloutService.js`
- `backend/services/support/paralegalReliabilityService.js`
- `backend/services/support/conversationService.js`
- `backend/scripts/accept-paralegal-support.js`
- `backend/scripts/report-paralegal-support-reliability.js`
- `backend/tests/paralegalSupportManagerAgent.test.js`
- `backend/tests/paralegalRollout.test.js`
- `backend/tests/paralegalSupportReliability.test.js`
- `backend/tests/supportAssistant.test.js`
- `docs/paralegal-assistant/PACKAGE_9_ROLLOUT_AND_ACCEPTANCE.md`
- `docs/paralegal-assistant/PACKAGE_9_IMPLEMENTATION.md`

## Current blocker summary

1. No code has been deployed, so no Package 9 production observation stage has started.
2. The latest Package 9 live-model rerun is blocked by external model quota. Its privacy preflight passed, but all 172 routing attempts returned `insufficient_quota`, so the 34-run full-pipeline suite did not start.
3. The complete automated gate must be rerun on the final release commit.
4. Product-owner acceptance remains intentionally unrecorded until automated and production gates pass.
5. The upgraded paralegal manager remains default-off with a default 0% cohort.
6. Policy-blocked capabilities still require explicit dependency work: merged task deadlines, storage-backed file/archive readiness, full unread semantics, and approved profile-completeness/visibility definitions.
