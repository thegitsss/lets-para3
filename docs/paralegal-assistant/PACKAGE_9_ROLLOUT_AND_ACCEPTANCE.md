# Paralegal Assistant Package 9 Rollout and Acceptance

Defined: July 23, 2026

Status: controls implemented; no deployment or production rollout performed

## Deployment controls

The hardened manager is independently restricted to authenticated users whose
server-derived role is `paralegal`. It cannot be enabled for attorneys or
admins. A paralegal must also pass all of these controls:

- `OPENAI_SUPPORT_MANAGER_ENABLED=true` — global manager kill switch;
- `OPENAI_PARALEGAL_MANAGER_ENABLED=true` — paralegal-only kill switch;
- enrollment through `OPENAI_PARALEGAL_MANAGER_ALLOWLIST` or
  `OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT`.

The paralegal switch defaults to `false` and the rollout percentage defaults to
`0`. An invalid percentage fails closed to `0`. The allowlist accepts exact
authenticated account IDs or email addresses. Percentage enrollment uses a
stable SHA-256 cohort derived from the authenticated account key; the account
identifier is not written to rollout telemetry.

When rollout has started but an account is outside the cohort, the assistant
returns one concise unavailable response and does not use guessed legacy facts.
When an enrolled manager fails, it also fails closed unless the separately
controlled emergency flag `OPENAI_PARALEGAL_LEGACY_FALLBACK=true` is explicitly
set. That emergency fallback must remain `false` for rollout acceptance.

## Stages and required observation

Every stage requires its complete minimum duration, at least 100 manager
messages, a passing Package 8 reliability gate, exact current rollout
telemetry, and zero open rollout incidents.

| Stage | Enrollment | Minimum duration | Minimum manager sample | Advance condition |
| --- | ---: | ---: | ---: | --- |
| Internal | Explicit allowlist only (0%) | 24 hours | 100 | Automated acceptance and Package 7 pass; no critical event |
| Limited | Stable 10% | 48 hours | 100 | Internal complete and all reliability thresholds pass |
| General | Stable 50% | 72 hours | 100 | Internal and Limited complete; all thresholds pass |
| Full | 100% | 7 days | 100 | All prior stages pass and product-owner confirmation is recorded |

Time, sample size, or a clean synthetic report alone cannot advance a stage.
The release owner and technical owner must be named before Internal starts.
During an active stage, the release owner records the privacy-safe reliability
report daily and again at the stage boundary.

## Machine-enforced stage evidence

`evaluateParalegalRolloutStageGate` blocks advancement unless one report proves:

- the exact stage and its minimum elapsed time;
- at least 100 manager messages after the supplied start time;
- paralegal-only, read-only report scope and a passing reliability gate;
- exact agreement among configured percentage, stage, percentage telemetry,
  and contract version `2026-07-23.paralegal.package9.v1`;
- zero messages missing rollout telemetry;
- all prerequisite stages are recorded as complete;
- named release and technical owners;
- an explicit open-incident count, including `0`;
- passing curated acceptance and Package 7 evidence;
- product-owner confirmation for Full.

Missing or contradictory evidence is a failure. Use the read-only report at a
stage boundary:

```sh
cd backend
npm run report:paralegal-support-reliability -- \
  --stage=internal \
  --since=STAGE_START_ISO_8601 \
  --open-incidents=0 \
  --curated-acceptance-passed \
  --package7-passed \
  --release-owner=RECORDED_RELEASE_OWNER \
  --technical-owner=RECORDED_TECHNICAL_OWNER \
  --enforce-stage-gate
```

Later-stage requirements:

| Stage being evaluated | Required `--completed-stages` value | Additional flag |
| --- | --- | --- |
| Internal | Omit | None |
| Limited | `internal` | None |
| General | `internal,limited` | None |
| Full | `internal,limited,general` | `--product-owner-confirmed` |

The report does not change configuration, deploy code, restart services, or
mutate production data.

## Stop and rollback

Stop expansion immediately for a critical factual, financial, workflow,
authorization, ownership, privacy, mutation, legal-boundary, or unsafe-legacy
event, and for any Package 8 threshold breach.

Safe rollback:

1. Set `OPENAI_PARALEGAL_MANAGER_ENABLED=false`.
2. Confirm `OPENAI_PARALEGAL_LEGACY_FALLBACK=false`.
3. Restart or redeploy every backend instance through the normal release
   process.
4. Verify that the upgraded paralegal manager is not called and no guessed
   legacy factual answer is substituted.
5. Register the incident as a permanent synthetic regression, correct the
   structural cause, and rerun all affected gates.
6. Resume only from the last completed stage and repeat its required fresh
   observation window.

## Automated and manual acceptance

Run the curated synthetic acceptance gate:

```sh
cd backend
npm run test:acceptance:paralegal-support
```

It exercises database lifecycle evidence, least-privilege ownership, money and
processor distinctions, complete manager orchestration, repeated-call
prevention, fresh evidence reuse, internal answer correction, one-action UI
filtering, role isolation, both kill switches, enrolled routing, and fail-closed
manager failure.

Automated acceptance does not replace production observation. After every
automated gate and all four observation stages pass, the product owner performs
one controlled-account walkthrough covering a simple account fact, a named
matter, a payout question, a conversational follow-up, a legal boundary, and
drawer presentation. Full rollout cannot pass without that recorded
confirmation.

## Current state

No deployment or production rollout was performed. The manager is default-off,
the default percentage is 0%, and no production observation window or
product-owner acceptance is claimed. Package 9 implementation can be release
ready while final production acceptance remains blocked on those external
steps.
