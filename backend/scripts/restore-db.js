#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createMongoToolConfig } = require("../utils/mongoToolConfig");

process.umask(0o077);

const MONGO_URI = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
const BACKUP_FILE = process.env.BACKUP_FILE;
const CONFIRM_RESTORE = String(process.env.CONFIRM_RESTORE || "").toUpperCase();
const CONFIRM_RESTORE_DROP = String(process.env.CONFIRM_RESTORE_DROP || "").toUpperCase();
const RESTORE_DROP = String(process.env.RESTORE_DROP || "").toLowerCase() === "true";
const RESTORE_NS_INCLUDE = String(process.env.RESTORE_NS_INCLUDE || "").trim();
const RESTORE_NS_FROM = String(process.env.RESTORE_NS_FROM || "").trim();
const RESTORE_NS_TO = String(process.env.RESTORE_NS_TO || "").trim();

if (!MONGO_URI) {
  console.error("Missing MONGO_URI (or MONGO_URL/DATABASE_URL).");
  process.exit(1);
}

if (!BACKUP_FILE) {
  console.error("Missing BACKUP_FILE (path to .archive.gz).");
  process.exit(1);
}

if (CONFIRM_RESTORE !== "ISOLATED_NON_PRODUCTION") {
  console.error("Restore blocked. Set CONFIRM_RESTORE=ISOLATED_NON_PRODUCTION only after verifying the target is isolated.");
  process.exit(1);
}

const resolvedBackupFile = path.resolve(BACKUP_FILE);
let backupStat;
try {
  backupStat = fs.lstatSync(resolvedBackupFile);
} catch {
  console.error("Restore blocked. BACKUP_FILE does not exist.");
  process.exit(1);
}
if (!path.isAbsolute(BACKUP_FILE) || !backupStat.isFile() || backupStat.isSymbolicLink()) {
  console.error("Restore blocked. BACKUP_FILE must be an absolute, regular, non-symlink file.");
  process.exit(1);
}
if (RESTORE_DROP && CONFIRM_RESTORE_DROP !== "DROP_ISOLATED_TARGET") {
  console.error("Restore blocked. RESTORE_DROP additionally requires CONFIRM_RESTORE_DROP=DROP_ISOLATED_TARGET.");
  process.exit(1);
}
if (Boolean(RESTORE_NS_FROM) !== Boolean(RESTORE_NS_TO)) {
  console.error("Restore blocked. RESTORE_NS_FROM and RESTORE_NS_TO must be provided together.");
  process.exit(1);
}

const mongoConfig = createMongoToolConfig(MONGO_URI, { prefix: "lpc-mongorestore-" });
process.once("exit", mongoConfig.cleanup);
const args = ["--config", mongoConfig.filePath, `--archive=${resolvedBackupFile}`, "--gzip"];
if (RESTORE_DROP) args.push("--drop");
if (RESTORE_NS_INCLUDE) {
  args.push("--nsInclude", RESTORE_NS_INCLUDE);
}
if (RESTORE_NS_FROM && RESTORE_NS_TO) {
  args.push("--nsFrom", RESTORE_NS_FROM, "--nsTo", RESTORE_NS_TO);
}

const restore = spawn("mongorestore", args, { stdio: "inherit" });

restore.on("error", (err) => {
  mongoConfig.cleanup();
  if (err?.code === "ENOENT") {
    console.error("mongorestore not found. Install MongoDB Database Tools first.");
  } else {
    console.error("Restore failed:", err?.message || err);
  }
  process.exit(1);
});

restore.on("exit", (code) => {
  mongoConfig.cleanup();
  if (code !== 0) {
    console.error(`mongorestore exited with code ${code}`);
    process.exit(code || 1);
  }
  console.log("Restore completed.");
});
