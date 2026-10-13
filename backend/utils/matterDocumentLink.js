"use strict";
const jwt = require("jsonwebtoken"), crypto = require("node:crypto");
const audience = "lpc-matter-document-link";
const digest = key => crypto.createHash("sha256").update(key).digest("hex");
function createMatterDocumentLink(req, key, { expiresIn = 60, attachment = false } = {}) {
  const token = jwt.sign({ key: digest(key), sid: req.authSessionId || "", attachment }, process.env.JWT_SECRET, { algorithm: "HS256", subject: String(req.user.id || req.user._id), audience, expiresIn });
  return `/api/uploads/view?${new URLSearchParams({ key, ticket: token })}`;
}
function verifyMatterDocumentLink(req, key) {
  if (!req.query.ticket) return null;
  try {
    const value = jwt.verify(req.query.ticket, process.env.JWT_SECRET, { algorithms: ["HS256"], audience });
    if (value.sub !== String(req.user.id || req.user._id) || value.sid !== (req.authSessionId || "") || value.key !== digest(key)) throw Error("Mismatch");
    return value;
  } catch {
    const error = new Error("This document link is expired or unavailable to this session. Open the document from its Matter.");
    error.statusCode = 403; error.code = "FILE_LINK_UNAVAILABLE"; throw error;
  }
}
module.exports = { createMatterDocumentLink, verifyMatterDocumentLink };
