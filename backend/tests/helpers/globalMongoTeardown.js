// Use the driver shipped with this checkout's Mongoose installation. Resolving
// an undeclared top-level mongodb package can pick up a user's global install.
const { MongoClient, MongoNetworkError } = require("mongoose").mongo;
const { releaseStateFile } = require("./mongoHarnessState");

function isExpectedShutdownDisconnect(error) {
  if (!(error instanceof MongoNetworkError)) return false;
  const message = String(error.message || "");
  return /^connection \d+ to 127\.0\.0\.1:\d+ closed$/i.test(message) || message === "read ECONNRESET";
}

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
    let clientReady = false;
    try {
      await client.connect();
      clientReady = true;
      await client.db("jest").dropDatabase({ maxTimeMS: 10_000 });
    } catch (err) {
      cleanupErrors.push(err);
    }

    if (clientReady) {
      const mongoInstance = mongoServer.instanceInfo?.instance;
      // Attach the rejection handler immediately: shutdown itself can take time.
      const processExitPromise = observeProcessExit(mongoInstance?.mongodProcess)
        .then((exit) => ({ exit }), (error) => ({ error }));
      try {
        await client.db("admin").command({ shutdown: 1, force: true, timeoutSecs: 1 });
      } catch (err) {
        if (!isExpectedShutdownDisconnect(err)) cleanupErrors.push(err);
      }
      try {
        await client.close();
        const outcome = await processExitPromise;
        if (outcome.error) throw outcome.error;
        const exit = outcome.exit;
        if (exit.code !== 0 || exit.signal) {
          cleanupErrors.push(
            new Error(`The shared Jest mongod process exited abnormally (${JSON.stringify(exit)}).`)
          );
        } else {
          // MongoMemoryServer owns the remaining watchdog and temp-directory cleanup.
          // Clear only the child reference whose normal exit was observed above.
          mongoInstance.mongodProcess = undefined;
        }
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    const processOwner = global.__LPC_JEST_MONGO_REPLICA_SET__ || mongoServer;
    await processOwner.stop({ doCleanup: true, force: true }).catch((err) => cleanupErrors.push(err));
    await client.close().catch((err) => cleanupErrors.push(err));
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
