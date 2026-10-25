const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkLocalBackupStatus } = require('../utils/localBackupStatus');

let root;
const now = Date.now();
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lpc-backup-check-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function check(overrides = {}) {
  return checkLocalBackupStatus({ root, statusFile: path.join(root, 'status.json'), now, ...overrides });
}
function record(overrides = {}) {
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({ status: 'ok', completedAt: new Date(now).toISOString(), outPath: 'backup.archive.gz', sizeBytes: 5, ...overrides }), { mode: 0o600 });
}
function archive() { fs.writeFileSync(path.join(root, 'backup.archive.gz'), 'abcde', { mode: 0o600 }); }
test('requires an actual archive as well as a successful status record', () => {
  expect(check()).toMatchObject({ ok: false, code: 'backup_status_missing' });
  record(); expect(check()).toMatchObject({ ok: false, code: 'backup_archive_missing' });
  archive(); expect(check()).toMatchObject({ ok: true, code: 'backup_ok' });
});
test('detects a deleted or truncated backup instead of preserving a green status', () => {
  record(); archive(); fs.truncateSync(path.join(root, 'backup.archive.gz'), 0);
  expect(check()).toMatchObject({ ok: false, code: 'backup_archive_size_mismatch' });
  fs.unlinkSync(path.join(root, 'backup.archive.gz'));
  expect(check()).toMatchObject({ ok: false, code: 'backup_archive_missing' });
});
test('rejects a symlink, directory or exposed archive', () => {
  record(); archive(); fs.renameSync(path.join(root, 'backup.archive.gz'), path.join(root, 'actual'));
  fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'backup.archive.gz'));
  expect(check()).toMatchObject({ ok: false, code: 'backup_archive_unsafe' });
  fs.unlinkSync(path.join(root, 'backup.archive.gz')); fs.mkdirSync(path.join(root, 'backup.archive.gz'));
  expect(check()).toMatchObject({ ok: false, code: 'backup_archive_unsafe' });
  fs.rmdirSync(path.join(root, 'backup.archive.gz')); archive(); fs.chmodSync(path.join(root, 'backup.archive.gz'), 0o644);
  expect(check()).toMatchObject({ ok: false, code: 'backup_archive_unsafe' });
});
test.each([
  [{ status: 'failed' }, 'backup_last_run_failed'],
  [{ completedAt: 'invalid' }, 'backup_timestamp_invalid'],
  [{ completedAt: new Date(now + 3600000).toISOString() }, 'backup_timestamp_invalid'],
  [{ completedAt: new Date(now - 40 * 3600000).toISOString() }, 'backup_stale'],
  [{ sizeBytes: 20 }, 'backup_archive_size_mismatch'],
])('rejects invalid completion evidence: %j', (changes, code) => {
  record(changes); archive(); expect(check()).toMatchObject({ ok: false, code });
});
test('rejects invalid freshness settings and keeps archive paths out of results', () => {
  record(); archive(); expect(check({ maxAgeHours: NaN })).toMatchObject({ ok: false, code: 'backup_max_age_invalid' });
  expect(JSON.stringify(check())).not.toContain(root);
});
