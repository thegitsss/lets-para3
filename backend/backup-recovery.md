# Backup and recovery

This project uses MongoDB. Backups are created with `mongodump` and restored with `mongorestore`.

## Requirements
- Install MongoDB Database Tools (provides `mongodump` and `mongorestore`).
- Set `MONGO_URI` (or `MONGO_URL`/`DATABASE_URL`) for the target database.

## Run a backup
```
cd backend
MONGO_URI="mongodb://127.0.0.1:27017/lets-para" \
BACKUP_DIR="./backups" \
BACKUP_RETENTION_DAYS=14 \
node scripts/backup-db.js
```

Optional environment variables:
- `BACKUP_DIR`: where backups are written (default: `backend/backups`)
- `BACKUP_RETENTION_DAYS`: delete backups older than this many days (default: `14`)
- `BACKUP_STATUS_FILE`: JSON status file written after each backup run (default: `backend/backups/last-backup.json`)
- `BACKUP_ALERT_ON_SUCCESS=true`: optionally email the owner on successful backup completion

Each backup run now writes a machine-readable status artifact containing:

- `status`: `running`, `ok`, or `failed`
- `startedAt`
- `completedAt`
- `outPath`
- `sizeBytes` on success
- `error` on failure

## Automate with cron (example)
Use this only on a server or local machine you control directly. Do not use this as the primary production backup strategy on Render.

```
0 2 * * * /usr/bin/env MONGO_URI="mongodb://127.0.0.1:27017/lets-para" BACKUP_DIR="/var/backups/lets-para" BACKUP_RETENTION_DAYS=14 node /path/to/backend/scripts/backup-db.js >> /var/log/lets-para-backup.log 2>&1
```

## Daily backups (macOS launchd template)
Template: `backend/ops/launchd/com.letsparaconnect.mongo-backup.plist`

Replace these placeholders:
- `__PROJECT_ROOT__` (absolute path to repo)
- `__MONGO_URI__` (Atlas connection string)
- `__BACKUP_DIR__` (backup folder)
- `__LOG_PATH__` (log file path)

Then load it:
```
launchctl load -w ~/Library/LaunchAgents/com.letsparaconnect.mongo-backup.plist
```

## Daily backups (cron template)
Template: `backend/ops/cron.backup.example`

Replace placeholders, then add the line to your crontab:
```
crontab -e
```

## Automated monitoring

You can run the ops monitor on a short schedule to catch:

- `/api/health` failures
- stale or failed backups
- recent failed Stripe webhook events

Example:

```
cd backend
OPS_HEALTHCHECK_URL="https://www.lets-paraconnect.com/api/health" \
MONGO_URI="mongodb://127.0.0.1:27017/lets-para" \
OWNER_ALERT_EMAILS="you@example.com" \
node scripts/ops-monitor.js
```

The monitor writes local state to `backend/ops/monitor-state.json` by default and exits non-zero when checks fail.

### Render production guidance

If production runs on Render, use Render's deployment model instead of machine cron:

- Set the web service health check path to `/api/health`.
- Turn on Render email or Slack notifications for unhealthy service, healthy-again, deploy failure, and cron job failure events.
- Use Mongo Atlas automated backups as the primary production backup system.
- Treat `backup-db.js` as a manual export and restore-drill tool, not the primary Render backup system.
- If you run `ops-monitor.js` as a Render Cron Job, set:
  - `MONITOR_REQUIRE_BACKUP=false`
  - `MONITOR_PERSIST_STATE=false`
  - `MONITOR_SEND_OWNER_ALERTS=false`

Those settings avoid false assumptions about persistent local disk on Render and prevent duplicate alerts when Render itself is already sending service-level notifications.

Templates:

- cron: `backend/ops/cron.ops-monitor.example`
- macOS launchd: `backend/ops/launchd/com.letsparaconnect.ops-monitor.plist`
- systemd: `backend/ops/systemd/lpc-ops-monitor.service.example`

## Restore (safe default)
To avoid overwriting an active database, restore into a new database first by changing the database name in `MONGO_URI`.

```
mongorestore --uri "mongodb://127.0.0.1:27017/lets-para-restore" --archive=/path/to/backup_YYYYMMDD_HHMMSS.archive.gz --gzip
```

Once validated, point the app to the restored database.

## One‑click restore (script)
```
cd backend
MONGO_URI="mongodb://127.0.0.1:27017/lets-para-restore" \
BACKUP_FILE="/path/to/backup_YYYYMMDD_HHMMSS.archive.gz" \
CONFIRM_RESTORE=YES \
node scripts/restore-db.js
```

Optional:
- `RESTORE_DROP=true` to drop existing collections before restore (destructive).
- `RESTORE_NS_INCLUDE` to explicitly include matching namespaces from the archive when restoring to a different database name.
- `RESTORE_NS_FROM` and `RESTORE_NS_TO` to remap namespaces when restoring an archive into a different database name.

Example namespace remap from production into a safe restore database:

```
cd backend
MONGO_URI="mongodb://127.0.0.1:27017/lets-para-restore" \
BACKUP_FILE="/path/to/backup_YYYYMMDD_HHMMSS.archive.gz" \
CONFIRM_RESTORE=YES \
RESTORE_NS_INCLUDE="letspara.*" \
RESTORE_NS_FROM="letspara.*" \
RESTORE_NS_TO="letspara_restore_20260401.*" \
node scripts/restore-db.js
```
