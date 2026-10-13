// Render mounts staging secrets directly. Do not load the workstation .env.
const { assertStagingRuntimeConfiguration } = require('../utils/stagingRuntimeConfig');
async function main() {
  assertStagingRuntimeConfiguration();
  if (process.argv.includes('--email-worker')) {
    const mongoose = require('mongoose');
    const { MONGO_OPERATION_OPTIONS } = require('../utils/mongooseOperationPolicy');
    const { ensureCommunicationIndexes } = require('./admin-communications-indexes');
    // Process the application's durable notice owners, excluding production
    // support mailbox sync, outreach, and automatic correspondence.
    const categories = ['File', 'Message', 'Work', 'Payment', 'Withdrawal', 'Review', 'Application', 'Invitation', 'Posting', 'PreEngagement'];
    const owners = categories.map(name => require('../services/matter' + name + 'Notifications'));
    let stopping = false, wake;
    const stop = () => { stopping = true; wake?.(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      await mongoose.connect(process.env.MONGO_URI, { ...MONGO_OPERATION_OPTIONS, autoCreate: false });
      await ensureCommunicationIndexes();
      while (!stopping) {
        for (const owner of owners) {
          if (stopping) break;
          try { await owner.processNotices({ limit: 20, shouldStop: () => stopping }); }
          catch { console.error('A staging notice cycle failed; durable records retain its retry state.'); }
        }
        if (stopping) break;
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 5000);
          wake = () => { clearTimeout(timer); resolve(); };
          if (stopping) wake();
        });
        wake = null;
      }
    } finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      require('../utils/email').transporter.close();
      await mongoose.disconnect();
    }
  } else {
    require('../index');
  }
}
if (require.main === module) main().catch(error => {
  console.error(String(error.message || '').startsWith('[staging config]') ? error.message : 'Staging startup failed. Check its isolated configuration.');
  process.exitCode = 1;
});
module.exports = { main };
