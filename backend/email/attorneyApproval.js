const fs = require('node:fs');
const path = require('node:path');
const { escape } = require('./layout');
const { actionUrl } = require('./accountEmailUrls');

// The approved Canva composition remains live HTML; only the product capture
// and provider/social marks are images. CID assets travel with the message.
const template = fs.readFileSync(path.join(__dirname, 'attorneyApproval.html'), 'utf8');
const assetNames = ['new-matter', 'google-calendar', 'microsoft-outlook', 'linkedin-icon', 'facebook-icon', 'instagram-icon'];
const assets = assetNames.map(name => ({
  filename: `${name}.png`,
  path: path.join(__dirname, 'assets', 'attorney-approval', `${name}.png`),
  cid: `attorney-approval-${name}@lets-paraconnect.com`,
  contentType: 'image/png',
  contentDisposition: 'inline',
}));

function attorneyApprovalEmail(user, loginUrl, verificationUrl, { preview = false } = {}) {
  const login = actionUrl(loginUrl);
  const confirm = user?.emailVerified === false ? actionUrl(verificationUrl) : '';
  const firstName = String(user?.firstName || '').trim();
  const greeting = firstName ? `Hello ${firstName},` : 'Hello,';
  const year = new Date().getFullYear();
  const confirmation = confirm ? `<p style="margin:20px 0 0;font:400 15px/1.65 'Sarabun',Arial,Helvetica,sans-serif;color:#354b65">You can sign in now. Confirm your email address so Let’s-ParaConnect messages reach the right inbox.</p><p style="margin:0"><a data-lpc-secondary="true" href="${escape(confirm)}" style="display:inline-block;padding:12px 0;color:#466db0;text-decoration:underline;font:400 15px/20px 'Sarabun',Arial,Helvetica,sans-serif">Confirm email address</a></p>` : '';
  const values = { GREETING: escape(greeting), LOGIN_URL: escape(login), VERIFICATION: confirmation, YEAR: String(year) };
  let html = template.replace(/\{\{(GREETING|LOGIN_URL|VERIFICATION|YEAR)\}\}/g, (_match, key) => values[key]);
  // The protected admin preview cannot resolve MIME content IDs in a browser.
  if (preview) {
    for (const asset of assets) html = html.replaceAll(`cid:${asset.cid}`, `data:image/png;base64,${fs.readFileSync(asset.path).toString('base64')}`);
  }
  const text = [
    'You’re in.', greeting,
    'Your application is approved. Welcome to Let’s-ParaConnect.\nYour workspace is ready whenever you are.',
    `Sign in to your workspace: ${login}`,
    ...(confirm ? ['You can sign in now. Confirm your email address so Let’s-ParaConnect messages reach the right inbox.', `Confirm email address: ${confirm}`] : []),
    'A clear brief. A better beginning.',
    'Say it. Shape it. Make it a Matter.\nDictate your instructions, then review and edit the notes.\nOrganize instructions and selected files into a working checklist you can review.',
    'Bring your tools with you.\nConnect Google Calendar or Microsoft Outlook to bring Matter dates into your schedule.',
    'Connections are optional. Product view shows sample content.',
    'Questions? Reply to this email or contact help@lets-paraconnect.com',
    'LinkedIn: https://www.linkedin.com/company/lets-paraconnect/\nFacebook: https://www.facebook.com/LetsParaConnect/\nInstagram: https://www.instagram.com/letsparaconnect/',
    `© ${year} Let’s-ParaConnect`,
  ].join('\n\n');
  return { subject: 'Welcome to Let’s-ParaConnect', html, text, ...(preview ? {} : { attachments: assets.map(asset => ({ ...asset })) }) };
}

module.exports = { attorneyApprovalEmail };
