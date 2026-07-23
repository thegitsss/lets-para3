# Attorney Assistant Package 9 Rollout and Acceptance

Defined: July 22, 2026

## Deployment Controls

The manager remains hardcoded to role `attorney`. The rollout decision also requires:

- `OPENAI_SUPPORT_MANAGER_ENABLED=true` — global manager kill switch;
- `OPENAI_ATTORNEY_MANAGER_ENABLED=true` — attorney-only kill switch;
- enrollment by `OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT` or `OPENAI_ATTORNEY_MANAGER_ALLOWLIST`.

The percentage is a deterministic SHA-256 bucket of the authenticated account key. It does not change between requests. The allowlist accepts exact authenticated account ID or email values; those values are never written to rollout telemetry. An invalid percentage fails closed to 0%. The default is 100% for backward compatibility.

Accounts outside an active cohort receive one concise “not available for this account yet” response with no guessed facts, actions, suggestions, or escalation. They are recorded as rollout-excluded and are not counted as manager outages.

Changing any flag requires updating the production service environment and restarting/redeploying every backend instance. After restart, verify the structured reliability report's `operationalMode`, one enrolled attorney, one excluded attorney where applicable, and paralegal/admin isolation.

## Stages and Required Observation

Every stage must meet both its minimum duration and all Package 8 thresholds. Time or sample size alone cannot advance a stage.

| Stage | Enrollment | Minimum duration | Minimum manager sample | Advance condition |
| --- | ---: | ---: | ---: | --- |
| Internal | Allowlist only (0%) | 24 hours | 100 | Curated acceptance passes; no critical event |
| Canary | Stable 10% | 48 hours | 100 | All thresholds pass on fresh contract telemetry |
| Limited | Stable 25% | 48 hours | 100 | All thresholds pass; no open rollout incident |
| Expanded | Stable 50% | 72 hours | 100 | All thresholds pass; no open rollout incident |
| General | 100% | 7 days | 100 | All thresholds pass; product-owner confirmation recorded |

The release owner is LPC product operations; the backend on-call is the technical backup. During an active stage, the release owner records the reliability report once each calendar day and at every stage boundary. A deployment record must name the individuals filling those roles before Internal begins.

## Machine-enforced Stage Evidence

Stage advancement is fail-closed in `attorneyRolloutService.evaluateAttorneyRolloutStageGate`. It requires all of the following in one report:

- the exact stage start timestamp and minimum elapsed hours;
- at least 100 manager messages after that timestamp;
- a passing Package 8 reliability gate;
- exact agreement between the configured percentage and every manager message's Package 9 stage, percentage, and telemetry-contract version;
- zero missing rollout telemetry;
- all prior stages recorded as complete;
- explicit release-owner and technical-owner records;
- an explicit open-incident count, including `0` when none are open;
- passing curated acceptance and Package 7;
- product-owner confirmation for General only.

Omitting a required field blocks the gate. A mismatch, insufficient duration/sample, reliability breach, telemetry gap, or open incident also blocks it and causes `--enforce-stage-gate` to exit nonzero.

After a stage is deployed, record its exact start time and use this read-only command at the boundary, replacing the placeholders:

```sh
cd backend
npm run report:attorney-support-reliability -- \
  --stage=internal \
  --since=STAGE_START_ISO_8601 \
  --open-incidents=0 \
  --curated-acceptance-passed \
  --package7-passed \
  --release-owner=RECORDED_RELEASE_OWNER \
  --technical-owner=RECORDED_TECHNICAL_OWNER \
  --enforce-stage-gate
```

For later stages, change `--stage` and add the completed predecessors:

| Stage being evaluated | Required `--completed-stages` value | Additional flag |
| --- | --- | --- |
| Internal | Omit the flag | None |
| Canary | `internal` | None |
| Limited | `internal,canary` | None |
| Expanded | `internal,canary,limited` | None |
| General | `internal,canary,limited,expanded` | `--product-owner-confirmed` |

The report reads only attorney assistant telemetry created after `--since`. It does not change rollout configuration, deploy code, restart services, or mutate production records.

## Stop and Rollback

Stop expansion immediately for any critical validator, financial, policy, authorization, ownership, privacy, mutation, legal-boundary, or unsafe-legacy event. Also stop for any Package 8 rate/latency threshold breach.

Safe rollback:

1. Set `OPENAI_ATTORNEY_MANAGER_ENABLED=false` (or the global switch if broader manager shutdown is required).
2. Confirm `OPENAI_ATTORNEY_LEGACY_FALLBACK=false`.
3. Restart/redeploy all backend instances.
4. Verify the concise unavailable response and no guessed legacy response.
5. Classify the incident, add a permanent synthetic regression, run the linked tests, and keep the incident open until the regression passes.
6. Restart at the last fully completed stage; never skip observation time because a code fix appears small.

Production issues cannot be closed from an explanation alone. A permanent regression, fix verification, and fresh reliability window are required.

## Curated Automated Acceptance

Run before manual confirmation:

```sh
cd backend
npm run test:acceptance:attorney-support
```

The command uses isolated synthetic records and verifies 11 representative scenarios: manager/tool/validator orchestration, money labels, payment saved/absent/outage states, ownership isolation, multi-turn entity refresh, truthful dependency failure, legal-drafting refusal, paralegal/admin isolation, response-UI restraint, and both manager kill switches.

Manual acceptance is confirmation only. After the automated, database, reliability, and browser gates pass, the product owner performs one short controlled-account walkthrough covering a simple fact, workflow prerequisite, named-matter money question, one-word follow-up, legal boundary, and drawer presentation. Manual discovery does not waive a failing automated or production gate.

## Current Production Snapshot

The privacy-safe read-only 30-day report on July 22, 2026 did **not** pass:

- 54 assistant messages, but only 13 manager messages (minimum 100);
- 3 validation safe fallbacks (23.08%, threshold 1%);
- 4 zero-tolerance validator failure classifications;
- 11 manager messages missing the current telemetry contract (84.62%, threshold 2%);
- 0 manager-unavailable events, 0 tool execution failures, and 0 unhelpful feedback;
- p95 manager latency 13,785 ms, within the 15,000 ms threshold.

The critical cluster was posting/product-knowledge routing. The manager had been offered unrelated knowledge/navigation tools during a deterministic workflow-prerequisite turn. Package 9 now filters available tools to the deterministic evidence plan, with a permanent regression. Historical failed events remain in the report and are not erased.

Package 9 cannot claim staged threshold completion until the fix is deployed and a fresh stage meets the required duration and sample. Package 7's external repeated live-model gate passed on July 22, 2026.
