const fs = require('node:fs');
const path = require('node:path');
const { escape } = require('./layout');
const { actionUrl, platformUrl } = require('./accountEmailUrls');

const confirmationTemplate = fs.readFileSync(path.join(__dirname, 'confirmation.html'), 'utf8');
const approvalTemplate = fs.readFileSync(path.join(__dirname, 'paralegalApproval.html'), 'utf8');
const socialLinks = [
  ['linkedin', 'LinkedIn', 'https://www.linkedin.com/company/lets-paraconnect/'],
  ['facebook', 'Facebook', 'https://www.facebook.com/LetsParaConnect/'],
  ['instagram', 'Instagram', 'https://www.instagram.com/letsparaconnect/'],
];
const socialImages = socialLinks.map(([name]) => ({
  filename: `${name}-icon.png`,
  path: path.join(__dirname, 'assets', 'attorney-approval', `${name}-icon.png`),
  cid: `account-${name}@lets-paraconnect.com`,
  contentType: 'image/png',
  contentDisposition: 'inline',
}));
const matterImage = {
  filename: 'browse-matters.png',
  path: path.join(__dirname, 'assets', 'paralegal-approval', 'browse-matters.png'),
  cid: 'paralegal-approval-matters@lets-paraconnect.com',
  contentType: 'image/png',
  contentDisposition: 'inline',
};

function greeting(user) {
  const firstName = String(user?.firstName || '').trim();
  return firstName ? `Hello ${firstName},` : 'Hello,';
}

function message({ subject, template = confirmationTemplate, values, paragraphs, user, images = socialImages, preview = false }) {
  const year = new Date().getFullYear();
  const replacements = { ...values, GREETING: escape(greeting(user)), YEAR: String(year) };
  let html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`Missing account email value: ${key}`);
    return replacements[key];
  });
  if (preview) {
    for (const image of images) {
      html = html.replaceAll(`cid:${image.cid}`, `data:image/png;base64,${fs.readFileSync(image.path).toString('base64')}`);
    }
  }
  const text = [
    subject, greeting(user), ...paragraphs,
    'Questions? Reply to this email or contact help@lets-paraconnect.com',
    ...socialLinks.map(([, label, url]) => `${label}: ${url}`),
    `© ${year} Let’s-ParaConnect`,
  ].join('\n\n');
  return { subject, html, text, ...(preview ? {} : { attachments: images.map(image => ({ ...image })) }) };
}

function receipt(user, { preview = false } = {}) {
  const attorney = user?.role === 'attorney';
  const verified = user?.emailVerified === true;
  const noun = attorney ? 'registration' : 'application';
  const title = attorney ? 'Registration received.' : 'Application received.';
  const intro = attorney ? 'Thanks for registering with Let’s-ParaConnect.'
    : 'We’ve received your application to join Let’s-ParaConnect. We’ll email you when it has been reviewed.';
  const section = verified ? 'Email already verified.' : 'Confirm your email.';
  const detail = `${verified ? '' : 'Look for a separate verification email and confirm your email address. '}You can sign in after your ${noun} is approved.`;
  const reviewUrl = !attorney && verified ? platformUrl('/paralegal-admission.html') : '';
  const review = reviewUrl ? `<a data-lpc-secondary="true" href="${escape(reviewUrl)}" style="display:inline-block;padding:12px 0;color:#466db0;font:400 15px/20px 'Sarabun',Arial,Helvetica,sans-serif;text-decoration:underline">About application review</a>` : '';
  const details = `<tr><td class="pad" style="padding:30px 36px 34px"><h2 style="font:400 28px/1.2 'Cormorant Garamond',Baskerville,'Times New Roman',serif;letter-spacing:-.6px;color:#1a2230;margin-bottom:13px">${section}</h2>` +
    `<p style="font:400 15px/1.65 'Sarabun',Arial,Helvetica,sans-serif;color:#435871">${detail}</p>${review}</td></tr>`;
  return message({
    subject: `${title.slice(0, -1)} — Let’s-ParaConnect`, user, preview,
    values: {
      TITLE: escape(title), HEADLINE: attorney ? 'Registration<br>received.' : 'Application<br>received.',
      PREHEADER: `Your ${noun} is saved. We’ll email you after it has been reviewed.`,
      INTRO: escape(intro), INTRO_BOTTOM: '0', DETAILS: details,
    },
    paragraphs: [intro, section, detail, ...(reviewUrl ? [`About application review: ${reviewUrl}`] : [])],
  });
}

function verification(user, url, { preview = false } = {}) {
  const verifyUrl = actionUrl(url);
  const pending = user?.status === 'pending';
  const canCorrectSignup = pending && user?.emailVerified !== true;
  const correctionLabel = canCorrectSignup ? 'Use a different email address' : 'Manage email in Settings';
  const portal = user?.role === 'attorney' ? 'attorney-v2.html' : 'paralegal-v2.html';
  const settings = `/login.html?next=${encodeURIComponent(`/${portal}#/settings?tab=account`)}`;
  const correctionUrl = platformUrl(canCorrectSignup ? '/change-signup-email.html' : settings);
  const intro = 'Please confirm this is the email address you want to use for Let’s-ParaConnect.';
  const singleUse = 'This link can only be used once. If you didn’t request this, you can ignore this email.';
  const reviewNote = 'Email verification is separate from application approval. We’ll email you when your application has been reviewed.';
  const details = `<tr><td class="pad" style="padding:26px 36px 0"><table role="presentation" width="100%"><tr><td bgcolor="#1a2230" style="background:#1a2230;border-radius:6px;text-align:center;mso-padding-alt:18px 15px;"><a class="primary" data-lpc-action="true" href="${escape(verifyUrl)}" style="display:block;padding:18px 15px;font:400 17px/22px 'Sarabun',Arial,Helvetica,sans-serif;text-align:center;text-decoration:none;color:#fff">Verify email &nbsp; →</a></td></tr></table></td></tr>` +
    `<tr><td class="pad" style="padding:8px 36px 0"><a data-lpc-secondary="true" href="${escape(correctionUrl)}" style="display:inline-block;padding:12px 0;min-height:20px;color:#466db0;text-decoration:underline;font:400 15px/20px 'Sarabun',Arial,Helvetica,sans-serif">${escape(correctionLabel)}</a></td></tr>` +
    `<tr><td class="pad" style="padding:22px 36px 34px;font:400 14px/1.65 'Sarabun',Arial,Helvetica,sans-serif;color:#506681"><p>${singleUse}</p>${pending ? `<p style="margin-top:16px">${reviewNote}</p>` : ''}</td></tr>`;
  return message({
    subject: 'Verify your email', user, preview,
    values: {
      TITLE: 'Verify your email', HEADLINE: 'Confirm your<br>email address.',
      PREHEADER: 'Confirm your email address for Let’s-ParaConnect.',
      INTRO: escape(intro), INTRO_BOTTOM: '0', DETAILS: details,
    },
    paragraphs: [intro, `Verify email: ${verifyUrl}`, `${correctionLabel}: ${correctionUrl}`, singleUse, ...(pending ? [reviewNote] : [])],
  });
}

function verified(user, { preview = false } = {}) {
  const intro = 'Thanks for confirming your email address.';
  return message({
    subject: 'Your email is verified', user, preview,
    values: {
      TITLE: 'Your email is verified', HEADLINE: 'Email<br>verified.',
      PREHEADER: 'Your email address has been confirmed.',
      INTRO: intro, INTRO_BOTTOM: '34px', DETAILS: '',
    },
    paragraphs: [intro],
  });
}

function paralegalApproval(user, loginUrl, verificationUrl, { preview = false } = {}) {
  const login = actionUrl(loginUrl);
  const confirm = user?.emailVerified === false ? actionUrl(verificationUrl) : '';
  const confirmationCopy = 'You can sign in now. Confirm your email address so Let’s-ParaConnect messages reach the right inbox.';
  const confirmation = confirm ? `<p style="margin:20px 0 0;font:400 15px/1.65 'Sarabun',Arial,Helvetica,sans-serif;color:#354b65">${confirmationCopy}</p><p style="margin:0"><a data-lpc-secondary="true" href="${escape(confirm)}" style="display:inline-block;padding:12px 0;color:#466db0;text-decoration:underline;font:400 15px/20px 'Sarabun',Arial,Helvetica,sans-serif">Confirm email address</a></p>` : '';
  return message({
    subject: 'Welcome to Let’s-ParaConnect', template: approvalTemplate, user, preview,
    values: { LOGIN_URL: escape(login), VERIFICATION: confirmation },
    images: [matterImage, ...socialImages],
    paragraphs: [
      'You’re in.',
      'Your application is approved. Welcome to Let’s-ParaConnect.\nYour workspace is ready whenever you are.',
      `Sign in to your workspace: ${login}`,
      ...(confirm ? [confirmationCopy, `Confirm email address: ${confirm}`] : []),
      'Your experience. Your next opportunity.',
      'Illustrative Matters only—not live listings.',
      'Find work that fits.\nExplore Matters that suit your skills and availability. Review the scope, deadline, and compensation before applying.',
      'Put your experience forward.\nBuild a profile that highlights your experience, skills, and availability. Your dashboard will guide you through any remaining setup before you apply.',
      'You choose the work you’d like to pursue.',
    ],
  });
}

module.exports = { receipt, verification, verified, paralegalApproval };
