"use strict";

const fs = require("fs");
const path = require("path");

const AUTH_STATE_DIRECTORY = path.resolve(__dirname, ".auth");
const AUTH_STATE_FILE_NAMES = new Set([
  "control-room-admin.json",
  "director.json",
  "support-attorney.json",
  "support-paralegal.json",
]);

function assertStorageStatePath(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (
    path.dirname(resolved) !== AUTH_STATE_DIRECTORY ||
    !AUTH_STATE_FILE_NAMES.has(path.basename(resolved))
  ) {
    throw new Error("Playwright storage state must use an approved synthetic-auth path.");
  }
  return resolved;
}

function prepareAuthStateDirectory() {
  fs.mkdirSync(AUTH_STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(AUTH_STATE_DIRECTORY);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Playwright auth-state directory must be a real directory.");
  }
  fs.chmodSync(AUTH_STATE_DIRECTORY, 0o700);
}

async function writeStorageStateOwnerOnly(context, filePath) {
  const resolved = assertStorageStatePath(filePath);
  prepareAuthStateDirectory();
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error("Playwright auth-state file must not be a symbolic link.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await context.storageState({ path: resolved });
  const stateFile = fs.lstatSync(resolved);
  if (!stateFile.isFile() || stateFile.isSymbolicLink()) {
    throw new Error("Playwright auth state was not written as a regular file.");
  }
  fs.chmodSync(resolved, 0o600);
}

function removeStorageState(filePath) {
  const resolved = assertStorageStatePath(filePath);
  try {
    const stateFile = fs.lstatSync(resolved);
    if (!stateFile.isFile() && !stateFile.isSymbolicLink()) {
      throw new Error("Refusing to remove a non-file Playwright auth-state path.");
    }
    fs.unlinkSync(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

module.exports = {
  AUTH_STATE_DIRECTORY,
  assertStorageStatePath,
  removeStorageState,
  writeStorageStateOwnerOnly,
};
