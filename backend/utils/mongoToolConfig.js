"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function createMongoToolConfig(uri, { prefix = "lpc-mongo-tool-" } = {}) {
  const normalizedUri = String(uri || "").trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(normalizedUri)) {
    throw new Error("A valid MongoDB connection URI is required.");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, "credentials.yml");
  fs.writeFileSync(filePath, `uri: ${JSON.stringify(normalizedUri)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
  let removed = false;
  return Object.freeze({
    filePath,
    cleanup() {
      if (removed) return;
      removed = true;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  });
}

module.exports = {
  createMongoToolConfig,
};
