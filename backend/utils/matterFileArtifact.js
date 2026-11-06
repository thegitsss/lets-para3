"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Transform } = require("node:stream"), { pipeline } = require("node:stream/promises");
const { createMatterFileInspector } = require("./fileSecurity");
const { MAX_MATTER_FILE_BYTES } = require("./matterFilePolicy");

// Provider-to-provider work may need a replayable body. Use a private, bounded
// spool instead of holding the original plus another concatenated copy in RAM.
async function stageMatterFile(body, { mimeType, filename, expectedBytes, maximum = MAX_MATTER_FILE_BYTES, signal } = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lpc-file-transfer-"));
  const target = path.join(directory, "original");
  const cleanup = () => fs.promises.rm(directory, { recursive: true, force: true });
  const hash = crypto.createHash("sha256");
  let size = 0;
  try {
    const inspector = createMatterFileInspector({ mimeType, filename, maximum });
    await fs.promises.chmod(directory, 0o700);
    const inspect = new Transform({ transform(chunk, _encoding, done) { try { inspector.write(chunk); hash.update(chunk); size += chunk.length; done(null, chunk); } catch (error) { done(error); } } });
    await pipeline(Buffer.isBuffer(body) ? require("node:stream").Readable.from(body) : body, inspect, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }), ...(signal ? [{ signal }] : []));
    inspector.finish(expectedBytes);
    return { path: target, size, sha256: hash.digest("hex"), open: options => fs.createReadStream(target, options), cleanup };
  } catch (error) { body?.destroy?.(); await cleanup(); throw error; }
}
module.exports = { stageMatterFile };
