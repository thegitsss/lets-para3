const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const State = require('../models/AutomationCycleState');
const { recordAutomationCycle, readAutomationCycleStatus } = require('../services/automationCycleStatus');
beforeAll(connect); afterAll(closeDatabase); beforeEach(clearDatabase);
test('missing, completed, stale and running evidence remain distinct', async () => {
  expect((await readAutomationCycleStatus()).status).toBe('unknown');
  await recordAutomationCycle(async () => {
    expect((await readAutomationCycleStatus()).status).toBe('running');
    return { ok: true, paused: false, failures: [] };
  });
  expect((await readAutomationCycleStatus()).status).toBe('completed');
  expect((await readAutomationCycleStatus({ now: new Date(Date.now() + 16 * 60000) })).status).toBe('stale');
});
test('maintenance pause differs from failure to read controls', async () => {
  await recordAutomationCycle(async () => ({ ok: true, paused: true, pauseReason: 'maintenance_mode' }));
  expect((await readAutomationCycleStatus()).status).toBe('paused');
  await recordAutomationCycle(async () => ({ ok: false, paused: true, pauseReason: 'settings_unavailable', failures: [{ name: 'automationControl', error: { message: 'private internals' } }] }));
  const result = await readAutomationCycleStatus();
  expect(result).toMatchObject({ status: 'failed', failedTasks: ['automationControl'] });
  expect(JSON.stringify(result)).not.toContain('private internals');
});
test('thrown execution failures are recorded and remain failures to the caller', async () => {
  await expect(recordAutomationCycle(async () => { throw new Error('Synthetic failure'); })).rejects.toThrow('Synthetic failure');
  expect((await readAutomationCycleStatus()).status).toBe('failed');
});
test('an older concurrent run cannot overwrite newer execution evidence', async () => {
  let finishOld;
  const old = recordAutomationCycle(() => new Promise(resolve => { finishOld = resolve; }));
  while (!finishOld) await new Promise(resolve => setTimeout(resolve, 5));
  await recordAutomationCycle(async () => ({ ok: false, failures: [{ name: 'newerFailure' }] }));
  finishOld({ ok: true });
  await old;
  expect((await readAutomationCycleStatus())).toMatchObject({ status: 'failed', failedTasks: ['newerFailure'] });
  expect(await State.countDocuments({})).toBe(1);
});
