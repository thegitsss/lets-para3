"use strict";

const verifyToken = require("./verifyToken");
const MAX_MATTER_DOCUMENT_BYTES = 20 * 1024 * 1024;

async function readMatterDocumentBody(body) {
  const chunks = [];
  let size = 0;
  const append = chunk => {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_MATTER_DOCUMENT_BYTES) {
      throw Object.assign(new Error("This document exceeds the Matter file size limit."), {
        status: 413, statusCode: 413, code: "FILE_TOO_LARGE", publicCode: "DOWNLOAD_TOO_LARGE",
      });
    }
    chunks.push(bytes);
  };
  try {
    if (typeof body?.[Symbol.asyncIterator] === "function") {
      for await (const chunk of body) append(chunk);
    } else if (typeof body?.transformToByteArray === "function") {
      append(await body.transformToByteArray());
    } else {
      throw new Error("Document storage returned no readable body.");
    }
    return Buffer.concat(chunks, size);
  } finally {
    body?.destroy?.();
  }
}

async function revalidateMatterDocumentActor(req) {
  if (!req.auth?.token) return null;
  const current = {
    headers: { authorization: `Bearer ${req.auth.token}` },
    cookies: {}, method: req.method, query: req.query, params: req.params,
  };
  let authenticated = false;
  const deny = { status() { return this; }, json() {} };
  await verifyToken(current, deny, error => { if (error) throw error; authenticated = true; });
  if (!authenticated || !current.user?.approved || current.user.role !== req.user?.role
    || current.user.id !== req.user?.id || current.authSessionId !== req.authSessionId) return null;
  return current;
}

module.exports = { readMatterDocumentBody, revalidateMatterDocumentActor };
