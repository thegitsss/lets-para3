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
    expect(mail.html.match(/<img/g)).toHaveLength(3);
    expect(mail.html).not.toMatch(/unsubscribe/i);
    expect(mail.html).toContain('>Privacy</a>');
    expect(mail.html).toContain('https://www.linkedin.com/company/lets-paraconnect');
  });
  test('rejects unsafe action protocols', () => {
    expect(() => emails.passwordReset('javascript:alert(1)')).toThrow();
  });
  test('verification does not imply application approval', () => {
    expect(emails.emailVerification({ status: 'pending' }, url).text).toContain('separate from application approval');
    expect(emails.emailVerification({ status: 'approved' }, url).text).not.toContain('application approval');
    const mail = emails.emailVerification({ status: 'pending' }, url);
    expect(mail.text).toContain("Verify your email address for Let's-ParaConnect");
    expect(mail.text).toContain('only be used once');
    expect(mail.text).not.toMatch(/expires|Open the link below, then select/);
    expect(mail.html).not.toMatch(/expires|Open the link below, then select/);
    expect(mail.text.indexOf('separate from application approval')).toBeGreaterThan(mail.text.indexOf('If you didn’t request this'));
    expect(mail.text.indexOf('separate from application approval')).toBeLessThan(mail.text.indexOf('16192 Coastal Hwy'));
    expect(mail.html.indexOf('separate from application approval')).toBeGreaterThan(mail.html.indexOf('If you didn’t request this'));
    expect(mail.html.indexOf('separate from application approval')).toBeGreaterThan(mail.html.indexOf('>Verify email</a>'));
  });
  test('receipt distinguishes verified and unverified applicants without inviting premature sign-in', () => {
    const pending = emails.applicationReceived({ emailVerified: false });
    expect(pending.text).toContain('Please confirm your email address using the separate verification email.');
    expect(pending.html).toContain('Please confirm your email address using the separate verification email.');
    expect(pending.html).not.toContain('data-lpc-action="true"');
    expect(emails.applicationReceived({ emailVerified: true }).text).toContain('already verified');
  });
  test.each(['attorney', 'paralegal'])('approval provides role-appropriate next steps for %s', role => {
    const mail = emails.applicationApproved({ role, emailVerified: true }, 'https://example.test/login.html');
    expect(mail.text).toContain(role === 'attorney' ? 'create a Matter outlining the scope' : 'explore Matters');
    expect(mail.text).toContain('https://example.test/login.html');
    expect(mail.html.match(/data-lpc-action="true"/g)).toHaveLength(1);
    expect(mail.html).toContain('>Sign in</a>');
    expect(mail.text).toContain(role === 'attorney' ? 'Welcome to Let’s-ParaConnect!' : 'application is approved');
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

test('approval does not promise access before email verification', () => {
  const verificationUrl = 'https://example.test/verify-email.html?token=issued-proof';
  const mail = emails.applicationApproved({ role: 'attorney', emailVerified: false }, 'https://example.test/login.html', verificationUrl);
  expect(mail.html).toContain('>Verify your email</a>');
  expect(mail.text).toContain(verificationUrl);
  expect(mail.html).not.toContain('>Sign in</a>');
  expect(mail.text).toContain('Welcome to Let’s-ParaConnect!');
  expect(mail.text).not.toContain('account is ready');
  expect(mail.text).toContain('Verify your email before signing in.');
});
