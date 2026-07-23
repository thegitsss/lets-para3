# Attorney Assistant Package 8 Operations

Defined: July 22, 2026

Scope: attorney assistant production telemetry, failure classification, alert gates, and safe disable procedure. Paralegal and admin behavior is unchanged.

## Reliability Contract

Every attorney manager answer records an allowlisted operational summary:

- provider and manager availability;
- selected capability IDs and evidence status;
- tool name, success flag, evidence state, failure class, and elapsed milliseconds;
- total manager latency;
- validation failures, retry count, exhaustion state, and retry outcome;
- safe-fallback and manager-unavailable provider states;
- helpful/unhelpful feedback;
- an opaque question-family hash and adjacent repeated-question signal.

The tool summary never contains tool arguments, tool results, case names, message text, user identity, amounts, credentials, processor IDs, or internal record content. Unknown-question clusters retain only a truncated SHA-256 family key. The production report uses an explicit database projection and does not select message text, `supportFacts`, page context, or customer identity.

Support conversations and messages use the existing 183-day product retention window. The reliability report cannot request a longer window. The report is a local read-only operations command, is not exposed as a customer endpoint, and performs only `find` queries. Access therefore follows existing production shell/database operations access.

## Thresholds

| Metric | Launch/continue threshold | Operational response |
| --- | ---: | --- |
| Minimum manager sample | 100 assistant messages | Below this, report `insufficient_sample`; do not claim a launch pass |
| Critical validator failures | 0 | Immediate stop/disable, even below minimum sample |
| Manager unavailable rate | At most 1% | Alert and disable if sustained or user impact is active |
| Tool failure rate | At most 2% | Alert, classify dependency/authorization/contract failure, run linked regression |
| Safe validation fallback rate | At most 1% | Alert and investigate evidence/validator/model behavior |
| Unhelpful messages | At most 5% of all manager messages | Investigate and add a permanent regression |
| Unhelpful among submitted feedback | At most 20% | Investigate feedback cluster and add regression |
| Repeated-question signal | At most 10% | Review conversation resolution and answer completeness |
| Unknown-question families | At most 10% | Feed opaque cluster counts into source-of-truth and evaluation backlogs |
| Missing required telemetry | At most 2% | Critical alert; never count missing events as successful |
| Manager p95 latency | At most 15 seconds | Investigate API/tool latency and run latency regression |

The configured unsafe state with either manager kill switch disabled plus `OPENAI_ATTORNEY_LEGACY_FALLBACK=true` is itself a critical gate failure. Guessed legacy attorney logic is not an approved rollback path. Package 9 adds `OPENAI_ATTORNEY_MANAGER_ENABLED`, percentage enrollment, and exact allowlist enrollment; see `PACKAGE_9_ROLLOUT_AND_ACCEPTANCE.md`.

## Failure Classes

Tool events classify outcomes as `success`, `absent`, `not_applicable`, `blocked_policy`, `authorization_denied`, `dependency_unavailable`, `invalid_request`, `tool_contract`, `absence`, or `unknown_failure`. Evidence states are counted independently so an absent record is not misreported as a failed lookup.

Report alerts attach a reproducible synthetic command for manager availability, tools, validators, fallbacks, feedback, repeated/unknown questions, missing telemetry, latency, and unsafe legacy configuration. Failure samples contain message IDs, timestamps, classifications, and regression commands only; they contain no question or answer text.

## Commands

Run the privacy-safe synthetic dashboard/report:

```sh
cd backend
npm run test:report:attorney-support-synthetic
```

Run the read-only production report for up to the 183-day retention maximum:

```sh
cd backend
npm run report:attorney-support-reliability -- --days=30
```

Run Package 8 regressions:

```sh
cd backend
npm test -- --runInBand tests/attorneySupportReliability.test.js tests/supportManagerAgent.test.js tests/supportAssistant.test.js
```

The structured JSON is the operational dashboard artifact. `gate.status` is one of `passed`, `threshold_breach`, `insufficient_sample`, or `missing_data`. `alerts` identifies response action and the linked test; `capabilityReliability` permits independent capability inspection; `unknownQuestionClusters` links the source-of-truth and evaluation backlogs.

## Safe Disable and Recovery

When a zero-tolerance failure occurs or a severe threshold breach is actively harming users:

1. Set `OPENAI_ATTORNEY_MANAGER_ENABLED=false` (or `OPENAI_SUPPORT_MANAGER_ENABLED=false` for a global manager shutdown).
2. Confirm `OPENAI_ATTORNEY_LEGACY_FALLBACK=false`.
3. Restart the backend service using the normal deployment process.
4. Verify the attorney assistant returns only the concise manager-unavailable response, with no buttons, suggestions, manual-review card, claimed action, or guessed factual answer.
5. Run the alert-linked synthetic regression, fix the cause, add a permanent regression for the incident, and rerun the deterministic/database/browser suites.
6. Re-enable the manager only after zero-tolerance checks pass and the relevant rate has recovered.

This procedure disables attorney manager answers safely; it does not enable paralegal/admin manager behavior and does not mutate customer records.

## Package Boundary

Package 8 verifies the telemetry and operational machinery with synthetic data. Package 7's external repeated live-model gate subsequently passed on July 22, 2026. A production-window threshold result and staged observation still belong to Package 9 and must not be inferred from either synthetic or live-model evaluation results.
