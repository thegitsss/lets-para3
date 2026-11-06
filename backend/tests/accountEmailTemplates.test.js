const emails = require('../email/accountTemplates');

describe('account email content and destinations', () => {
  const url = 'https://example.test/reset-password.html?token=preview&source=email';
  test('reset includes a usable plain-text link and accurate expiration and single-use guidance', () => {
    const mail = emails.passwordReset(url);
    expect(mail.text).toContain(url);
    expect(mail.text).toContain(`${emails.RESET_PASSWORD_MINUTES} minutes`);
    expect(mail.text).toContain('only be used once');
    expect(mail.text).toContain('ignore this email');
    expect(mail.html).toContain('token=preview&amp;source=email');
    expect(mail.html.match(/data-lpc-action="true"/g)).toHaveLength(1);
    expect(mail.html).not.toMatch(/unsubscribe/i);
    expect(mail.html).not.toContain('lpc-mountain.png');
    expect(mail.html).toContain('Privacy Policy');
    expect(mail.html).toContain('https://www.linkedin.com/company/lets-paraconnect/');
  });
  test('rejects unsafe action protocols', () => {
    expect(() => emails.passwordReset('javascript:alert(1)')).toThrow();
  });
  test('verification does not imply application approval', () => {
    expect(emails.emailVerification({ status: 'pending' }, url).text).toContain('separate from application approval');
    expect(emails.emailVerification({ status: 'approved' }, url).text).not.toContain('application approval');
    const mail = emails.emailVerification({ status: 'pending' }, url);
    expect(mail.text).toContain('Please confirm this is the email address you want to use for Let’s-ParaConnect.');
    expect(mail.text).toContain('only be used once');
    expect(mail.text).not.toMatch(/expires|Open the link below, then select/);
    expect(mail.html).not.toMatch(/expires|Open the link below, then select/);
    expect(mail.text.indexOf('separate from application approval')).toBeGreaterThan(mail.text.indexOf('If you didn’t request this'));
    expect(mail.text.indexOf('separate from application approval')).toBeLessThan(mail.text.indexOf('Questions?'));
    expect(mail.html.indexOf('separate from application approval')).toBeGreaterThan(mail.html.indexOf('If you didn’t request this'));
    expect(mail.html.indexOf('separate from application approval')).toBeGreaterThan(mail.html.indexOf('Verify email &nbsp; →</a>'));
  });
  test('receipt distinguishes verified and unverified applicants without inviting premature sign-in', () => {
    const pending = emails.applicationReceived({ emailVerified: false });
    expect(pending.text).toContain('Look for a separate verification email and confirm your email address.');
    expect(pending.html).toContain('Look for a separate verification email and confirm your email address.');
    expect(pending.html).not.toContain('data-lpc-action="true"');
    expect(pending.text).toContain('You can sign in after your application is approved.');
    expect(pending.text).not.toContain('once your email is verified and');
    expect(emails.applicationReceived({ emailVerified: true }).text).toContain('already verified');
  });
  test.each(['attorney', 'paralegal'])('approval provides role-appropriate next steps for %s', role => {
    const mail = emails.applicationApproved({ role, emailVerified: true }, 'https://example.test/login.html');
    expect(mail.text).toContain(role === 'attorney' ? 'Dictate your instructions, then review and edit the notes.' : 'Explore Matters');
    expect(mail.text).toContain('https://example.test/login.html');
    expect(mail.html.match(/data-lpc-action="true"/g)).toHaveLength(1);
    expect(mail.html).toContain('Sign in to your workspace &nbsp; →</a>');
    expect(mail.text).toContain(role === 'attorney' ? 'Welcome to Let’s-ParaConnect.' : 'application is approved');
  });
  test('denial offers contact without inventing a reason', () => {
    const mail = emails.applicationDenied();
    expect(mail.text).toContain('not approved at this time');
    expect(mail.text).toContain('/contact.html');
    expect(mail.html.match(/data-lpc-action="true"/g)).toHaveLength(1);
  });
});


test('approval welcomes new users without suggesting prior Matter activity or publishing their profile', () => {
  const attorney = emails.applicationApproved({ role: 'attorney', emailVerified: true });
  const paralegal = emails.applicationApproved({ role: 'paralegal', emailVerified: true });
  expect(attorney.text).not.toMatch(/if you have not|if you haven.t|already posted/i);
  expect(paralegal.text).toContain('You choose the work you’d like to pursue.');
  expect(paralegal.text).not.toMatch(/profile is (now )?(live|visible)|then browse/i);
});

test.each(['attorney', 'paralegal'])('approved unverified %s can sign in while address confirmation remains separate', role => {
  const verificationUrl = 'https://example.test/verify-email.html?token=issued-proof';
  const loginUrl = 'https://example.test/login.html';
  const mail = emails.applicationApproved({ role, emailVerified: false }, loginUrl, verificationUrl);
  const signIn = 'Sign in to your workspace &nbsp; →</a>';
  expect(mail.html).toContain(signIn);
  expect(mail.html).toContain('>Confirm email address</a>');
  expect(mail.text).toContain(loginUrl);
  expect(mail.text).toContain(verificationUrl);
  expect(mail.html.match(/data-lpc-action="true"/g)).toHaveLength(1);
  expect(mail.html).toMatch(/data-lpc-secondary="true"[^>]+style="[^"]*color:#466db0;text-decoration:underline;/);
  expect(mail.text).toContain('You can sign in now.');
  expect(mail.text).not.toContain('before signing in');
  expect(mail.html.indexOf(signIn)).toBeLessThan(mail.html.indexOf('>Confirm email address</a>'));
});

test('address confirmation retains URL safety checks', () => {
  expect(() => emails.applicationApproved({ role: 'attorney', emailVerified: false }, 'https://example.test/login.html', 'javascript:alert(1)')).toThrow(/Invalid account email action URL/);
});

test('Attorney approval preserves the complete approved email and bundles every image for delivery', () => {
  const fs = require('node:fs');
  const mail = emails.applicationApproved({ role: 'attorney', firstName: '<Maya & Co>', emailVerified: true }, 'https://example.test/login.html?from=approval&next=workspace');
  expect(mail.html).toContain('Hello &lt;Maya &amp; Co&gt;,');
  expect(mail.html).toContain('from=approval&amp;next=workspace');
  expect(require('../email/layout').letterEmail(mail.html)).toBe(mail.html);
  expect(mail.attachments).toHaveLength(6);
  expect(mail.html.match(/src="cid:/g)).toHaveLength(6);
  for (const image of mail.attachments) {
    expect(mail.html).toContain(`src="cid:${image.cid}"`);
    expect(image).toMatchObject({ contentType: 'image/png', contentDisposition: 'inline' });
    expect(fs.readFileSync(image.path).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }
  expect(mail.html).not.toMatch(/data:image|\/outputs\/|{{[A-Z_]+}}|Hello Samantha/);
  for (const [label, destination] of [
    ['LinkedIn', 'https://www.linkedin.com/company/lets-paraconnect/'],
    ['Facebook', 'https://www.facebook.com/LetsParaConnect/'],
    ['Instagram', 'https://www.instagram.com/letsparaconnect/'],
  ]) {
    expect(mail.html).toContain(`href="${destination}" aria-label="${label}"`);
    expect(mail.text).toContain(`${label}: ${destination}`);
  }
  expect(Buffer.byteLength(mail.html)).toBeLessThan(100 * 1024);
  expect(emails.applicationApproved({ role: 'paralegal', emailVerified: true }).attachments).toHaveLength(4);
});

test('protected Attorney approval preview renders the same images without MIME attachment references', () => {
  const mail = emails.applicationApproved({ role: 'attorney', emailVerified: true }, 'https://example.test/login.html', undefined, { preview: true });
  expect(mail.html.match(/src="data:image\/png;base64,/g)).toHaveLength(6);
  expect(mail.html).not.toContain('src="cid:');
  expect(mail.attachments).toBeUndefined();
});
