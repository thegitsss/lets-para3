const { letterEmail, button } = require("./layout");
const { accountEmailFooter } = require("./accountFooter");
const { attorneyApprovalEmail } = require('./attorneyApproval');
const editorial = require('./editorialAccount');
const { platformUrl } = require('./accountEmailUrls');
// Account lifecycle mail: inline styles and system-font fallbacks for email clients.
const RESET_PASSWORD_MINUTES = 60;
const escape = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));


function accountEmail({ subject, title, paragraphs, action, secondaryAction, note = '', greeting = 'Hello,' }) {
  for (const target of [action, secondaryAction].filter(Boolean)) {
    const url = new URL(target.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid account email action URL');
  }
  const notes = Array.isArray(note) ? note : note ? [note] : [];
  const footer = accountEmailFooter();
  const html = letterEmail(`<p>${escape(greeting)}</p>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}${action ? button(action.url, action.label) : ''}${secondaryAction ? `<p><a data-lpc-secondary="true" href="${escape(secondaryAction.url)}">${escape(secondaryAction.label)}</a></p>` : ''}${notes.map(p => `<p>${escape(p)}</p>`).join('')}`, { title: subject, footer: footer.html });
  return { subject, html, text: [title, greeting, ...paragraphs, action ? `${action.label}: ${action.url}` : '', secondaryAction ? `${secondaryAction.label}: ${secondaryAction.url}` : '', ...notes, footer.text].filter(Boolean).join('\n\n') };
}

function passwordReset(url) {
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid account email action URL');
  const subject = 'Reset your LPC password';
  const expiry = `This link expires in ${RESET_PASSWORD_MINUTES} minutes and can only be used once.`;
  const note = 'If you didn’t request a password reset, you can ignore this email. Your password will stay the same.';
  const footer = accountEmailFooter();
  const intro = 'We received a request to reset the password for your LPC account. No changes have been made to your account yet.';
  const html = letterEmail(`<p>Hello,</p><p>${intro}</p><p>You can choose a new password using the button below:</p>${button(url, 'Reset your password')}<p>${expiry}</p><p>${note}</p>`, { title: subject, footer: footer.html });
  return { subject, html, text: `Let’s-ParaConnect\n\nHello,\n\n${intro}\n\nReset your password: ${url}\n\n${expiry}\n\n${note}\n\n— The LPC team\n\n${footer.text}` };
}

function emailVerification(user, url, options) {
  return editorial.verification(user, url, options);
}
function applicationReceived(user, options) {
  return editorial.receipt(user, options);
}
function applicationEmailVerified(user, options) {
  return editorial.verified(user, options);
}
function applicationApproved(user, loginUrl = platformUrl('/login.html'), verificationUrl = platformUrl('/verify-email.html'), options = {}) {
  if (user?.role === 'attorney') return attorneyApprovalEmail(user, loginUrl, verificationUrl, options);
  return editorial.paralegalApproval(user, loginUrl, verificationUrl, options);
}

function applicationDenied(user) {
  return accountEmail({ subject: 'Your LPC application was not approved', title: 'An update on your application.', paragraphs: ['Thank you for your interest in Let’s-ParaConnect. Your application was not approved at this time.', 'If you have questions or your qualifications change, you can contact us.'], action: { label: user?.role === 'paralegal' ? 'Contact Us' : 'Contact LPC', url: platformUrl('/contact.html') } });
}
module.exports = { RESET_PASSWORD_MINUTES, passwordReset, emailVerification, applicationReceived, applicationEmailVerified, applicationApproved, applicationDenied };
