"use strict";

const crypto = require("crypto");

function operationFingerprint(value) {
  const material = typeof value === "string" ? value : JSON.stringify(value || {});
  return crypto.createHash("sha256").update(material).digest("hex");
}

module.exports = { operationFingerprint };
