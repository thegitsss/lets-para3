'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
// Use the Word parser's declared ZIP dependency to inspect archives first.
const wordRequire = createRequire(require.resolve('word-extractor'));
function inspectDocx(buffer) {
  return new Promise((resolve, reject) => {
    wordRequire('yauzl').fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0, size = 0, document = false, types = false;
      const fail = () => { zip.close(); reject(new Error('Invalid document')); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        count++; size += entry.uncompressedSize;
        if (count > 200 || size > 20 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1) || /vbaProject\.bin$/i.test(entry.fileName)) return fail();
        if (entry.fileName === 'word/document.xml') document = true;
        if (entry.fileName === '[Content_Types].xml') types = true;
        zip.readEntry();
      });
      zip.on('end', () => { document && types ? resolve() : reject(new Error('Invalid document')); });
      zip.readEntry();
    });
  });
}
(async () => {
  try {
    const buffer = Buffer.from(workerData);
    if (buffer.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) await inspectDocx(buffer);
    if (buffer.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'))) require('./resumeOleHeaderGuard.cjs').assertBoundedOleHeader(buffer);
    const WordExtractor = require('word-extractor');
    const document = await new WordExtractor().extract(buffer);
    const text = document.getBody({ filterUnicode: false }).replace(/\r\n?/g, '\n');
    if (!text.trim() || text.length > 100000) throw new Error();
    parentPort.postMessage({ text });
  } catch { parentPort.postMessage({ error: true }); }
})();
