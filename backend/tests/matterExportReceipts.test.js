jest.mock('../services/attorneyReceipts', () => ({ read: jest.fn(), payload: jest.fn(value => ({ title: 'Receipt', receiptId: value.selectionId })) }));
jest.mock('../utils/stripe', () => ({}));
const receipts = require('../services/attorneyReceipts');
const exportsService = require('../services/matterExportReceipts');
const req = { user: { id: 'a'.repeat(24), role: 'attorney' }, params: { caseId: 'b'.repeat(24) }, query: { revision: 'old-export-revision' } };
beforeEach(() => jest.clearAllMocks());
test('includes verified payment and withdrawal receipts using the actual owner', async () => {
  receipts.read.mockImplementation(async request => ({ reason: 'available', selectionId: request.query.receiptId, revision: 'verified' }));
  const result = await exportsService.read(req, { _id: req.params.caseId, paymentIntentId: 'pi_paid', withdrawalHistory: [{ withdrawnParalegalId: 'c'.repeat(24), payoutFinalizedAt: new Date('2026-09-01'), payoutFinalizedType: 'partial_attorney' }] });
  expect(result).toHaveLength(2);
  expect(result[0].path).toBe('Receipts/payment-payment.pdf');
  expect(result[1].path).toMatch(/^Receipts\/withdrawal-[a-f0-9]{64}\.pdf$/);
  for (const [request] of receipts.read.mock.calls) {
    expect(request.user).toBe(req.user);
    expect(request.query.expectedOwnerId).toBe(req.user.id);
    expect(request.query.revision).toBeUndefined();
  }
});
test('does not fabricate receipts for an unfunded matter', async () => {
  expect(await exportsService.read(req, { _id: req.params.caseId })).toEqual([]);
  expect(receipts.read).not.toHaveBeenCalled();
});
test('an unavailable required receipt fails instead of producing an incomplete download', async () => {
  receipts.read.mockResolvedValue({ reason: 'needs_review' });
  await expect(exportsService.read(req, { _id: req.params.caseId, paymentReleased: true })).rejects.toMatchObject({ publicCode: 'EXPORT_RECEIPTS_UNAVAILABLE' });
});
test('ownership and cancellation failures propagate without bypassing receipt checks', async () => {
  receipts.read.mockRejectedValue(Object.assign(new Error('Owner changed'), { status: 403 }));
  await expect(exportsService.read(req, { _id: req.params.caseId, paymentIntentId: 'pi_paid' })).rejects.toMatchObject({ status: 403 });
  expect(await exportsService.read({ ...req, user: { ...req.user, role: 'admin' } }, { _id: req.params.caseId, paymentIntentId: 'pi_paid' })).toEqual([]);
});
