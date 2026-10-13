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

Never point a drill at production. Provision an isolated non-production Atlas cluster with separately scoped credentials, then inject its URI as `RESTORE_MONGO_URI` through an approved secret-injection mechanism. The restore script deliberately ignores the application’s `MONGO_URI`, `MONGO_URL` and `DATABASE_URL`, and does not load `.env` automatically. Use an absolute path to a regular, non-symlink archive file.

```sh
BACKUP_FILE=/absolute/path/to/backup_YYYYMMDD_HHMMSS.archive.gz \
CONFIRM_RESTORE=ISOLATED_NON_PRODUCTION \
node scripts/restore-db.js
```

Optional namespace controls:

- `RESTORE_NS_INCLUDE` limits restored namespaces.
- `RESTORE_NS_FROM` and `RESTORE_NS_TO` must be provided together to remap namespaces. Use a cluster URI without a database path for remapping, and set `authSource` explicitly where necessary. A database path can silently filter the archive before renaming, so the script rejects that combination. See [MongoDB namespace restoration](https://www.mongodb.com/docs/database-tools/mongorestore/mongorestore-examples/).
- `RESTORE_DROP=true` is destructive and additionally requires `CONFIRM_RESTORE_DROP=DROP_ISOLATED_TARGET`.

The restore stops on a tool error. A zero exit code alone does not prove any documents were restored: verify expected collection counts, representative values and indexes in the isolated target.

The restore script uses the same ephemeral credential-file boundary as the backup script. After completion, verify representative users, matters, indexes, payment ledgers, payouts, audit records, and application startup; record RPO/RTO evidence; then destroy the isolated cluster through the approved infrastructure workflow.

## Production evidence

A launch record must link:

1. Atlas backup policy/retention and encryption configuration for the exact production cluster.
2. A fresh successful snapshot check from the LPC operations monitor.
3. An isolated restore drill with source snapshot, target identifier, start/end times, verification results, RPO/RTO, operator, and cleanup evidence.
4. A controlled stale/missing snapshot alert and recovery notification.

See `docs/production-operations.md`, `../LAUNCH_CHECKLIST.md`, and `../docs/RELEASE_GATES.md`. A local archive or passing script alone is not production attestation.
