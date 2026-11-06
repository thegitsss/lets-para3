"use strict";
const crypto = require("node:crypto");
const PART_BYTES = 16 * 1024 * 1024;
async function plan(artifact) {
  const parts = [];
  for (let start = 0; start < artifact.size; start += PART_BYTES) {
    const end = Math.min(artifact.size - 1, start + PART_BYTES - 1), md5 = crypto.createHash("md5");
    for await (const chunk of artifact.open({ start, end })) md5.update(chunk);
    parts.push({ part_number: parts.length + 1, content_length: end - start + 1, content_md5: md5.digest("base64") });
  }
  return parts;
}
function instructions(remote, expected, transferUrl) {
  if (!Array.isArray(remote.multiparts) || remote.multiparts.length !== expected.length || expected.length > 50) throw new Error("Clio multipart instructions are incomplete");
  return expected.map(part => {
    const matches = remote.multiparts.filter(value => value.part_number === part.part_number);
    if (matches.length !== 1) throw new Error("Clio multipart identity changed");
    const value = matches[0], headers = {};
    for (const entry of [...(remote.putHeaders || []), ...(value.put_headers || [])]) {
      const name = String(entry.name).toLowerCase();
      if (!["content-type", "content-length", "content-md5", "x-amz-server-side-encryption", "x-amz-server-side-encryption-aws-kms-key-id"].includes(name) || typeof entry.value !== "string" || /[\r\n]/.test(entry.value)) throw new Error("Clio upload headers are unsupported");
      headers[name] = entry.value;
    }
    if (headers["content-length"] && headers["content-length"] !== String(part.content_length) || headers["content-md5"] && headers["content-md5"] !== part.content_md5) throw new Error("Clio upload checksum or size changed");
    headers["content-length"] = String(part.content_length); headers["content-md5"] = part.content_md5;
    const url = transferUrl(value.put_url), parsed = new URL(url);
    if (parsed.searchParams.has("partNumber") && Number(parsed.searchParams.get("partNumber")) !== part.part_number) throw new Error("Clio part number changed");
    return { ...part, url, headers, start: (part.part_number - 1) * PART_BYTES, end: (part.part_number - 1) * PART_BYTES + part.content_length - 1 };
  });
}
module.exports = { plan, instructions, PART_BYTES };
