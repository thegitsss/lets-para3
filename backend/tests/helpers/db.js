const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongoServer;

async function connect() {
  if (!process.env.MONGOMS_IP) {
    process.env.MONGOMS_IP = "127.0.0.1";
  }
  mongoServer = await MongoMemoryServer.create({
    instance: {
      ip: "127.0.0.1",
    },
  });
  const uri = mongoServer.getUri();
  await mongoose.connect(uri, { dbName: "jest" });
}

async function clearDatabase() {
  const collections = mongoose.connection.collections;
  const ops = Object.values(collections).map((collection) => collection.deleteMany({}));
  await Promise.all(ops);
}

async function closeDatabase() {
  try {
    await mongoose.connection.dropDatabase();
  } catch (_) {}
  await mongoose.connection.close();
  if (mongoServer) await mongoServer.stop();
}

module.exports = {
  connect,
  clearDatabase,
  closeDatabase,
};
