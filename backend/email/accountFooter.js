const { escape } = require('./layout');

// Account mail uses the existing LPC support, legal and social footer links.
function accountEmailFooter() {
  const base = new URL(process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || 'https://www.lets-paraconnect.com');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid account email origin');
  const contact = new URL('/contact.html', base.origin).href;
  const privacy = new URL('/privacy.html', base.origin).href;
  const linkedin = 'https://www.linkedin.com/company/lets-paraconnect/';
  const copyright = `© ${new Date().getFullYear()} Let’s-ParaConnect`;
  return {
    html: `<p style="margin:0 0 12px;">Need help?<br>Email us at <a href="mailto:help@lets-paraconnect.com">help@lets-paraconnect.com</a> or reply to this email.</p><p style="margin:0 0 12px;"><a href="${escape(contact)}">Contact Us</a> &nbsp;|&nbsp; <a href="${escape(privacy)}">Privacy Policy</a> &nbsp;|&nbsp; <a href="${linkedin}">LinkedIn</a></p><p style="margin:0;">${escape(copyright)}</p>`,
    text: `Need help? Email help@lets-paraconnect.com or reply to this email.\nContact Us: ${contact}\nPrivacy Policy: ${privacy}\nLinkedIn: ${linkedin}\n${copyright}`,
  };
}
module.exports = { accountEmailFooter };
