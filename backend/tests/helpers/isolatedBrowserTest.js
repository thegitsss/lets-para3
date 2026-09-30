const { test, expect } = require('playwright/test');

// Real server fixtures set process-wide secrets and load cached backend modules.
// A distinct worker fixture keeps that configuration inside its owning server.
function isolatedBrowserTest(serverName) {
  return {
    test: test.extend({ isolatedBackendServer: [serverName, { scope: 'worker' }] }),
    expect,
  };
}

module.exports = isolatedBrowserTest;
