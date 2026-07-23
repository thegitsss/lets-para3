# Paralegal Assistant Package 8 Operations

Defined: July 23, 2026

Scope: paralegal-assistant reliability telemetry, failure classification, alerts, incident response, and safe disable. Package 9 now supplies the independently default-off manager and rollout controls. Attorney telemetry and behavior are unchanged.

## Privacy and role boundary

Every future paralegal-manager answer must persist only this allowlisted operational summary:

- role, provider, and manager availability;
- selected P01–P32 capability IDs and evidence state;
- tool name, owning capability, success flag, evidence state, failure class, and elapsed milliseconds;
- total manager latency;
- validator failure classes, retry count, exhaustion state, and retry outcome;
- safe-fallback state;
- helpful or unhelpful feedback;
- an opaque paralegal question-family hash and adjacent repeated-question signal.

The summary must never contain question or answer text, user identity, matter names or IDs, tool arguments, raw tool output, dollar amounts, credentials, processor identifiers, page context, internal notes, or another role’s metrics.

The report first selects conversations with `role: "paralegal"` and then projects only allowlisted metadata. Explicitly attorney-tagged events are excluded again during aggregation. Opaque family keys use a truncated SHA-256 digest after emails, record IDs, URLs, and numbers are removed. Support data follows the existing 183-day retention window; this report cannot request a longer period.

## Thresholds

| Metric | Launch/continue threshold | Operational response |
| --- | ---: | --- |
| Minimum manager sample | 100 assistant messages | Below this, report `insufficient_sample`; never claim a launch pass |
| Critical validator failures | 0 | Immediate stop and safe disable |
| Manager unavailable rate | At most 1% | Alert and disable when sustained or actively affecting users |
| Tool failure rate | At most 2% | Classify dependency/authorization/contract cause and run linked regression |
| Safe validation fallback rate | At most 1% | Investigate evidence, validator, or model behavior |
| Unhelpful messages | At most 5% of manager messages | Review the opaque family and add a permanent regression |
| Unhelpful among submitted feedback | At most 20% | Investigate the affected capability |
| Repeated-question rate | At most 10% | Review conversation resolution and answer completeness |
| Unknown-question rate | At most 10% | Add the opaque cluster to source-of-truth and evaluation backlogs |
| Missing required telemetry | At most 2% | Critical alert; missing events never count as success |
| Manager p95 latency | At most 15 seconds | Investigate model and tool latency |

`unsupported_monetary_claim`, fee/date/name/status/workflow/authorization/availability errors, bank-receipt overclaims, attorney-financial leakage, ownership/privacy leakage, legal-boundary violations, false action/handoff claims, and factual answers from unavailable evidence are zero-tolerance validator classes.

## Ownership and review cadence

- Release owner: LPC product owner or delegated operations lead.
- Technical owner: assigned backend/on-call engineer.
- Before rollout: run the synthetic dashboard and full Package 2–8 regression on the release commit.
- During every Package 9 observation stage: review the report daily and record reviewer, window, sample, gate, alerts, open incidents, and disposition.
- After General release: review weekly for the first 30 days, then monthly while the manager remains enabled.
- Any critical alert is reviewed immediately; a warning is triaged within one business day.

Unknown-family counts feed `SOURCE_OF_TRUTH_MATRIX.md` and `paralegalSupportEvalCorpus.js`. Failure samples contain only message ID, timestamp, classification, and a synthetic regression command.

## Commands

Synthetic privacy-safe dashboard:

```sh
cd backend
npm run test:report:paralegal-support-synthetic
```

Read-only production report, capped at 183 days:

```sh
cd backend
npm run report:paralegal-support-reliability -- --days=30
```

Focused Package 8 verification:

```sh
cd backend
npm test -- --runInBand tests/paralegalSupportReliability.test.js tests/supportAssistant.test.js
```

`gate.status` is `passed`, `threshold_breach`, `insufficient_sample`, or `missing_data`. Synthetic results verify reporting machinery only and are not production acceptance evidence.

## Incident procedure

1. Identify the alert class, affected P-capability, first/last observed time, sample size, and whether user harm is active. Do not copy raw prompts, answers, evidence, or identity into the incident.
2. For a zero-tolerance class, manager outage, cross-record/privacy issue, wrong money/workflow answer, or unsafe legacy configuration, stop stage advancement and use safe disable.
3. Run the alert-linked synthetic regression. Reproduce with synthetic records only.
4. Fix the structural planner, tool, evidence, validator, UI, or dependency cause. Do not add an exact-question branch.
5. Register any production defect permanently, rerun the generated corpus, database integration, browser suite, live-model suite when relevant, and attorney non-regression.
6. Close the incident only after the responsible owner records cause, test coverage, clean rerun, and recovery evidence.

## Safe disable and recovery

Safe disable configuration:

```text
OPENAI_PARALEGAL_MANAGER_ENABLED=false
OPENAI_PARALEGAL_LEGACY_FALLBACK=false
```

If needed, `OPENAI_SUPPORT_MANAGER_ENABLED=false` disables the shared manager globally, but that wider action requires assessing attorney impact.

After applying configuration through the normal deployment process:

1. Restart the backend.
2. Confirm the paralegal upgraded manager is not called.
3. Confirm no guessed legacy factual answer is used as an emergency fallback.
4. Confirm the drawer shows only the approved concise unavailable state for an enrolled manager request.
5. Keep the paralegal manager disabled until the zero-tolerance gate is clean and the affected metric has recovered.

Package 8 defines and verifies the safe state. Package 9 implements the paralegal kill switch, cohorts, staged enrollment, and acceptance gate in a separate paralegal manager; its default-off controls cannot extend the attorney manager's role allowlist.
