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

## Automate with cron (example)
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
