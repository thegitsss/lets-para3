const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { assertBoundedOleHeader } = require('../services/resumeOleHeaderGuard.cjs');

const validDoc = () => fs.readFileSync(path.join(__dirname, 'fixtures/resume-import/synthetic.doc'));

test('PDF text extraction works without the denied optional native graphics build', async () => {
  const fixture = require('./fixtures/resume-import/synthetic.cjs');
  const worker = new Worker(path.join(__dirname, '../services/resumePdfWorker.cjs'), {
    workerData: fixture.pdf(), stdout: true, stderr: true,
    env: { NODE_OPTIONS: '--require ' + path.join(__dirname, 'fixtures/resume-import/no-canvas.cjs') },
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let result;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('PDF worker did not exit')); }, 10000);
      worker.once('message', value => { result = value; });
      worker.once('error', reject);
      worker.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('PDF worker exit ' + code)); });
    });
    expect(result.error).not.toBe(true);
    expect(result.text).toContain('Clio');
  } finally {
    await worker.terminate();
  }
});

test('rejects allocation-driving Word headers before the parser can allocate from them', () => {
  expect(() => assertBoundedOleHeader(validDoc())).not.toThrow();
  for (const mutate of [
    bytes => bytes.writeUInt16LE(30, 30),
    bytes => bytes.writeUInt16LE(30, 32),
    bytes => bytes.writeUInt32LE(0x7fffffff, 44),
    bytes => bytes.writeUInt32LE(0x7fffffff, 64),
    bytes => bytes.writeUInt32LE(0x7fffffff, 72),
    bytes => bytes.writeUInt32LE(0x7fffffff, 48),
  ]) {
    const bytes = validDoc();
    mutate(bytes);
    expect(() => assertBoundedOleHeader(bytes)).toThrow('Invalid compound document');
  }
});

test.each(['success', 'cancel'])('%s does not release parser ownership before physical worker exit', async mode => {
  let worker;
  let announceStop;
  let actualExit = null;
  const stopRequested = new Promise(resolve => { announceStop = resolve; });
  class HeldWorker extends Worker {
    constructor() {
      super(path.join(__dirname, 'fixtures/resume-import/held-worker.cjs'), { workerData: { mode } });
      worker = this;
      this.once('exit', code => { actualExit = code; });
    }
    terminate() { announceStop(); return new Promise(() => {}); }
    release() { return super.terminate(); }
  }
  let service;
  try {
    jest.isolateModules(() => {
      jest.doMock('node:worker_threads', () => ({ Worker: HeldWorker }));
      service = require('../services/resumeImport');
    });
  } finally {
    jest.dontMock('node:worker_threads');
  }
  const controller = new AbortController();
  let settled = false;
  const extraction = service.extractFile({
    buffer: Buffer.from('%PDF-synthetic'), mimetype: 'application/pdf', originalname: 'synthetic.pdf',
  }, { signal: controller.signal }).then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; },
  );
  try {
    if (mode === 'cancel') {
      await new Promise(resolve => worker.once('online', resolve));
      controller.abort();
    }
    await stopRequested;
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(actualExit).toBeNull();
    // Exit 1 is the expected intentional termination of this held fixture.
    expect(await worker.release()).toBe(1);
    const result = await extraction;
    expect(actualExit).toBe(1);
    if (mode === 'cancel') expect(result.error).toMatchObject({ code: 'UNREADABLE_FILE' });
    else expect(result.value.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'skills', value: 'Clio' })]));
  } finally {
    if (worker && actualExit === null) await worker.release();
    await extraction;
  }
});
