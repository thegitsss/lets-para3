# Paralegal Assistant Package 9 Implementation

Date completed: July 23, 2026

Status: implementation complete; latest live-model rerun blocked by external quota; deployment and production acceptance pending

## Outcome

Package 9 connects the independent paralegal capability, evidence,
conversation, validation, UI, evaluation, and reliability layers built in
Packages 1–8 to a separate hardened manager. It adds default-off paralegal
rollout controls and mechanical acceptance gates without changing the attorney
manager or enabling the admin assistant.

No deployment was performed.

## Runtime implementation

- `backend/ai/paralegalSupportManagerAgent.js` is the paralegal-only
  orchestration path. It performs structural capability planning, exposes only
  the planner-authorized least-privilege tools to the model, executes selected
  tools, generates an answer from selected evidence, validates and internally
  repairs it, applies UI filtering, and uses only an evidence-backed fallback.
- The manager does not add exact-question, phrase, keyword, or regex routing.
  Package 3's capability/evidence plan determines what the model can select.
- A required tool is not called twice when fresh, complete evidence for the
  same subject is already present. A new subject, different matter, explicit
  refresh, incomplete first result, or stale evidence permits another call.
- Model requests use the Responses API with structured `text.format`,
  `store: false`, and a non-identifying safety identifier. Live evaluation
  sends synthetic facts only, not source code, real user data, or the generated
  corpus.
- `backend/services/support/conversationService.js` dispatches only enrolled,
  authenticated paralegals to this manager. Attorneys retain their existing
  manager path. Admin remains excluded.
- An enrolled manager failure returns the concise approved unavailable state
  while `OPENAI_PARALEGAL_LEGACY_FALLBACK=false`; it does not substitute a
  guessed factual response.

## Rollout and telemetry

- `backend/services/support/paralegalRolloutService.js` supplies the global and
  paralegal kill switches, exact allowlist, stable SHA-256 cohorts, default 0%
  enrollment, invalid-config fail-closed behavior, role gate, versioned
  telemetry, and mechanical stage evaluation.
- Internal, Limited, General, and Full require fixed populations, minimum
  duration, minimum sample, exact stage/percentage/contract telemetry, passing
  reliability, prior-stage completion, zero open incidents, named owners,
  curated acceptance, Package 7, and final product-owner confirmation.
- `backend/services/support/paralegalReliabilityService.js` and the read-only
  reporting command now aggregate paralegal rollout state without storing raw
  prompts, answers, identities, tool results, matter identifiers, or financial
  values.
- `backend/scripts/accept-paralegal-support.js` supplies a curated 17-scenario
  synthetic acceptance gate.

The full operating procedure is
`docs/paralegal-assistant/PACKAGE_9_ROLLOUT_AND_ACCEPTANCE.md`.

## Automated verification

- Curated acceptance: 17/17 selected scenarios passed.
- Package 2–9 deterministic/database/API regression: 16/16 suites and 273/273
  tests passed.
- Generated corpus: 551/551 answer oracles and 423/423 deterministic
  planner/reuse routes passed across P01–P32; the remaining 128 cases are
  intentionally assigned to semantic/live-model evaluation.
- Production regressions: all seven registered defects passed.
- Synthetic reliability: 120/120 complete manager messages, zero missing
  telemetry, and a passing gate.
- Synthetic Full-stage gate: passed with exact current rollout telemetry,
  required prior stages, owners, zero incidents, acceptance, Package 7, and
  product-owner confirmation.
- Paralegal drawer: 2/2 Playwright scenarios passed.
- Attorney non-regression after Package 9 integration: 15/15 suites and 348/348
  current assertions passed. The current aggregate includes shared support API
  assertions added for paralegal Package 9; attorney-specific source was not
  changed.

## Latest external-model rerun

The July 23 rerun used model `gpt-5.6-terra`, synthetic-only inputs,
`store: false`, and suite `2026-07-23.paralegal.package7.v1`. Its privacy
preflight passed for all 172 requested routing evaluations: no source code,
real user data, or full corpus was included.

The provider rejected all 172 requests with `insufficient_quota` before any
tool selection was produced. This is classified as an infrastructure blocker,
not a behavioral pass or a product-code failure. Because the routing command
exited nonzero, the chained 34-run full response-pipeline suite did not start.
No source change can correct provider quota, so no prompt-specific or other
product workaround was added.

The earlier Package 7 run remains valid historical evidence—172/172 routing and
34/34 full-pipeline evaluations passed on the pre-Package-9 runtime state—but
it is not substituted for a clean live rerun on the latest source.

## Open exit conditions

1. Restore external-model quota and pass all 172 repeated routing evaluations
   and all 34 repeated full-pipeline evaluations on the latest source.
2. Rerun the complete automated gate on the final release commit.
3. Deploy through the normal release process with the manager still default-off.
4. Complete Internal, Limited, General, and Full fresh observation windows with
   the required samples and passing privacy-safe reports.
5. Record product-owner confirmation only after every earlier gate passes.
6. Keep admin replication frozen until the paralegal reference implementation
   is accepted.

These are explicit release and production acceptance gates, not unimplemented
Package 9 controls.
