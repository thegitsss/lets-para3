# LPC Incident Runner

The incident system is split into two operational processes:

- Web process: Express app from `backend/index.js`
- Runner process: long-running worker from `backend/scripts/incident-runner.js`

The web process and the runner must not be merged. The web process owns intake APIs and the lightweight scheduler. The runner owns heavier incident execution work.

## What The Web Process Handles

The web process starts `startIncidentScheduler()` from `backend/index.js`.

That scheduler only handles:

- `intake_validation`
- `classification`

## What The Runner Handles

Run the runner as a separate supervised process with:

```bash
cd backend
npm run incident:runner
```

The runner continuously claims and processes:

- `investigation`
- `patch_planning`
- `patch_execution`
- `verification`
- `deployment`

It uses the same claim/lock mechanism as the web scheduler, but with a separate worker id and a longer runner-specific lock window.

## Required Environment

Common:

- `MONGO_URI`

Runner tuning:

- `INCIDENT_RUNNER_MAX_JOBS`
- `INCIDENT_RUNNER_POLL_MS`
- `INCIDENT_RUNNER_LOCK_MS`
- `INCIDENT_RUNNER_LOCK_RENEW_MS`
- `INCIDENT_RUNNER_HEARTBEAT_MS`
- `INCIDENT_RUNNER_MONGO_CONNECT_TIMEOUT_MS`
- `INCIDENT_RUNNER_SHUTDOWN_GRACE_MS`

Release-stage env if release work is enabled:

- `INCIDENT_AUTO_DEPLOY_ENABLED`
- `INCIDENT_PREVIEW_DEPLOY_MODE`
- `INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL`
- `INCIDENT_PREVIEW_SMOKE_URL`
- `INCIDENT_PRODUCTION_DEPLOY_MODE`
- `INCIDENT_PRODUCTION_DEPLOY_WEBHOOK_URL`
- `INCIDENT_PRODUCTION_HEALTH_URL`
- `INCIDENT_PRODUCTION_SMOKE_URL`
- `INCIDENT_PRODUCTION_LOG_WATCH_URL`
- `INCIDENT_PRODUCTION_ROLLBACK_WEBHOOK_URL`
- `INCIDENT_ROLLBACK_MODE`
- `INCIDENT_RELEASE_BASELINE_ID`

Approval env:

- `INCIDENT_FOUNDER_APPROVER_EMAILS`
- `INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK` is for local/dev only and should not be used as a production approval path

## Supervision Guidance

Run the runner under a real supervisor such as:

- Render background worker
- systemd
- PM2
- another internal process supervisor

An example systemd unit now lives at:

- `backend/ops/systemd/lpc-incident-runner.service.example`

The process is designed to:

- poll continuously
- drain available work without sleeping between full batches
- renew active job locks while long-running work is in progress
- stop cleanly on `SIGINT` / `SIGTERM`
- start failing fast if MongoDB is unreachable during worker startup
- emit a low-noise idle heartbeat when healthy but idle
- exit non-zero if MongoDB connectivity is lost so the supervisor can restart it
- exit non-zero if it loses exclusive ownership of an in-flight job lock so the supervisor can restart it
- exit non-zero if a second shutdown signal arrives or the configured shutdown grace period expires before the current batch finishes

## Runtime Expectations

- Run the web process and the runner as separate supervised processes.
- Treat the runner as a singleton per environment unless you are intentionally operating multiple workers against the same MongoDB and understand the shared-lock model.
- The supervisor should restart the runner on any non-zero exit.
- The supervisor stop timeout must be longer than `INCIDENT_RUNNER_SHUTDOWN_GRACE_MS`.
- `INCIDENT_RUNNER_SHUTDOWN_GRACE_MS` should be comfortably longer than the time you expect an in-flight runner batch to need for a clean shutdown.
- Long-running jobs depend on lock renewal. If the runner reports lock loss, treat that as an operational fault, not a normal job failure.
- Deployment-stage jobs are only as trustworthy as the configured preview/production/rollback provider evidence.

## What Breaks If The Runner Is Not Running

If the web process is up but the incident runner is down:

- new incident reports can still enter the system
- `intake_validation` and `classification` can still run through the web-owned scheduler
- incidents that need `investigation`, `patch_planning`, `patch_execution`, `verification`, or `deployment` will stop advancing
- founder-visible incident queues can become stale because downstream runner-owned stages stop progressing
- any approval-gated release path can remain paused indefinitely because the pre-approval runner work does not complete

This is why the runner must be treated as a first-class supervised process, not an optional helper.

## What Is Still Missing For Safe Internal Operations

This runner is now operationalized, but internal use still depends on:

- wiring the example supervisor configuration to the actual deployment host or worker platform
- provider-attested release evidence beyond generic webhooks where the current webhook contract is still limited
