const receipts = require('./attorneyReceipts');
const history = require('./attorneyReceiptHistory');
const stripe = require('../utils/stripe');

// Reuse the same ownership and financial-evidence checks as individual receipts.
async function read(req, doc) {
  if (req.user.role !== 'attorney') return [];
  const signal = AbortSignal.any([...(req.exportSignal ? [req.exportSignal] : []), AbortSignal.timeout(120000)]);
  const entries = history.inventory(doc);
  const hasPayment = doc.paymentIntentId || doc.escrowIntentId || doc.paymentReleased ||
    doc.escrowStatus === 'funded' || doc.fundingIntegrityStatus === 'verified';
  const selections = entries.filter(entry => entry.type !== 'payment' || hasPayment);
  if (selections.length > 50) throw Object.assign(new Error('This Matter has too many receipts for one download. Contact support.'), { publicCode: 'EXPORT_TOO_LARGE', status: 413 });
  const result = [];
  for (const entry of selections) {
    signal.throwIfAborted();
    const value = await receipts.read({
      ...req, receiptSignal: signal,
      query: { expectedOwnerId: String(req.user.id), receiptId: entry.id },
    }, { stripe });
    signal.throwIfAborted();
    if (['not_funded', 'payment_canceled', 'payment_failed'].includes(value.reason)) continue;
    if (value.reason !== 'available') throw Object.assign(new Error('A Matter receipt could not be verified. Review the receipts before downloading all records.'), { publicCode: 'EXPORT_RECEIPTS_UNAVAILABLE', status: 409 });
    result.push({ selectionId: entry.id, revision: value.revision,
      path: `Receipts/${entry.type}-${entry.id}.pdf`, payload: receipts.payload(value) });
  }
  return result;
}
module.exports = { read };
