# LPC Incident Runner

The incident system is split into two operational processes:

- Web process: Express app from `backend/index.js`
- Runner process: long-running worker from `backend/scripts/incident-runner.js`

The web process and the runner must not be merged. The web process owns authenticated incident intake and control APIs only. It starts no incident scheduler. The runner is the sole owner of incident job execution.

## What The Web Process Handles

The web process validates and records new incident reports, exposes authorized status and decision APIs, and returns promptly. It does not poll or advance the incident queue. Scaling the web service therefore scales HTTP capacity without multiplying background work.

## What The Runner Handles

Run the runner as a separate supervised process with:

```bash
cd backend
npm run incident:runner
```

The runner continuously claims and processes:

- `intake_validation`
- `classification`
- `investigation`
- `patch_planning`
- `patch_execution`
- `verification`
- `deployment`

It is the only runtime consumer of the incident claim/lock mechanism. Each claim has an ownership token and renewable lease; losing the lease is a fatal worker condition so the supervisor can restart the process safely.

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

Production accepts only `disabled` or `webhook` for preview, production, and
rollback modes. Local `stub` and `workspace_sync` modes are rejected during
production startup. Enabling automatic deploys also requires real preview and
production webhook modes and secure webhook URLs.

Approval env:

- `INCIDENT_FOUNDER_APPROVER_EMAILS`
- `INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK` is for local/dev only and should not be used as a production approval path

## Supervision Guidance

The production Blueprint defines `lets-para3-incident-runner` as a Render background worker. Render owns restart and shutdown supervision for that process. The checked-in worker contract uses one job per batch, a renewable four-minute lock, a 270-second graceful-shutdown window, and Render's 300-second maximum shutdown delay.

## Repository branch retention

The current incident patch service creates isolated local Git worktrees and branches; it does not publish remote branches. Remote `incident/` refs are therefore legacy repository state or were created by an external release provider, not evidence that a current incident is active. Before launch and on the repository-retention cadence:

1. Export every remote branch name and tip SHA, then map each `incident/` ref to its incident, approval, release, and pull-request evidence where available.
2. Scan every remote ref—not only the default branch—for credentials, personal data, proprietary assets, and unreviewed security-sensitive material.
3. Have the incident-record owner and repository owner approve which refs must be retained. Preserve any branch required for an active incident, legal hold, audit, or unresolved review.
4. Delete or archive only the approved stale refs through an auditable, bounded operation; record the before/after counts and failed deletions. Never infer deletion permission from age or naming alone.
5. Investigate any new remote `incident/` branch because the checked-in runner has no remote-push path. A continuing increase indicates an external provider or obsolete automation that must be identified and disabled or given an explicit retention lifecycle.

Alternative self-hosted supervisors include:

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
- no incident stage, including `intake_validation` or `classification`, will advance until the runner recovers
- founder-visible incident queues can become stale because downstream runner-owned stages stop progressing
- any approval-gated release path can remain paused indefinitely because the pre-approval runner work does not complete

This is why the runner must be treated as a first-class supervised process, not an optional helper.

## Remaining Release Evidence

The runtime topology is checked in, but launch still depends on evidence that:

- the Blueprint was synced and the worker is live on the exact release commit
- its startup capability log shows MongoDB, founder approval, and AI configuration are available
- a controlled synthetic incident traverses intake validation, classification, and all applicable downstream worker-owned stages without a lost lock
- provider-attested release evidence beyond generic webhooks where the current webhook contract is still limited
