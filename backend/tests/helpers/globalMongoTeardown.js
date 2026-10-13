// Use the driver shipped with this checkout's Mongoose installation. Resolving
// an undeclared top-level mongodb package can pick up a user's global install.
const { MongoClient } = require("mongoose").mongo;
const { releaseStateFile } = require("./mongoHarnessState");

function observeProcessExit(childProcess, timeoutMs = 20_000) {
  if (!childProcess) return Promise.reject(new Error("The shared Jest mongod process was unavailable."));
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return Promise.resolve({ code: childProcess.exitCode, signal: childProcess.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timeoutId);
      resolve({ code, signal });
    };
    const timeoutId = setTimeout(() => {
      childProcess.off("exit", onExit);
      reject(new Error(`The shared Jest mongod process did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    childProcess.once("exit", onExit);
  });
}

module.exports = async function globalMongoTeardown() {
  const mongoServer = global.__LPC_JEST_MONGO_SERVER__;
  const cleanupErrors = [];

  try {
    if (!mongoServer) {
      throw new Error("The shared Jest Mongo process was not available during teardown.");
    }
  } catch (err) {
    cleanupErrors.push(err);
  }

  if (mongoServer) {
    const client = new MongoClient(mongoServer.getUri(), {
      connectTimeoutMS: 10_000,
      directConnection: true,
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 15_000,
    });
    try {
      await client.connect();
      await client.db("jest").dropDatabase({ maxTimeMS: 10_000 });
    } catch (err) {
      cleanupErrors.push(err);
    }

    const mongoInstance = mongoServer.instanceInfo?.instance;
    // Let the replica owner perform its one graceful shutdown and watchdog
    // cleanup. Sending a separate shutdown first races that same owner.
    const processExitPromise = observeProcessExit(mongoInstance?.mongodProcess)
      .then((exit) => ({ exit }), (error) => ({ error }));
    await client.close().catch((err) => cleanupErrors.push(err));
    const processOwner = global.__LPC_JEST_MONGO_REPLICA_SET__ || mongoServer;
    await processOwner.stop({ doCleanup: true, force: true }).catch((err) => cleanupErrors.push(err));
    const outcome = await processExitPromise;
    if (outcome.error) cleanupErrors.push(outcome.error);
    else if (outcome.exit.code !== 0 || outcome.exit.signal) {
      cleanupErrors.push(new Error(`The shared Jest mongod process exited abnormally (${JSON.stringify(outcome.exit)}).`));
    }

  }

  try {
    releaseStateFile();
  } catch (err) {
    cleanupErrors.push(err);
  } finally {
    delete global.__LPC_JEST_MONGO_SERVER__;
    delete global.__LPC_JEST_MONGO_REPLICA_SET__;
  }

  if (cleanupErrors.length) {
    const details = cleanupErrors.map((error) => `${error.name}: ${error.message}`).join("; ");
    throw new AggregateError(cleanupErrors, `The shared Jest Mongo harness did not clean up completely. ${details}`);
  }
};

module.exports.observeProcessExit = observeProcessExit;
