const crypto = require('node:crypto');
const mongoose = require('mongoose');
const IncidentNotification = require('../../models/IncidentNotification');
const sendEmail = require('../../utils/email');

// Persist before SMTP. An interrupted send has an unknown result and must not
// automatically send a second email. Definitive rejections remain retryable.
async function deliverSupportEmail({ incident, audience, channel, templateKey, subject, bodyPreview, recipientEmail, payload }) {
  const email = String(recipientEmail || '').trim().toLowerCase();
  const key = { incidentId: incident._id, audience, templateKey, recipientUserId: null, recipientEmail: email, 'payload.dedupeKey': payload.dedupeKey };
  const legacy = await IncidentNotification.findOne(key).sort({ createdAt: -1 }).lean();
  const receiptId = legacy?._id || new mongoose.Types.ObjectId(crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 24));
  await IncidentNotification.updateOne({ _id: receiptId }, { $setOnInsert: {
    incidentId: incident._id, audience, channel, templateKey, subject, bodyPreview,
    recipientEmail: email, recipientUserId: null, status: 'queued',
    payload: { ...payload, deliveryState: 'queued' },
  } }, { upsert: true });
  // An old failed receipt did not retain whether SMTP accepted the message.
  await IncidentNotification.updateOne({ _id: receiptId, status: 'failed', 'payload.deliveryState': { $exists: false } },
    { $set: { 'payload.deliveryState': 'unknown', 'payload.deliveryError': 'The previous delivery result needs provider review before resending.' } });
  await IncidentNotification.updateOne({ _id: receiptId, 'payload.deliveryState': 'sending', 'payload.leaseExpiresAt': { $lte: new Date() } },
    { $set: { status: 'failed', 'payload.deliveryState': 'unknown', 'payload.deliveryError': 'Delivery was interrupted. Check the provider record before resending.' } });
  const token = crypto.randomUUID();
  const receipt = await IncidentNotification.findOneAndUpdate({ _id: receiptId, status: { $in: ['queued', 'failed'] },
    'payload.deliveryState': { $in: ['queued', 'rejected', 'disabled'] } },
  { $set: { 'payload.deliveryState': 'sending', 'payload.claimToken': token, 'payload.leaseExpiresAt': new Date(Date.now() + 15 * 60 * 1000) } }, { returnDocument: 'after' }).lean();
  if (!receipt) return IncidentNotification.findById(receiptId);
  let status = 'failed', deliveryState = 'unknown', externalMessageId = '', deliveryError = '';
  try {
    const info = await sendEmail(email, receipt.subject, receipt.payload.emailHtml, {
      text: receipt.payload.emailText, throwOnError: true, messageId: `<incident-support-${receiptId}@paraconnect>`,
    });
    if (info?.disabled) { deliveryState = 'disabled'; deliveryError = 'Email delivery is disabled.'; }
    else if (!info?.error && info?.messageId) { status = 'sent'; deliveryState = 'accepted'; externalMessageId = String(info.messageId); }
    else { deliveryError = 'The mail provider did not confirm acceptance.'; }
  } catch (error) {
    const rejected = ['EAUTH', 'ENOTFOUND', 'ECONNREFUSED'].includes(error?.code) || (error?.responseCode >= 400 && error?.responseCode < 600);
    deliveryState = rejected ? 'rejected' : 'unknown';
    deliveryError = String(error?.message || 'Email delivery was not confirmed.').slice(0, 240);
  }
  const saved = await IncidentNotification.findOneAndUpdate({ _id: receiptId, 'payload.claimToken': token, 'payload.deliveryState': 'sending' },
    { $set: { status, externalMessageId, sentAt: status === 'sent' ? new Date() : null,
      'payload.deliveryState': deliveryState, 'payload.deliveryError': deliveryError, 'payload.claimToken': '', 'payload.leaseExpiresAt': null } }, { returnDocument: 'after' });
  if (!saved) throw new Error('Support email delivery ownership changed; check the saved receipt.');
  await mongoose.model('Incident').updateOne({ _id: incident._id }, { $set: { latestNotificationId: receiptId } });
  return saved;
}

module.exports = { deliverSupportEmail };
