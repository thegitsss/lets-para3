#!/usr/bin/env node
'use strict';
// The same bounded, durable preparation pass used by the automation cron.
// This process has no browser dependency and never sends messages or decides admission.
if (require.main === module) require('../utils/runtimeEnvironment').loadRuntimeEnvironment();
const mongoose = require('mongoose');
const { requireMongoUri, MONGO_OPERATION_OPTIONS } = require('../utils/mongooseOperationPolicy');
const { runAdminPreparationCycle } = require('../services/adminOperatingPreparation');
async function main() {
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await mongoose.connect(requireMongoUri(process.env.MONGO_URI), MONGO_OPERATION_OPTIONS);
    const result = await runAdminPreparationCycle({ shouldStop: () => stopped });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    await mongoose.disconnect();
  }
}
if (require.main === module) main().catch(async () => { process.stderr.write('Review preparation could not finish. Check its saved work status.\n'); await mongoose.disconnect().catch(() => {}); process.exitCode = 1; });
module.exports = { main };
