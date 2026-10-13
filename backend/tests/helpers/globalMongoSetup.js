const fs = require("fs");
const path = require("path");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const {
  claimStateFile,
  publishReadyState,
  releaseStateFile,
} = require("./mongoHarnessState");

const MONGO_LAUNCH_TIMEOUT_MS = 60_000;

module.exports = async function globalMongoSetup() {
  process.env.MONGOMS_IP = "127.0.0.1";
  const stateDescriptor = claimStateFile();
  let mongoServer;
  let replicaSet;
  let testDatabase;

  try {
    replicaSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, ip: "127.0.0.1" },
      instanceOpts: [{ launchTimeout: MONGO_LAUNCH_TIMEOUT_MS }],
    });
    // Existing consumer suites now exercise the same transactional Matter
    // writes as the application. Keep the state file's single loopback URI.
    mongoServer = replicaSet.servers[0];
    mongoServer.instanceInfo.instance.mongodProcess.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        process.stderr.write(`[jest-mongo] Temporary MongoDB exited abnormally: ${JSON.stringify({ code, signal })}\n`);
      }
    });
    publishReadyState(stateDescriptor, mongoServer.getUri());
    // Index creation is a database prerequisite, not part of an individual
    // test's 30-second hook budget. Prepare the complete schema once before
    // any suite starts; per-suite connect still checks its registered models.
    const modelsDirectory = path.join(__dirname, "../../models");
    for (const file of fs.readdirSync(modelsDirectory).filter(name => name.endsWith(".js")).sort()) {
      require(path.join(modelsDirectory, file));
    }
    testDatabase = require("./db");
    await testDatabase.connect();
    await testDatabase.closeDatabase();
  } catch (err) {
    if (testDatabase) {
      try { await testDatabase.closeDatabase(); }
      catch (closeError) { process.stderr.write(`[jest-mongo] Test connection cleanup failed: ${closeError.message}\n`); }
    }
    try {
      fs.closeSync(stateDescriptor);
    } catch (_closeErr) {
      // The descriptor is already closed after a successful state publication.
    }
    await replicaSet?.stop({ doCleanup: true, force: true }).catch(() => {});
    releaseStateFile();
    throw err;
  }

  global.__LPC_JEST_MONGO_SERVER__ = mongoServer;
  global.__LPC_JEST_MONGO_REPLICA_SET__ = replicaSet;
};
