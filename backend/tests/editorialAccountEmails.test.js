const fs = require('node:fs');
const emails = require('../email/accountTemplates');
const { letterEmail } = require('../email/layout');
const loginReturn = require('../../frontend/assets/scripts/utils/login-return-target');

const user = { firstName: '<Morgan & Co>', emailVerified: false, status: 'pending' };
const verifyUrl = 'https://example.test/verify-email.html?token=issued-proof&source=email';
const cases = [
  ['Attorney approval', () => emails.applicationApproved({ ...user, role: 'attorney' }), 7],
  ['Paralegal approval', () => emails.applicationApproved({ ...user, role: 'paralegal' }), 4],
  ['Attorney receipt', () => emails.applicationReceived({ ...user, role: 'attorney' }), 3],
  ['Paralegal receipt', () => emails.applicationReceived({ ...user, role: 'paralegal' }), 3],
  ['Verification', () => emails.emailVerification({ ...user, role: 'attorney' }, verifyUrl), 3],
  ['Email verified', () => emails.applicationEmailVerified(user), 3],
];

test.each(cases)('%s retains editable branding, personalization, complete content and every inline asset', (_name, create, count) => {
  const message = create();
  expect(message.html).toContain('Hello &lt;Morgan &amp; Co&gt;,');
  expect(message.html).toContain('Cormorant Garamond');
  expect(message.html).toContain('Sarabun');
  expect(message.html).toContain('Let<span style="color:#6495ed">’</span>s-ParaConnect');
  expect(message.html).toContain('color:#1a2230');
  expect(letterEmail(message.html)).toBe(message.html);
  expect(message.html).not.toMatch(/@font-face|https:\/\/fonts\.|data:image|{{[A-Z_]+}}|Hello Samantha|\/outputs\/|design-preview/);
  expect(Buffer.byteLength(message.html)).toBeLessThan(100 * 1024);
  expect(message.attachments).toHaveLength(count);
  expect(message.html.match(/src="cid:/g)).toHaveLength(count);
  for (const asset of message.attachments) {
    expect(message.html).toContain(`src="cid:${asset.cid}"`);
    expect(asset).toMatchObject({ contentDisposition: 'inline', contentType: 'image/png' });
    expect(fs.readFileSync(asset.path).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }
  for (const [label, destination] of [
    ['LinkedIn', 'https://www.linkedin.com/company/lets-paraconnect/'],
    ['Facebook', 'https://www.facebook.com/LetsParaConnect/'],
    ['Instagram', 'https://www.instagram.com/letsparaconnect/'],
  ]) {
    expect(message.html).toContain(`href="${destination}" aria-label="${label}"`);
    expect(message.text).toContain(destination);
  }
});

test('Attorney registration keeps the approved short introduction, and receipt states respect existing verification', () => {
  const mail = emails.applicationReceived({ ...user, role: 'attorney' });
  expect(mail.html).toContain('<p>Thanks for registering with Let’s-ParaConnect.</p>');
  expect(mail.html).not.toContain('Thanks for registering with Let’s-ParaConnect. We’ll email you');
  for (const role of ['attorney', 'paralegal']) {
    const verified = emails.applicationReceived({ ...user, role, emailVerified: true });
    expect(verified.text).toContain('Email already verified.');
    expect(verified.text).not.toContain('Look for a separate verification email');
    expect(verified.html).not.toContain('data-lpc-action="true"');
  }
});

test('Email verified confirms only the address and offers no application or login action', () => {
  const mail = emails.applicationEmailVerified(user);
  expect(mail.text).toContain('Thanks for confirming your email address.');
  expect(mail.text).not.toMatch(/application|review|workspace|sign in/i);
  expect(mail.html).not.toMatch(/data-lpc-action="true"|paralegal-admission|application is saved/i);
});

test('the Paralegal screenshot remains explicitly illustrative, with a prominent workspace action', () => {
  const mail = emails.applicationApproved({ ...user, role: 'paralegal' });
  expect(mail.html).toContain('Illustrative Matters only—not live listings.');
  expect(mail.html.indexOf('Sign in to your workspace')).toBeLessThan(mail.html.indexOf('Your experience.'));
  expect(mail.html.match(/data-lpc-action="true"/g)).toHaveLength(1);
});

test.each(['attorney', 'paralegal'])('%s address changes use a real Settings return, while unverified signup corrections use their dedicated form', role => {
  const pending = emails.emailVerification({ ...user, role }, verifyUrl);
  expect(pending.text).toContain('/change-signup-email.html');
  const established = emails.emailVerification({ ...user, role, status: 'approved', emailVerified: true }, verifyUrl);
  expect(established.text).toContain('Manage email in Settings');
  expect(established.text).not.toContain('/change-signup-email.html');
  const htmlUrl = established.html.match(/data-lpc-secondary="true" href="([^"]+)"/)[1].replace(/&amp;/g, '&');
  const target = new URL(htmlUrl);
  expect(loginReturn.resolve(target.searchParams.get('next'), role)).toBe(`/${role}-v2.html#/settings?tab=account`);
});

test.each(['javascript:alert(1)', 'https://name:password@example.test/verify'])('verification rejects unsafe destinations: %s', url => {
  expect(() => emails.emailVerification(user, url)).toThrow('Invalid account email action URL');
});

test('preview rendering retains the exact asset bytes while outgoing messages retain CID delivery', () => {
  const normal = emails.applicationApproved({ ...user, role: 'paralegal' });
  const preview = emails.applicationApproved({ ...user, role: 'paralegal' }, undefined, undefined, { preview: true });
  for (const image of normal.attachments) {
    expect(preview.html).toContain(`data:image/png;base64,${fs.readFileSync(image.path).toString('base64')}`);
  }
  expect(preview.attachments).toBeUndefined();
  expect(preview.html).not.toContain('src="cid:');
});
