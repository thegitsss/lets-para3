const { letterEmail, button } = require("./layout");
const { accountEmailFooter } = require("./accountFooter");
// Account lifecycle mail: inline styles and system-font fallbacks for email clients.
const RESET_PASSWORD_MINUTES = 60;
const escape = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function platformUrl(path) {
  const base = new URL(process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || 'https://www.lets-paraconnect.com');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid account email origin');
  return new URL(path, base.origin).href;
}

function accountEmail({ subject, title, paragraphs, action, note = '', greeting = 'Hello,', role }) {
  if (action) {
    const url = new URL(action.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid account email action URL');
  }
  const notes = Array.isArray(note) ? note : note ? [note] : [];
  const footer = accountEmailFooter({ role });
  const html = letterEmail(`<p>${escape(greeting)}</p>${paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}${action ? button(action.url, action.label) : ''}${notes.map(p => `<p>${escape(p)}</p>`).join('')}`, { title: subject, footer: footer.html, footerOutside:true, brandUrl:platformUrl('/') });
  return { subject, html, text: [title, greeting, ...paragraphs, action ? `${action.label}: ${action.url}` : '', ...notes, footer.text].filter(Boolean).join('\n\n') };
}

function passwordReset(url, user = {}) {
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid account email action URL');
  const subject = 'Reset your LPC password';
  const expiry = `This link expires in ${RESET_PASSWORD_MINUTES} minutes and can only be used once.`;
  const note = 'If you didn’t request a password reset, you can ignore this email. Your password will stay the same.';
  const footer = accountEmailFooter(user);
  const intro = 'We received a request to reset the password for your LPC account. No changes have been made to your account yet.';
  const html = letterEmail(`<p>Hello,</p><p>${intro}</p><p>You can choose a new password using the button below:</p>${button(url, 'Reset your password')}<p>${expiry}</p><p>${note}</p>`, { title: subject, footer: footer.html, footerOutside:true, brandUrl:platformUrl('/') });
  return { subject, html, text: `Let’s-ParaConnect\n\nHello,\n\n${intro}\n\nReset your password: ${url}\n\n${expiry}\n\n${note}\n\n— The LPC team\n\n${footer.text}` };
}

function emailVerification(user, url) {
  const pending = user?.status !== 'approved';
  return accountEmail({
    role:user?.role, subject: 'Verify your email',
    title: 'Verify your email.',
    paragraphs: ["Verify your email address for Let's-ParaConnect"],
    action: { label: 'Verify email', url },
    note: ['This link can only be used once. If you didn’t request this, you can ignore this email.', ...(pending ? ['Email verification is separate from application approval. We’ll email you when your application has been reviewed.'] : [])],
  });
}
function applicationReceived(user) {
  return accountEmail({ role:user?.role, subject: 'Your LPC application was received', title: 'Application received.', paragraphs: ['We’ve received your application to join Let’s-ParaConnect. We’ll email you when it has been reviewed.', user?.emailVerified ? 'Your email is already verified. You can sign in once your application is approved.' : 'Please confirm your email address using the separate verification email. You can sign in once your email is verified and your application is approved.'], ...(user?.role === 'paralegal' && user?.emailVerified ? { action: { label: 'Learn more about our application review', url: platformUrl('/paralegal-admission.html') } } : {}) });
}
function applicationEmailVerified(user = {role:"paralegal"}) {
  return accountEmail({
    role:user?.role, subject: 'Your email is verified',
    title: 'Your email is verified.',
    paragraphs: ['Thanks for confirming your email. Your application is saved. We’ll review it and email you when your account is ready.'],
    action: { label: 'Learn more about our application review', url: platformUrl('/paralegal-admission.html') },
  });
}
function applicationApproved(user, loginUrl = platformUrl('/login.html'), verificationUrl = platformUrl('/verify-email.html')) {
  const attorney = user?.role === 'attorney';
  const firstName = String(user?.firstName || '').trim();
  return accountEmail({
    role:user?.role, subject: 'Welcome to Let’s-ParaConnect',
    title: 'Welcome to Let’s-ParaConnect!',
    greeting: firstName ? `Hello ${firstName},` : 'Hello,',
    paragraphs: [
      attorney ? 'Welcome to Let’s-ParaConnect!'
        : user?.emailVerified === false ? 'Your application is approved, and we’re glad you’re joining LPC.'
        : 'Welcome to Let’s-ParaConnect! Your application is approved and your account is ready. We’re glad you’re joining us.',
      attorney
        ? 'When you have work to delegate, create a Matter outlining the scope, deadline, and compensation. Independent paralegals can apply, and you choose whom to work with.'
        : 'Build a profile that highlights your experience, then explore Matters that suit your skills and availability. You choose the work you’d like to pursue.',
      ...(user?.emailVerified === false ? ['Verify your email before signing in.'] : []),
    ],
    action: user?.emailVerified === false
      ? { label: 'Verify your email', url: verificationUrl }
      : { label: 'Sign in', url: loginUrl },
    note: attorney ? 'We’re here if you have any questions along the way.' : 'We look forward to having you on LPC.',
  });
}
function applicationDenied(user) {
  return accountEmail({ role:user?.role, subject: 'Your LPC application was not approved', title: 'An update on your application.', paragraphs: ['Thank you for your interest in Let’s-ParaConnect. Your application was not approved at this time.', 'If you have questions or your qualifications change, you can contact us.'], action: { label: user?.role === 'paralegal' ? 'Contact Us' : 'Contact LPC', url: platformUrl('/contact.html') } });
}
module.exports = { RESET_PASSWORD_MINUTES, passwordReset, emailVerification, applicationReceived, applicationEmailVerified, applicationApproved, applicationDenied };
