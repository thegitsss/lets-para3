const fs = require("fs");
const { MongoMemoryServer } = require("mongodb-memory-server");
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

  try {
    mongoServer = await MongoMemoryServer.create({
      instance: {
        ip: "127.0.0.1",
        launchTimeout: MONGO_LAUNCH_TIMEOUT_MS,
      },
    });
    publishReadyState(stateDescriptor, mongoServer.getUri());
  } catch (err) {
    try {
      fs.closeSync(stateDescriptor);
    } catch (_closeErr) {
      // The descriptor is already closed after a successful state publication.
    }
    await mongoServer?.stop({ doCleanup: true, force: true }).catch(() => {});
    releaseStateFile();
    throw err;
  }

  global.__LPC_JEST_MONGO_SERVER__ = mongoServer;
};
