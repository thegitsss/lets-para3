const addressParser = require('nodemailer/lib/addressparser');

const APPROVED_INBOX = 'admin@lets-paraconnect.com';

function boundaryError(code) {
  const error = new Error('Staging email is restricted to the approved test inbox.');
  error.code = code;
  // A pre-transport rejection is definite; the durable delivery owner may
  // retain the failed attempt without treating it as uncertain acceptance.
  error.responseCode = 550;
  error.command = 'RCPT TO';
  return error;
}

function addresses(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(addresses);
  if (typeof value === 'string') return addressParser(value).flatMap(addresses);
  if (value && Array.isArray(value.group)) return value.group.flatMap(addresses);
  if (value && typeof value.address === 'string') return [value.address.trim().toLowerCase()];
  throw boundaryError('STAGING_EMAIL_RECIPIENT_BLOCKED');
}

function assertStagingEmailRecipients(to, options = {}, env = process.env) {
  if (env.LPC_DEPLOYMENT_ENV !== 'staging') {
    if (env.STAGING_EMAIL_RECIPIENT) throw boundaryError('STAGING_EMAIL_CONFIGURATION_INVALID');
    return;
  }
  if (env.STAGING_EMAIL_RECIPIENT !== APPROVED_INBOX) {
    throw boundaryError('STAGING_EMAIL_CONFIGURATION_INVALID');
  }
  const recipients = [to, options.cc, options.bcc].flatMap(addresses);
  if (!recipients.length || recipients.some(address => address !== APPROVED_INBOX)) {
    throw boundaryError('STAGING_EMAIL_RECIPIENT_BLOCKED');
  }
}

module.exports = { assertStagingEmailRecipients };
