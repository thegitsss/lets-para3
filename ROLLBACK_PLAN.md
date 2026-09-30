# LPC production rollback plan

This runbook covers the Render web service, incident worker, automation cron, and operations-monitor cron defined in `render.yaml`. A rollback is complete only when all four services run the same approved full Git commit and the application, data, and monitoring checks pass.

## Required incident record

Record these values before changing production:

- Incident/reference ID:
- Incident commander:
- Rollback operator:
- Release owner/approver:
- Start time and timezone:
- Current full commit SHA:
- Target known-good full commit SHA:
- Current and target Render deploy IDs for all four services:
- Rollback method for each service: Dashboard / API:
- Auto-deploy state before and after each rollback:
- Target build artifact retained for each service: yes / no:
- Current service configuration and environment-group comparison completed: yes / no:
- User impact and affected operations:
- Abort criteria:
- Declared recovery objective:
- Latest verified Atlas snapshot and timestamp:
- Migration compatibility decision: rollback / forward-fix / restore required:

Do not use “latest” or an abbreviated commit as the rollback identity. The target must be a previously reviewed, tested, retained candidate whose configuration and schema requirements are known.

## 1. Assess and contain

1. Open an incident record and preserve relevant application, Render, Stripe, Atlas, and monitoring evidence without copying secrets or personal data into the record.
2. Determine whether the defect affects authentication, authorization, money, data integrity, privacy, or destructive background work.
3. Before changing Render state, enable LPC application maintenance mode in the Control Room. Confirm the next `lets-para3-automation` run reports `paused: true` with `pauseReason: "maintenance_mode"` and contains no domain-task results. If the control state cannot be read, the automation cron fails closed and runs no scheduled mutations.
4. LPC application maintenance mode pauses all automation-cron mutations, including lifecycle finalization, deletion, mail import, timed triggers, and publishing. It does not stop the incident runner or make the public web service unreachable. If incident processing is unsafe, suspend `lets-para3-incident-runner`, record the action, and verify whether a claimed job needs lease recovery before resumption.
5. If public isolation is required, separately enable Render maintenance mode for the paid web service and record it. Render maintenance mode returns HTTP 503 to public traffic but does not pause cron jobs, private access, or the LPC incident worker; it is not a substitute for the LPC control.
6. Do not cancel or replay Stripe operations manually until their idempotency and webhook state have been reconciled.
7. Confirm that the target code can operate against the current database schema. Because the web service runs `npm run migrate:production:apply` before deployment, an older application commit must not be started against an incompatible migrated schema.

## 2. Choose rollback or forward-fix

Use rollback only when all of the following are true:

- the target commit is a retained known-good candidate;
- its required secrets and provider configuration are still valid;
- its application code is compatible with the current schema and stored data;
- reverting it will not duplicate, reverse, or orphan payment/file/deletion operations; and
- the incident commander and release owner approve the action.

Use a reviewed forward-fix when schema or external side effects make code rollback unsafe. Restore an Atlas snapshot only as a separately approved disaster-recovery action: a restore can discard legitimate writes and is not an ordinary application rollback.

## 3. Roll back the four Render services

First confirm that Render still retains the target build artifact for every service. A target visible in event history is not sufficient if its artifact has expired. Disable auto-deploys for all four services and record the result: a Dashboard rollback disables them for the selected service, while an API rollback does not and requires a separate update.

For each service, select the retained deploy for the exact target commit rather than rebuilding an unreviewed tree:

1. `lets-para3-incident-runner`
2. `lets-para3-automation`
3. `lets-para3`
4. `lets-para3-ops-monitor`

Record the selected deploy ID, operator, start/end time, and result for each service. Keep LPC application maintenance mode enabled, keep the incident worker suspended when its work is in scope, and leave the operations monitor running. The automation cron may continue on schedule because the LPC control makes each run a verified no-op.

A Render rollback restores the target artifact and certain deploy-specific settings, but it does not rewind every current service setting, environment-group value, disk, domain, or platform-runtime change. Compare the target candidate's requirements with the post-rollback configuration for each service. If Render cannot restore the same commit to every service, stop and use the reviewed forward-fix path; never leave a mixed-commit topology in service.

## 4. Verify before restoring normal traffic

From a clean checkout of the target commit and its retained candidate manifest:

1. Confirm `/api/health` is healthy and the canonical origin returns the target full `X-LPC-Release-Commit` value.
2. Run `npm run verify:production`; retain its evidence artifact.
3. Confirm the suspended incident worker's last heartbeat and the latest automation/monitor executions report the target commit. While LPC maintenance mode remains active, automation must report an intentional pause and the monitor must report `operatingState: "paused"` with `maintenance_mode_active`; neither should claim ordinary healthy operation. The monitor may exit successfully for that intentional state and an expected Render maintenance-page 503, but any unrelated failed check must still fail the run.
4. Verify representative, read-only attorney, Paralegal, admin/director, Matter, message, file-metadata, payment-ledger, and audit-record reads.
5. Verify login, authorization boundaries, and the branded 404/indexing/security-header contract.
6. Reconcile Stripe webhooks, payment operations, payouts, disputes, deletion tasks, file-scan states, and migration state before allowing their mutations to resume.
7. Confirm the owner-alert path can deliver a recovery notice and is not flooding.

Do not create a real payment or use real client data merely to prove rollback. Any controlled write journey must use named authorized test accounts and an approved production-like or live-mode test plan.

## 5. Restore services and observe

1. Resume the incident worker only after its claimed-job and lease state is reconciled, then confirm a new healthy heartbeat on the target commit.
2. Disable LPC application maintenance mode only after the incident commander accepts the verification evidence. Confirm the next automation run executes normally and the operations monitor emits one recovery transition without flooding.
3. If Render web maintenance mode was enabled, disable it after the application is ready to accept public traffic and verify the canonical origin directly.
4. Observe application health, 5xx rate, authentication, Stripe/webhook state, queues, backup freshness, and alerts for the incident-defined watch period.
5. Re-enable auto-deploys only after the release owner selects the repaired forward commit and confirms the CI-gated deployment policy for all four services.
6. Send the user-facing/internal update approved for the incident; do not claim recovery before the checks above pass.

## 6. Closeout evidence

Record:

- final commit running on all four services;
- Render deploy IDs and timestamps;
- production-verification artifact and critical-journey evidence;
- schema/migration outcome;
- financial, file, deletion, and queue reconciliation results;
- actual detection, containment, recovery, and verification times;
- residual risk, owner, and due date;
- follow-up incident/problem record.

## Rollback drill record

A tabletop discussion is not an executed rollback. Leave this section incomplete until an isolated production-like drill has actually restored all four services and verified representative data and alerts.

- Date/environment:
- Participants:
- Starting commit:
- Target commit:
- Four Render deploy IDs:
- Schema decision:
- Start → healthy duration:
- Measured RTO/RPO:
- Verification artifact:
- Alert/recovery evidence:
- Result: PASS / FAIL
- Findings and owners:

## Provider references

Revalidate provider behavior before each exercise or incident; these links are operational dependencies, not permanent guarantees:

- [Render rollbacks](https://render.com/docs/rollbacks)
- [Render deploys and auto-deploy behavior](https://render.com/docs/deploys)
- [Render cron-job execution behavior](https://render.com/docs/cronjobs)
- [Render web-service maintenance mode](https://render.com/docs/maintenance-mode)
