"use strict";

const fs = require("node:fs");
const path = require("node:path");

function checkLocalBackupStatus({ statusFile, root = path.resolve(__dirname, ".."), maxAgeHours = 36, now = Date.now() }) {
  let status;
  try { status = JSON.parse(fs.readFileSync(statusFile, "utf8")); }
  catch { return { ok: false, code: "backup_status_missing", message: "Local backup status is missing or unreadable." }; }
  if (status?.status !== "ok") return { ok: false, code: "backup_last_run_failed", message: "Last backup run did not succeed." };
  const completedAt = Date.parse(status.completedAt);
  const ageMs = Number(now) - completedAt;
  if (!Number.isFinite(ageMs) || ageMs < -60000) return { ok: false, code: "backup_timestamp_invalid", message: "Local backup completion time is invalid or in the future." };
  if (!Number.isFinite(Number(maxAgeHours)) || Number(maxAgeHours) <= 0) return { ok: false, code: "backup_max_age_invalid", message: "Backup freshness requires a positive maximum age." };
  if (ageMs > Number(maxAgeHours) * 3600000) return { ok: false, code: "backup_stale", message: "Local backup is stale." };
  let archive;
  try {
    if (typeof status.outPath !== "string" || !status.outPath) throw new Error("Missing archive path");
    archive = fs.lstatSync(path.resolve(root, status.outPath));
  } catch { return { ok: false, code: "backup_archive_missing", message: "The recorded local backup archive is missing or unreadable." }; }
  if (!archive.isFile() || archive.isSymbolicLink() || (archive.mode & 0o077)) return { ok: false, code: "backup_archive_unsafe", message: "The local backup must be an owner-only regular archive file." };
  if (archive.size <= 0 || !Number.isSafeInteger(status.sizeBytes) || archive.size !== status.sizeBytes) return { ok: false, code: "backup_archive_size_mismatch", message: "Local backup archive size does not match its completion record." };
  return { ok: true, code: "backup_ok", message: "Recent local backup archive and completion record verified; restore verification is separate." };
}

module.exports = { checkLocalBackupStatus };
