const config = require('./home-design.config');

// Focused current-source UI checks with isolated sample records and no providers.
module.exports = {
  ...config,
  testMatch: [...config.testMatch, 'attorney-v2/matter-inventory.spec.js'],
};
