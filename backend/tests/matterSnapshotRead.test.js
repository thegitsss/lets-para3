let readStableMatterSnapshot, ApiError;
beforeAll(async () => {
  ({ readStableMatterSnapshot } = await import('../../frontend/assets/scripts/utils/matter-snapshot-read.mjs'));
  ({ ApiError } = await import('../../frontend/assets/scripts/attorney-v2/api-client.mjs'));
});
const conflict = code => Object.assign(new Error('Snapshot changed'), { status: 409, code });

test('the Attorney API preserves the financial conflict for bounded recovery', async () => {
  const error = new ApiError('request', 409, 'MATTER_FINANCIAL_CHANGED');
  expect(error.code).toBe('MATTER_FINANCIAL_CHANGED');
  const value = { current: true }, read = jest.fn().mockRejectedValueOnce(error).mockResolvedValue(value);
  expect(await readStableMatterSnapshot(read)).toBe(value); expect(read).toHaveBeenCalledTimes(2);
  expect(new ApiError('request', 409, 'MATTER_UNRECOGNIZED_CONFLICT').code).toBeUndefined();
});

test.each(['WORKSPACE_CHANGED', 'APPLICATION_REVIEW_CHANGED', 'MATTER_FINANCIAL_CHANGED'])('%s rechecks once through the original reader', async code => {
  const value = { title: 'Fresh authorized Matter' }, read = jest.fn().mockRejectedValueOnce(conflict(code)).mockResolvedValue(value);
  expect(await readStableMatterSnapshot(read)).toBe(value); expect(read).toHaveBeenCalledTimes(2);
});
test('the paralegal error envelope also rechecks a financial snapshot', async () => {
  const read = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Changed'), { status: 409, payload: { code: 'MATTER_FINANCIAL_CHANGED' } })).mockResolvedValue({ current: true });
  expect(await readStableMatterSnapshot(read)).toEqual({ current: true }); expect(read).toHaveBeenCalledTimes(2);
});
test('a persistent snapshot conflict stops after the second read', async () => {
  const error = conflict('MATTER_FINANCIAL_CHANGED'), read = jest.fn().mockRejectedValue(error);
  await expect(readStableMatterSnapshot(read)).rejects.toBe(error); expect(read).toHaveBeenCalledTimes(2);
});
test.each([401, 403, 404, 503])('%s does not trigger a snapshot recheck', async status => {
  const error = Object.assign(new Error('Unavailable'), { status, code: 'MATTER_FINANCIAL_CHANGED' }), read = jest.fn().mockRejectedValue(error);
  await expect(readStableMatterSnapshot(read)).rejects.toBe(error); expect(read).toHaveBeenCalledTimes(1);
});
test('an unrecognized conflict is not retried', async () => {
  const error = conflict('UNRECOGNIZED_CONFLICT'), read = jest.fn().mockRejectedValue(error);
  await expect(readStableMatterSnapshot(read)).rejects.toBe(error); expect(read).toHaveBeenCalledTimes(1);
});
test('access loss on the recheck is returned without another attempt', async () => {
  const error = Object.assign(new Error('Revoked'), { status: 403 }), read = jest.fn().mockRejectedValueOnce(conflict('MATTER_FINANCIAL_CHANGED')).mockRejectedValue(error);
  await expect(readStableMatterSnapshot(read)).rejects.toBe(error); expect(read).toHaveBeenCalledTimes(2);
});
test.each(['abort', 'account change'])('%s during the first read prevents a recheck', async kind => {
  const controller = new AbortController(); let current = true;
  const error = conflict('MATTER_FINANCIAL_CHANGED'), read = jest.fn(async () => { if (kind === 'abort') controller.abort(); else current = false; throw error; });
  await expect(readStableMatterSnapshot(read, { signal: controller.signal, isCurrent: () => current })).rejects.toBe(error); expect(read).toHaveBeenCalledTimes(1);
});
