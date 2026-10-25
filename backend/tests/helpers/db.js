const mongoose = require("mongoose");
const { readReadyState } = require("./mongoHarnessState");
const prepareModelIndexes = require("./prepareModelIndexes");

const MONGO_SELECTION_TIMEOUT_MS = 5_000;
const MONGO_CONNECT_TIMEOUT_MS = 10_000;
const MONGO_SOCKET_TIMEOUT_MS = 15_000;
const MONGO_OPERATION_TIMEOUT_MS = 10_000;
const CLEAR_CONCURRENCY = 6;
const testDatabaseName = "jest";

async function connect() {
  const { uri } = readReadyState();

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close(true);
  }

  await mongoose.connect(uri, {
    dbName: testDatabaseName,
    connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
    socketTimeoutMS: MONGO_SOCKET_TIMEOUT_MS,
    serverSelectionTimeoutMS: MONGO_SELECTION_TIMEOUT_MS,
    waitQueueTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
    maxPoolSize: 10,
    // Route-heavy suites register many models before connecting. Build their
    // collections and indexes within a bounded portion of the connection pool.
    autoCreate: false,
    autoIndex: false,
  });
  await prepareModelIndexes(Object.values(mongoose.models));
  // Models imported later in a test retain normal Mongoose initialization.
  mongoose.connection.config.autoCreate = true;
  mongoose.connection.config.autoIndex = true;
  await clearDatabase();
}

async function clearDatabase() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("Cannot clear the Jest database before its Mongo connection is ready.");
  }
  // Jest isolates module registries between suites, while this guarded temporary
  // database survives. Clear collections registered by earlier suites too.
  const names = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    .filter((name) => name && !name.startsWith("system."));
  for (let index = 0; index < names.length; index += CLEAR_CONCURRENCY) {
    await Promise.all(
      names.slice(index, index + CLEAR_CONCURRENCY).map((name) =>
        mongoose.connection.db
          .collection(name)
          .deleteMany({}, { maxTimeMS: MONGO_OPERATION_TIMEOUT_MS })
      )
    );
  }
}

async function closeDatabase({ force = true } = {}) {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close(force);
  }
}

module.exports = {
  connect,
  clearDatabase,
  closeDatabase,
  testDatabaseName,
};
