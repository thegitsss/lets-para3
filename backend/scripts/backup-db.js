#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();

const { sendOwnerAlert } = require("../utils/opsAlerting");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("Missing MONGO_URI (or MONGO_URL/DATABASE_URL).");
  process.exit(1);
}

const backupDir = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || "14");
const statusFile = process.env.BACKUP_STATUS_FILE || path.join(backupDir, "last-backup.json");
const startedAt = new Date().toISOString();
const stamp = new Date()
  .toISOString()
  .replace(/\..+/, "")
  .replace(/[-:]/g, "")
  .replace("T", "_");
const fileName = `backup_${stamp}.archive.gz`;
const outPath = path.join(backupDir, fileName);

fs.mkdirSync(backupDir, { recursive: true });

function writeStatus(payload) {
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, `${JSON.stringify(payload, null, 2)}\n`);
}

async function notifyFailure(message, extra = {}) {
  await sendOwnerAlert("LPC attention needed: backup did not finish", [
    "The scheduled database backup did not complete successfully.",
    message,
    `Backup directory: ${backupDir}`,
    `Output file: ${outPath}`,
  ], extra).catch(() => {});
}

writeStatus({
  status: "running",
  startedAt,
  backupDir,
  outPath,
});

const args = ["--uri", MONGO_URI, `--archive=${outPath}`, "--gzip"];
const dump = spawn("mongodump", args, { stdio: "inherit" });

dump.on("error", (err) => {
  const message =
    err?.code === "ENOENT"
      ? "mongodump not found. Install MongoDB Database Tools first."
      : err?.message || String(err);
  writeStatus({
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    backupDir,
    outPath,
    error: message,
  });
  void notifyFailure(message);
  if (err?.code === "ENOENT") {
    console.error("mongodump not found. Install MongoDB Database Tools first.");
  } else {
    console.error("Backup failed:", err?.message || err);
  }
  process.exit(1);
});

dump.on("exit", (code) => {
  if (code !== 0) {
    const message = `mongodump exited with code ${code}`;
    writeStatus({
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      backupDir,
      outPath,
      error: message,
    });
    void notifyFailure(message);
    console.error(`mongodump exited with code ${code}`);
    process.exit(code || 1);
  }
  console.log(`Backup saved: ${outPath}`);
  pruneOldBackups();
  const stat = fs.statSync(outPath);
  writeStatus({
    status: "ok",
    startedAt,
    completedAt: new Date().toISOString(),
    backupDir,
    outPath,
    sizeBytes: stat.size,
    retentionDays,
  });
  if (String(process.env.BACKUP_ALERT_ON_SUCCESS || "").toLowerCase() === "true") {
    void sendOwnerAlert("LPC update: backup completed successfully", [
      "The scheduled database backup completed successfully.",
      `Output file: ${outPath}`,
      `Size: ${stat.size} bytes`,
    ]).catch(() => {});
  }
});

function pruneOldBackups() {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  try {
    const files = fs.readdirSync(backupDir);
    files.forEach((file) => {
      if (!file.startsWith("backup_") || !file.endsWith(".archive.gz")) return;
      const fullPath = path.join(backupDir, file);
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) return;
      if (stats.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
        removed += 1;
      }
    });
  } catch (err) {
    console.warn("Backup retention check failed:", err?.message || err);
    return;
  }

  if (removed) {
    console.log(`Removed ${removed} old backup${removed === 1 ? "" : "s"}.`);
  }
}
