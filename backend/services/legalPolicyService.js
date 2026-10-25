const LegalDocumentVersion = require("../models/LegalDocumentVersion");
const { getCurrentPolicyDocuments } = require("../utils/legalDocuments");

async function preserveCurrentPolicyDocuments() {
  for (const { kind, version, hash, html } of Object.values(getCurrentPolicyDocuments())) {
    try {
      const _id = `${kind}:${hash}`;
      await LegalDocumentVersion.updateOne({ _id }, { $setOnInsert: { _id, kind, version, hash, html } }, { upsert: true });
    } catch (error) {
      // Two simultaneous first views may race the unique index. Both must
      // observe the same stored copy before recording any acceptance.
      if (error?.code !== 11000) throw error;
    }
    const saved = await LegalDocumentVersion.findById(`${kind}:${hash}`).lean();
    if (!saved || saved.version !== version || saved.html !== html) throw new Error("Policy copy could not be preserved.");
  }
}

module.exports = { preserveCurrentPolicyDocuments };
