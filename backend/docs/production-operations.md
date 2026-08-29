# LPC production operations

## Runtime topology

Production is four independently supervised Render services from `render.yaml`:

- `lets-para3`: public web/API service. It owns HTTP traffic and incident intake APIs only; it starts no recurring business work.
- `lets-para3-incident-runner`: long-running background worker and sole consumer for incident intake validation, classification, investigation, patch planning/execution, verification, and deployment-stage jobs.
- `lets-para3-automation`: five-minute cron. Before any domain work, it reads LPC application maintenance mode without creating or changing settings. When active, the run exits successfully as an intentional no-op. When the control state is unreadable, it fails closed and runs no scheduled mutations. Otherwise it finalizes expired withdrawal windows, sends claimed overdue-dispute notices, imports director mail, purges expired case artifacts, and processes durable personal-storage deletion tasks every run; on ten-minute UTC slots it also runs timed triggers, marketing research/cleanup/publishing, director follow-ups, monitoring reports, and founder daily preparation.
- `lets-para3-ops-monitor`: five-minute cron. It checks public health, LPC maintenance mode, Atlas backup freshness, failed Stripe webhooks, aged reconciliation queues, persistent funding/refund/payout exceptions, file-security state, archive recovery state, and stuck or repeatedly failing personal-storage deletion tasks.

The web service contains no in-process case purger or business-scheduler startup path. This prevents duplicate work when web instances scale horizontally without relying on environment switches. Render guarantees at most one active run of a given cron job; atomic database claims, leases, and idempotency remain the authority for consequential domain operations and overlapping/retried invocations.

Run `npm run check:deploy` from `backend/` before every deployment. The check validates Render's pinned schema and the exact LPC service, schedule, shutdown, command, environment, and secret-declaration contract.

Render provides `RENDER_GIT_COMMIT` to Git-backed runtimes. LPC requires a full 40-character value in every production Render process. The web service emits it as `X-LPC-Release-Commit`; the incident runner, automation cron, and operations monitor include it in their startup/run evidence. The monitor also fails its public-health check if the web commit does not match its own commit. This detects partial or stale four-service deployments without relying on a dashboard label.

## Assistant rollout authority

Production startup requires an explicit Attorney Assistant state. `OPENAI_ATTORNEY_MANAGER_ENABLED` and `OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT` are externally set Blueprint values rather than source defaults. The only accepted rollout stages are 0, 10, 25, 50, and 100 percent. An enabled 0-percent internal stage also requires a nonempty `OPENAI_ATTORNEY_MANAGER_ALLOWLIST`; disabling either the global or attorney manager requires a 0-percent rollout. The unsafe legacy fallback is always disabled. Record the non-identifying stage, the Package 9 gate result, observation window, incident count, release owner, and technical owner before advancing a stage. A missing, malformed, or inconsistent setting prevents the web service from starting.

The Paralegal upgraded manager remains explicitly disabled at 0 percent in the current production Blueprint, with its legacy model fallback disabled. The deterministic grounded Paralegal support path remains available. Enabling the upgraded manager requires a separately reviewed production-contract change and its own recorded acceptance evidence; dashboard drift alone cannot enable it.

## Alerts and monitor state

The operations monitor stores only its last `ok` value, stable failure-type fingerprint, and check time in the singleton `OpsMonitorState` record. This survives ephemeral cron instances and prevents changing counts or provider messages from generating a repeated five-minute email for the same incident type. A new failure type sends one owner alert; recovery sends one recovery alert. A required alert must be accepted by the configured mail transport before the new monitor state is acknowledged; otherwise the cron fails and retries notification on its next run.

`OWNER_ALERT_EMAILS` and the production SMTP/DKIM configuration are required. Render job-failure notifications should also target the on-call owner because a process-level failure can prevent application email from being sent.

## Emergency mutation control

LPC application maintenance mode is the authoritative emergency pause for the automation cron. Enable it through the authenticated Control Room before a rollback or any operation in which scheduled writes are unsafe. The next automation summary must contain only the successful `automationControl` result, `paused: true`, and `pauseReason: "maintenance_mode"`; lifecycle, deletion, mail, marketing, and other scheduled functions must not appear. A failed settings read produces `pauseReason: "settings_unavailable"`, a nonzero cron result, and no scheduled mutation.

The operations monitor treats an active pause as `maintenance_mode_active` and an unreadable state as `maintenance_mode_check_failed`. Its durable fingerprint produces one failure transition and one recovery transition rather than an email every five minutes. An intentional pause remains visibly non-healthy (`operatingState: "paused"`) but the monitor process exits successfully after required alert delivery when its only other failure is the expected HTTP 503 from Render web maintenance. Any backup, payment, file, queue, control-read, unexpected health, or alert-delivery failure still exits nonzero. Keep the monitor running during containment.

Render's separate web-service maintenance mode only replaces public responses with HTTP 503 on a paid web service. It does not pause the automation cron or incident worker and must not be used as the scheduled-work control. LPC application maintenance mode also blocks non-admin authentication but does not make the site unreachable, so use both controls when both mutation containment and public isolation are required.

Pausing also delays lifecycle deadlines and personal-storage deletion work. Record the pause interval, reconcile due and claimed work before resumption, disable LPC maintenance mode only with incident-owner approval, and verify the next automation run and monitor recovery.

## Backup evidence

Production backup monitoring reads MongoDB Atlas Cloud Backup through an OAuth 2.0 service account. Configure:

- `ATLAS_PROJECT_ID`
- `ATLAS_CLUSTER_NAME`
- `ATLAS_CLUSTER_TYPE` as `replica_set`, `sharded`, or `flex`
- `ATLAS_CLIENT_ID`
- `ATLAS_CLIENT_SECRET`
- `BACKUP_MAX_AGE_HOURS` (36 in the production contract)

Grant the service account only Project Read Only access. If Atlas API access lists are required, allow the outbound addresses used by the Render cron service. The monitor fails if configuration is partial, authentication fails, no completed snapshot exists, or the newest completed snapshot is stale.

Snapshot freshness is not restore proof. Before launch and on the documented recovery cadence, restore the newest snapshot to an isolated non-production cluster, verify representative users/cases/payment ledgers and indexes, record recovery point/time objectives, then destroy the isolated restore after evidence is retained. Never point a drill at production.

The local `npm run backup:db` command is for developer-controlled storage only. Render cron filesystems are ephemeral, so a local `mongodump` on Render is not a production backup.

## Launch evidence

The release record must contain:

1. The retained `check:candidate` manifest and protected CI URL proving a clean checkout whose `HEAD` equals the reviewed commit, with matching critical release-file hashes.
2. Blueprint sync/deploy identifiers for all four services on that exact commit, plus each service's reported full `RENDER_GIT_COMMIT`.
3. A retained passing `npm run verify:production` result from the same clean candidate checkout. It binds the canonical origin's release header, health, security headers, real unknown-route 404 behavior, and exact homepage, 404, legal, robots, and sitemap bytes to the candidate manifest.
4. Successful web health and one successful run for each cron.
5. A worker heartbeat plus a controlled incident-stage traversal.
6. A fresh Atlas snapshot check and a completed isolated restore drill.
7. A controlled failed check that reaches the owner alert address, followed by one recovery notification without alert flooding.
8. Render job-failure and worker-restart notification routing to the named on-call owner.

Missing runtime or evidence is a stop-ship condition; a passing local script is not production attestation.

## Personal-storage deletion operations

Profile photos, résumés, certificates, and writing samples use the `StorageDeletionTask` outbox when an object is replaced, cleared, rejected, or removed during an authorized account purge. The mutation stages deletion in `held` state before changing the database reference. A successful database mutation activates the task; a failed mutation cancels it. If a process stops between those steps, the automation service reconciles an aged held task against the user’s current references before deciding whether to activate or cancel it.

The five-minute automation service claims eligible tasks with an ownership token, recovers processing locks older than ten minutes, and revalidates the configured bucket, owner-scoped key, and the user’s live references immediately before deletion. A re-referenced object is cancelled; a bucket/key boundary violation is blocked for immediate operator review; transient provider failures retry with exponential backoff capped at 24 hours. Completed and cancelled task receipts expire after 30 days. Provider messages and object keys are not included in owner alerts.

The operations monitor fails its deletion check when a held or pending task is overdue by 15 minutes, a processing lock is stale by 15 minutes, or a retrying task reaches three attempts. Before launch:

1. Replace and clear every supported personal-file type using synthetic accounts.
2. Confirm the new database reference is usable and the old object is no longer referenced.
3. Observe the old object’s task move through `pending`/`processing` to `deleted`.
4. Simulate an S3 deletion failure, confirm retry/backoff and a single owner alert, restore S3 access, and confirm recovery.
5. Simulate a process stop after `held`; confirm reconciliation cancels a still-referenced object and activates an unreferenced object.
6. Retain task IDs, states, timestamps, and alert evidence. Do not place object keys or personal data in the launch record.

Any stuck queue, deletion of a live reference, unmonitored retry, or five-minute alert flood is stop-ship.

## Account data removal and retained records

Self-serve account deactivation is an access and participation control, not erasure. The admin “Process Data Removal” action is available only after deactivation and has two evidence-backed outcomes:

- An unused account with no matter, job, application, message, case file, task, payout, platform-income, case-event, or safety-block record can be fully removed. Authentication/support drafts and other ephemeral account data are cleared, but immutable admin/audit evidence remains keyed to the former object ID.
- An account with any durable relationship is minimized. Direct identifiers, public/professional profile fields, credentials, MFA/provider links, preferences, and personal profile files are removed or queued for deletion. The stable user ID, role, signup policy acknowledgements, Stripe references needed for retained financial workflows, and related matter/financial/audit/safety records remain. The account cannot sign in or be re-enabled.

The workflow must never delete completed Matters, messages, Matter files, tasks, payouts, platform income, disputes, or audit logs merely because an account is removed. Admin and director accounts cannot use this bulk path; they require separately approved operational offboarding. The admin UI reports “minimized” and “fully removed” separately and does not call minimization “permanent deletion.”

Before launch, counsel and the data owner must approve the record-category retention matrix and legal-hold procedure. Test one unused account and one account with completed financial history, verify the returned mode and audit event, and confirm no retained ledger count changes. Any destructive cascade into a matter or financial record is stop-ship.

## Legal-document deployment gate

Production web startup verifies that the Terms and Privacy files exactly match the counsel-approved SHA-256 digests. Set these Render secrets only from the signed approval record:

- `LEGAL_COUNSEL_APPROVAL_ID`
- `LEGAL_APPROVED_TERMS_SHA256`
- `LEGAL_APPROVED_PRIVACY_SHA256`

The version variables in `render.yaml` must match `backend/utils/legalDocuments.js`. Run `npm run check:legal` to print the candidate versions and hashes. After counsel approves those exact files, store the reference and digests, then run `npm run certify:legal` from an authorized environment. Changing either document invalidates the digest and intentionally prevents production startup until the new version is reviewed, recorded, and configured.

Do not put privileged legal advice or the approval document itself in application logs or source control. The launch record should contain the approval reference, versions, hashes, approver role, and approval time.
