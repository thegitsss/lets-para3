const base = require('playwright/test');
const test = base.test.extend({
  directorNativeEvidence: [async ({ browser }, use, info) => {
    const errors = [], create = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await create(...args);
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      return context;
    };
    try { await use(); }
    finally {
      browser.newContext = create;
      await info.attach('director-original-native-observer.json', { body: Buffer.from(JSON.stringify({ errors })), contentType: 'application/json' });
      base.expect(errors).toEqual([]);
    }
  }, { auto: true }],
});
module.exports = { test, expect: base.expect };
