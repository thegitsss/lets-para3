#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
if (!MONGO_URI) {
  console.error("Missing MONGO_URI (or MONGO_URL/DATABASE_URL).");
  process.exit(1);
}

const backupDir = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || "14");
const stamp = new Date()
  .toISOString()
  .replace(/\..+/, "")
  .replace(/[-:]/g, "")
  .replace("T", "_");
const fileName = `backup_${stamp}.archive.gz`;
const outPath = path.join(backupDir, fileName);

fs.mkdirSync(backupDir, { recursive: true });

const args = ["--uri", MONGO_URI, `--archive=${outPath}`, "--gzip"];
const dump = spawn("mongodump", args, { stdio: "inherit" });

dump.on("error", (err) => {
  if (err?.code === "ENOENT") {
    console.error("mongodump not found. Install MongoDB Database Tools first.");
  } else {
    console.error("Backup failed:", err?.message || err);
  }
  process.exit(1);
});

dump.on("exit", (code) => {
  if (code !== 0) {
    console.error(`mongodump exited with code ${code}`);
    process.exit(code || 1);
  }
  console.log(`Backup saved: ${outPath}`);
  pruneOldBackups();
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
