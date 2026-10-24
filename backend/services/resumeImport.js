'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { extractSuggestions } = require('./resumeSuggestions');
const MAX_BYTES = 10 * 1024 * 1024;
const DISCLOSURE = 'LPC reads your résumé on its server. No external AI provider receives it. Temporary extraction copies aren’t saved. Your résumé attachment stays unchanged.';
function failure(code, status, message) { return Object.assign(new Error(message), { code, status }); }
async function extractFile(file, { signal } = {}) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw failure('FILE_SIZE', 400, 'Choose a résumé up to 10 MB.');
  const mime = String(file.mimetype || '').toLowerCase();
  const binary = !mime || mime === 'application/octet-stream';
  const pdf = /\.pdf$/i.test(file.originalname || '') && (mime === 'application/pdf' || binary);
  const doc = /\.doc$/i.test(file.originalname || '') && (mime === 'application/msword' || binary);
  const docx = /\.docx$/i.test(file.originalname || '') && (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || binary);
  const txt = mime === 'text/plain' && /\.txt$/i.test(file.originalname || '');
  const validSignature = pdf ? buffer.subarray(0, 5).toString() === '%PDF-' : doc ? buffer.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])) : docx ? buffer.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04])) : txt;
  if (!validSignature) throw failure('UNSUPPORTED_FILE', 415, 'Choose a valid PDF or DOC résumé, up to 10 MB.');
  let text;
  if (txt) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); if (text.includes('\0')) throw new Error(); }
    catch { throw failure('UNREADABLE_FILE', 422, 'This résumé could not be read. Try a readable PDF or Word document, or enter details manually.'); }
  } else {
    text = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, pdf ? 'resumePdfWorker.cjs' : 'resumeWordWorker.cjs'), { workerData: buffer, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
      // Suppress parser diagnostics: document text must never enter application logs.
      worker.stdout.resume(); worker.stderr.resume();
      const unreadable = () => failure('UNREADABLE_FILE', 422, 'This résumé could not be read. Try a readable PDF or Word document, or enter details manually.');
      let outcome = null, stopping = false;
      const stop = (error, text) => {
        if (!outcome || error) outcome = { error, text };
        if (stopping) return;
        stopping = true;
        // Admission remains owned until the physical exit event, including
        // cancellation and a successful result awaiting termination.
        worker.terminate().catch(() => { outcome = { error: unreadable() }; });
      };
      const cancel = () => stop(unreadable());
      const timer = setTimeout(cancel, 10000);
      signal?.addEventListener('abort', cancel, { once: true });
      worker.once('message', result => stop(result?.error ? unreadable() : null, result?.text));
      worker.once('error', () => stop(unreadable()));
      worker.once('exit', () => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (!outcome || outcome.error) reject(outcome?.error || unreadable());
        else resolve(outcome.text);
      });
      if (signal?.aborted) cancel();
    });
  }
  if (!text?.trim() || text.length > 100000) throw failure('UNREADABLE_FILE', 422, 'No readable text was found. Scanned or encrypted résumés may need manual entry.');
  return extractSuggestions(text);
}
module.exports = { MAX_BYTES, DISCLOSURE, extractFile, failure };
