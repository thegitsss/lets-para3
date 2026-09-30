const { letterEmail, button } = require("./layout");
// Account lifecycle mail: inline styles and system-font fallbacks for email clients.
const RESET_PASSWORD_MINUTES = 60;
const EMAIL_VERIFICATION_MINUTES = 60;
const escape = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function platformUrl(path) {
  const base = new URL(process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || 'https://www.lets-paraconnect.com');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid account email origin');
  return new URL(path, base.origin).href;
}

function accountEmail({ subject, title, paragraphs, action, note = '', greeting = 'Hello,' }) {
  if (action) {
    const url = new URL(action.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid account email action URL');
  }
  const html = letterEmail(`<p>${escape(greeting)}</p>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}${action ? button(action.url, action.label) : ''}${note ? `<p>${escape(note)}</p>` : ''}`, { title: subject });
  return { subject, html, text: [title, greeting, ...paragraphs, action ? `${action.label}: ${action.url}` : '', note].filter(Boolean).join('\n\n') };
}

function passwordReset(url) {
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid account email action URL');
  const subject = 'Reset your LPC password';
  const expiry = `This link expires in ${RESET_PASSWORD_MINUTES} minutes and can only be used once.`;
  const note = 'If you didn’t request a password reset, you can ignore this email. Your password will stay the same.';
  const intro = 'We received a request to reset the password for your LPC account. No changes have been made to your account yet.';
  const html = letterEmail(`<p>Hello,</p><p>${intro}</p><p>You can choose a new password using the button below:</p>${button(url, 'Reset your password')}<p>${expiry}</p><p>${note}</p>`, { title: subject });
  return { subject, html, text: `Let’s-ParaConnect\n\nHello,\n\n${intro}\n\nReset your password: ${url}\n\n${expiry}\n\n${note}\n\n— The LPC team` };
}

function emailVerification(user, url) {
  const pending = user?.status !== 'approved';
  return accountEmail({ subject: 'Verify your email', title: 'Verify your email.', paragraphs: ['Confirm this email address for your Let’s-ParaConnect account.', ...(pending ? ['Email verification is separate from application approval. We’ll email you when your application has been reviewed.'] : [])], action: { label: 'Verify email', url }, note: `This link expires in ${EMAIL_VERIFICATION_MINUTES} minutes. If you didn’t request this, you can ignore this email.` });
}
function applicationReceived(user) {
  return accountEmail({ subject: 'Your LPC application was received', title: 'Application received.', paragraphs: ['We’ve received your application to join Let’s-ParaConnect. We’ll email you when it has been reviewed.', user?.emailVerified ? 'Your email is already verified. You can sign in once your application is approved.' : 'Please confirm your address using the separate verification email. You can sign in once your application is approved.'] });
}
function applicationApproved(user, loginUrl = platformUrl('/login.html')) {
  const attorney = user?.role === 'attorney';
  const firstName = String(user?.firstName || '').trim();
  return accountEmail({
    subject: 'Welcome to Let’s-ParaConnect',
    title: 'Welcome to Let’s-ParaConnect!',
    greeting: firstName ? `Hello ${firstName},` : 'Hello,',
    paragraphs: [
      attorney
        ? 'Welcome to Let’s-ParaConnect! Your account is ready, and we’re glad you’re here.'
        : 'Welcome to Let’s-ParaConnect! Your account is ready, and we’re glad you’re joining us.',
      attorney
        ? 'When you have work to delegate, create a Matter outlining the scope, deadline, and compensation. Independent paralegals can apply, and you choose whom to work with.'
        : 'Build a profile that highlights your experience, then explore Matters that suit your skills and availability. You choose the work you’d like to pursue.',
      ...(user?.emailVerified === false ? ['Verify your email before signing in.'] : []),
    ],
    action: { label: 'Get started', url: loginUrl },
    note: attorney ? 'We’re here if you have any questions along the way.' : 'We look forward to having you on LPC.',
  });
}
function applicationDenied() {
  return accountEmail({ subject: 'Your LPC application was not approved', title: 'An update on your application.', paragraphs: ['Thank you for your interest in Let’s-ParaConnect. Your application was not approved at this time.', 'If you have questions or your qualifications change, you can contact us.'], action: { label: 'Contact LPC', url: platformUrl('/contact.html') } });
}
module.exports = { RESET_PASSWORD_MINUTES, EMAIL_VERIFICATION_MINUTES, passwordReset, emailVerification, applicationReceived, applicationApproved, applicationDenied };
