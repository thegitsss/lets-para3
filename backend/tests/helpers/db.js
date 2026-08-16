const mongoose = require("mongoose");
const { readReadyState } = require("./mongoHarnessState");

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
  });
  await clearDatabase();
}

async function clearDatabase() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("Cannot clear the Jest database before its Mongo connection is ready.");
  }
  const names = Object.values(mongoose.connection.collections)
    .map((collection) => collection?.name)
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

async function closeDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close(true);
  }
}

module.exports = {
  connect,
  clearDatabase,
  closeDatabase,
  testDatabaseName,
};
