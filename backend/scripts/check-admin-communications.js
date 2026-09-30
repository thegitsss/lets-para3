const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { assertAdminCommunicationsConfiguration } = require('../utils/workerProductionConfig');

async function main() {
  // Configuration-only by default: no database changes, mailbox reads, or email sends.
  assertAdminCommunicationsConfiguration({ ...process.env, NODE_ENV: 'production' });
  console.log('[admin-communications] Required configuration is present and valid.');
  if (process.argv.includes('--verify-mailbox')) {
    // Verify only the authorized account and intake folder; do not read message bodies.
    await require('../services/support/zohoMailbox').createZohoMailbox().verify();
    console.log('[admin-communications] Support account and intake folder verified. No messages imported or sent.');
  }
}
main().catch(error => {
  console.error(String(error.message || '').startsWith('[config]') ? error.message : '[admin-communications] Mailbox verification failed. Check OAuth permissions, regional endpoints, and account/folder identity.');
  process.exitCode = 1;
});
