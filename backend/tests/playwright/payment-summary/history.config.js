const base = require('./playwright.config');
module.exports = { ...base, testMatch: 'history.spec.js' };
