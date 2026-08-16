# Backup and recovery

MongoDB Atlas Cloud Backup is LPC's production backup authority. The operations monitor verifies snapshot freshness through a read-only Atlas service account. A local `mongodump` file is only a developer-controlled export or an input to an isolated restore drill; it is not Render backup evidence.

## Manual export

Requirements:

- Install current MongoDB Database Tools (`mongodump` and `mongorestore`).
- Configure `MONGO_URI` in the ignored `backend/.env` file or an approved secret-injection mechanism. Do not place the URI in shell history, cron definitions, process arguments, logs, or source control.
- Choose a private, encrypted destination with enough capacity. `BACKUP_DIR` defaults to the ignored `backend/backups` directory.

Run from `backend/`:

```sh
npm run backup:db
```

Optional non-secret settings are `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` (default `14`), `BACKUP_STATUS_FILE`, and `BACKUP_ALERT_ON_SUCCESS=true`. The script uses a short-lived mode-0600 MongoDB Tools configuration file so credentials do not appear in the child process arguments, applies a restrictive umask, writes the archive/status file privately, and removes the credential file when the tool exits.

Do not schedule this command on Render: cron filesystems are ephemeral. Do not install the removed legacy cron/launchd templates. Production backup scheduling, retention, encryption, and snapshots belong to Atlas.

## Isolated restore drill

Never point a drill at production. Provision an isolated non-production Atlas cluster with separately scoped credentials, then configure its URI through the ignored `.env` file or approved secret injection. Use an absolute path to a regular, non-symlink archive file.

```sh
BACKUP_FILE=/absolute/path/to/backup_YYYYMMDD_HHMMSS.archive.gz \
CONFIRM_RESTORE=ISOLATED_NON_PRODUCTION \
node scripts/restore-db.js
```

Optional namespace controls:

- `RESTORE_NS_INCLUDE` limits restored namespaces.
- `RESTORE_NS_FROM` and `RESTORE_NS_TO` must be provided together to remap namespaces.
- `RESTORE_DROP=true` is destructive and additionally requires `CONFIRM_RESTORE_DROP=DROP_ISOLATED_TARGET`.

The restore script uses the same ephemeral credential-file boundary as the backup script. After completion, verify representative users, matters, indexes, payment ledgers, payouts, audit records, and application startup; record RPO/RTO evidence; then destroy the isolated cluster through the approved infrastructure workflow.

## Production evidence

A launch record must link:

1. Atlas backup policy/retention and encryption configuration for the exact production cluster.
2. A fresh successful snapshot check from the LPC operations monitor.
3. An isolated restore drill with source snapshot, target identifier, start/end times, verification results, RPO/RTO, operator, and cleanup evidence.
4. A controlled stale/missing snapshot alert and recovery notification.

See `docs/production-operations.md`, `../LAUNCH_CHECKLIST.md`, and `../docs/RELEASE_GATES.md`. A local archive or passing script alone is not production attestation.
