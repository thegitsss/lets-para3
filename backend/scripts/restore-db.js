#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
const BACKUP_FILE = process.env.BACKUP_FILE;
const CONFIRM_RESTORE = String(process.env.CONFIRM_RESTORE || "").toUpperCase();
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

if (CONFIRM_RESTORE !== "YES") {
  console.error("Restore blocked. Set CONFIRM_RESTORE=YES to proceed.");
  process.exit(1);
}

const args = ["--uri", MONGO_URI, `--archive=${BACKUP_FILE}`, "--gzip"];
if (RESTORE_DROP) args.push("--drop");
if (RESTORE_NS_INCLUDE) {
  args.push("--nsInclude", RESTORE_NS_INCLUDE);
}
if (RESTORE_NS_FROM && RESTORE_NS_TO) {
  args.push("--nsFrom", RESTORE_NS_FROM, "--nsTo", RESTORE_NS_TO);
}

const restore = spawn("mongorestore", args, { stdio: "inherit" });

restore.on("error", (err) => {
  if (err?.code === "ENOENT") {
    console.error("mongorestore not found. Install MongoDB Database Tools first.");
  } else {
    console.error("Restore failed:", err?.message || err);
  }
  process.exit(1);
});

restore.on("exit", (code) => {
  if (code !== 0) {
    console.error(`mongorestore exited with code ${code}`);
    process.exit(code || 1);
  }
  console.log("Restore completed.");
});
