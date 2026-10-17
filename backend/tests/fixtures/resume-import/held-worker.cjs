const { parentPort, workerData } = require('node:worker_threads');

// Stay alive after reporting success so the test can observe actual exit.
parentPort.on('message', () => {});
if (workerData.mode === 'success') {
  parentPort.postMessage({ text: 'Skills\nClio' });
}
