# Attorney Assistant Package 9 Implementation Evidence

Status: implementation complete; production acceptance blocked

Date: July 22, 2026

## Implemented

- Attorney-only kill switch plus hardcoded attorney role gate.
- Deterministic percentage cohorts, exact allowlist enrollment, invalid-config fail-closed behavior, and privacy-safe rollout telemetry.
- Rollout-excluded behavior separated from manager outage metrics.
- Fixed stage populations, minimum durations, sample requirements, daily review ownership, stop conditions, and safe rollback instructions.
- Machine-enforced stage advancement that validates duration, manager sample, reliability, rollout telemetry version/stage/percentage, prior stages, owner assignment, explicit incident status, Package 7, curated acceptance, and final confirmation.
- Read-only stage-window reporting from an explicit ISO-8601 start time, with nonzero exit on a failed enforced gate.
- Curated 15-scenario synthetic acceptance command.
- Final 32-family capability contract and explicit limitations.
- Current operations, incident response, and attorney/paralegal/admin replication documentation.
- Required workflow evidence-plan tool filtering, added after the production snapshot exposed unrelated-tool routing.

## Acceptance Evidence

`npm run test:acceptance:attorney-support` passed 15/15 selected scenarios across four suites. It is automated primary acceptance, not a replacement for the production observation window or product-owner confirmation.

- Final Package 2–9 deterministic/database regression: 15/15 suites and 210/210 tests passed.
- Generated evaluation corpus: 561/561 routing, answer-oracle, and critical cases passed across 32 capability families, including PD001–PD009.
- Package 7 live evaluation on suite `2026-07-22.package7.v4`: 172/172 repeated routing runs and 34/34 repeated end-to-end answer runs passed with zero critical or threshold failures; synthetic-only and `store: false`.
- Attorney support drawer: 4/4 Playwright scenarios passed.
- Production report: executed read-only with the allowlisted projection and failed as recorded in `PACKAGE_9_ROLLOUT_AND_ACCEPTANCE.md`.
- Package 9 defects have permanent regressions, including unrelated workflow tools, numeric claims matching identifier digits, payout/post-hire evidence gaps, and PD009’s general-hiring raw-evidence leak.
- The payout correction routes general and pronoun-follow-up wording to the shared workflow source, exposes the completion/release trigger and 3–5-business-day bank estimate, rejects false limitations or incomplete answers, and uses an evidence-backed deterministic answer if model validation is exhausted.
- Package 7 suite `2026-07-22.package7.v4` includes 17 full-pipeline scenarios, including general hiring and raw-evidence protection. Its final external run passed all 34 repetitions; the 86-case capability-selection suite passed all 172 repetitions.

## Test-count reconciliation

The 304/304 result is retained as a historical pre-structural-hardening snapshot. During the normalized evidence/claim-contract rewrite, 115 prompt-specific or duplicative assertions were removed or replaced, producing the previously reported 189-test baseline. No `.skip`, `.only`, or Jest exclusion caused that change. Twenty-one structural contract, security, fallback, conversational, PD009, and verified Contact Us navigation tests were then added, producing the current 210/210 total for the same 15 named attorney suites. The full 15-suite run has no skipped tests; the curated acceptance command separately uses a test-name filter to run its 15 approved cases.
- The synthetic reliability report passed with 120/120 manager messages and complete rollout telemetry. A fully populated synthetic General-stage gate passed; a mismatched/too-short stage exited nonzero with explicit blockers. These validate machinery only, not production observation.

## Open Exit Conditions

1. The current 30-day production reliability report fails the Package 9 gate and has only 13 manager messages.
2. The evidence-plan routing fix, rollout controls, and stage telemetry must be deployed, followed by each required staged duration and fresh 100-message minimum.
3. Product-owner manual confirmation must be recorded after automated and production gates pass.

These conditions are blockers, not waived defects. Package 9 and final attorney reference-implementation approval remain open until they are satisfied.
