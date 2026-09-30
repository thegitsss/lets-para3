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
    expect(mail.html.match(/<a /g)).toHaveLength(1);
    expect(mail.html).not.toMatch(/<img|unsubscribe|linkedin/i);
  });
  test('rejects unsafe action protocols', () => {
    expect(() => emails.passwordReset('javascript:alert(1)')).toThrow();
  });
  test('verification does not imply application approval', () => {
    expect(emails.emailVerification({ status: 'pending' }, url).text).toContain('separate from application approval');
    expect(emails.emailVerification({ status: 'approved' }, url).text).not.toContain('application approval');
  });
  test('receipt distinguishes verified and unverified applicants without inviting premature sign-in', () => {
    const pending = emails.applicationReceived({ emailVerified: false });
    expect(pending.text).toContain('separate verification email');
    expect(pending.html).not.toContain('<a ');
    expect(emails.applicationReceived({ emailVerified: true }).text).toContain('already verified');
  });
  test.each(['attorney', 'paralegal'])('approval provides role-appropriate next steps for %s', role => {
    const mail = emails.applicationApproved({ role, emailVerified: true }, 'https://example.test/login.html');
    expect(mail.text).toContain(role === 'attorney' ? 'create a Matter outlining the scope' : 'explore Matters');
    expect(mail.text).toContain('https://example.test/login.html');
    expect(mail.html.match(/<a /g)).toHaveLength(1);
  });
  test('denial offers contact without inventing a reason', () => {
    const mail = emails.applicationDenied();
    expect(mail.text).toContain('not approved at this time');
    expect(mail.text).toContain('/contact.html');
    expect(mail.html.match(/<a /g)).toHaveLength(1);
  });
});


test('approval welcomes new users without suggesting prior Matter activity or publishing their profile', () => {
  const attorney = emails.applicationApproved({ role: 'attorney', emailVerified: true });
  const paralegal = emails.applicationApproved({ role: 'paralegal', emailVerified: true });
  expect(attorney.text).not.toMatch(/if you have not|if you haven.t|already posted/i);
  expect(paralegal.text).toContain('You choose the work you’d like to pursue.');
  expect(paralegal.text).not.toMatch(/profile is (now )?(live|visible)|then browse/i);
});
