'use strict';

// An actual Linux output sink is required for Firefox's media clock to advance.
// This prepares runner infrastructure; it does not change application audio or tests.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(file, args, required = true) {
  const result = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 10000 });
  const value = { status: result.status, signal: result.signal, error: result.error?.code || null,
    stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
  if (required) assert.equal(value.status, 0, `${file}: ${JSON.stringify(value)}`);
  return value;
}
function wave() {
  const samples = 8000 * 30, bytes = samples * 2, buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF'); buffer.writeUInt32LE(36 + bytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
function save(file, receipt) {
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
async function cleanup(file, receipt) {
  const result = { startedUtc: new Date().toISOString(), moduleUnloaded: false, ownedDaemonStopped: false, errors: [] };
  if (Number.isInteger(receipt.moduleId)) {
    try {
      // PulseAudio removes its automatic fallback sink when a real sink appears.
      const sinks = command('pactl', ['list', 'short', 'sinks']).stdout.split('\n').map(row => row.split('\t')[1]);
      if (!receipt.ownedDaemonPid && receipt.previousDefaultSink && sinks.includes(receipt.previousDefaultSink))
        command('pactl', ['set-default-sink', receipt.previousDefaultSink]);
    } catch (error) { result.errors.push(`restore default: ${error.message}`); }
    try {
      command('pactl', ['unload-module', String(receipt.moduleId)]);
      result.moduleUnloaded = true; receipt.moduleId = null;
    } catch (error) { result.errors.push(`unload owned module: ${error.message}`); }
  }
  if (receipt.ownedDaemonPid) {
    try {
      const procFile = `/proc/${receipt.ownedDaemonPid}/cmdline`;
      if (fs.existsSync(procFile)) {
        const args = fs.readFileSync(procFile, 'utf8').split('\0').filter(Boolean);
        assert.equal(path.basename(args[0]), 'pulseaudio');
        assert(args.includes(`--log-target=file:${receipt.daemonLog}`), 'Refuse to stop an unowned process');
        process.kill(receipt.ownedDaemonPid, 'SIGTERM');
        const alive = () => {
          try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${receipt.ownedDaemonPid}/stat`, 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        };
        for (let n = 0; n < 50 && alive(); n++) await wait(100);
        assert(!alive(), 'Owned PulseAudio did not stop');
      }
      result.ownedDaemonStopped = true; receipt.ownedDaemonPid = null;
    } catch (error) { result.errors.push(`stop owned daemon: ${error.message}`); }
  }
  result.completedUtc = new Date().toISOString();
  receipt.cleanup = result; save(file, receipt);
  assert.deepEqual(result.errors, [], 'Audio cleanup requires attention'); return result;
}
async function prepare(file, receipt, browsers) {
  assert.equal(process.platform, 'linux', 'This helper is for Linux runners only');
  assert.equal(process.env.CI, 'true', 'This helper is for isolated CI only');
  assert(browsers.length && browsers.every(x => ['chromium', 'firefox', 'webkit'].includes(x)));
  receipt.startedUtc = new Date().toISOString();
  receipt.originalCallbacksChanged = false;
  receipt.selectedBrowsers = browsers;
  receipt.daemonLog = path.join(path.dirname(file), 'pulseaudio.log');
  const initial = command('pactl', ['info'], false);
  receipt.reusedExistingServer = initial.status === 0;
  if (!receipt.reusedExistingServer) {
    const child = cp.spawn('pulseaudio', ['--daemonize=no', '--exit-idle-time=-1',
      `--log-target=file:${receipt.daemonLog}`, '--log-level=info'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    receipt.ownedDaemonPid = child.pid; save(file, receipt); child.unref();
    let ready = false;
    for (let n = 0; n < 80; n++) {
      if (command('pactl', ['info'], false).status === 0) { ready = true; break; }
      await wait(100);
    }
    assert(ready, 'PulseAudio server did not become ready');
  }
  receipt.previousDefaultSink = command('pactl', ['get-default-sink']).stdout;
  receipt.sinkName = `lpc_ci_${crypto.randomBytes(8).toString('hex')}`;
  const moduleId = command('pactl', ['load-module', 'module-null-sink', `sink_name=${receipt.sinkName}`,
    'rate=48000', 'channels=2']).stdout;
  assert(/^\d+$/.test(moduleId)); receipt.moduleId = Number(moduleId); save(file, receipt);
  command('pactl', ['set-default-sink', receipt.sinkName]);
  assert.equal(command('pactl', ['get-default-sink']).stdout, receipt.sinkName);
  receipt.server = command('pactl', ['info']).stdout;
  // Diagnose the failing engine before running unchanged product callbacks.
  if (browsers.includes('firefox')) {
    const { firefox } = require(path.resolve('backend/node_modules/playwright'));
    const browser = await firefox.launch();
    const mediaErrors = [];
    try {
      const page = await browser.newPage();
      page.on('console', message => { if (/NS_ERROR_DOM_MEDIA|OnMediaSinkAudioError/.test(message.text())) mediaErrors.push(message.text()); });
      await page.setContent('<!doctype html><html><body><button>Play readiness sample</button><audio></audio></body></html>');
      await page.evaluate(src => {
        const audio = document.querySelector('audio'); audio.src = src;
        document.querySelector('button').onclick = () => {
          window.readinessPlayState = 'pending';
          audio.play().then(() => { window.readinessPlayState = 'resolved'; }, error => {
            window.readinessPlayState = 'rejected'; window.readinessPlayError = `${error.name}: ${error.message}`;
          });
        };
      }, `data:audio/wav;base64,${wave().toString('base64')}`);
      await page.locator('button').click();
      await page.waitForFunction(() => {
        if (window.readinessPlayError) throw new Error(window.readinessPlayError);
        return window.readinessPlayState === 'resolved' && document.querySelector('audio').currentTime > 0;
      }, null, { timeout: 10000 });
      receipt.firefoxReadiness = await page.evaluate(() => {
        const audio = document.querySelector('audio');
        return { currentTime: audio.currentTime, paused: audio.paused, readyState: audio.readyState,
          mediaErrorCode: audio.error?.code || null, sample: '30s-8000Hz-mono-16bit-PCM' };
      });
      assert(receipt.firefoxReadiness.currentTime > 0);
      assert.equal(receipt.firefoxReadiness.paused, false);
      assert.equal(receipt.firefoxReadiness.mediaErrorCode, null);
      assert.deepEqual(mediaErrors, []);
    } finally { await browser.close(); }
  }
  receipt.status = 'LINUX_AUDIO_READY'; receipt.completedUtc = new Date().toISOString(); save(file, receipt);
}
async function main() {
  const [mode, target] = process.argv.slice(2);
  assert(['--prepare', '--cleanup'].includes(mode)); assert(target);
  const file = path.resolve(target); const base = path.resolve('backend/test-results');
  assert(file.startsWith(base + path.sep), 'Receipt must be under the CI evidence directory');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (mode === '--cleanup') {
    if (!fs.existsSync(file)) return;
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(await cleanup(file, receipt))); return;
  }
  assert(!fs.existsSync(file), 'Refuse to overwrite audio preparation evidence');
  const receipt = { schemaVersion: 1 };
  try { await prepare(file, receipt, JSON.parse(process.env.SELECTED_BROWSERS_JSON || '[]')); }
  catch (error) {
    receipt.status = 'LINUX_AUDIO_PREPARATION_FAILED'; receipt.error = error.message; save(file, receipt);
    try { await cleanup(file, receipt); } catch (cleanupError) { receipt.cleanupError = cleanupError.message; save(file, receipt); }
    throw error;
  }
  console.log(JSON.stringify({ status: receipt.status, firefoxReadiness: receipt.firefoxReadiness || null }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { wave };
