const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let mongoServer;

async function connect() {
  if (!process.env.MONGOMS_IP) {
    process.env.MONGOMS_IP = "127.0.0.1";
  }
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger", ip:"127.0.0.1" },
    instanceOpts:[{
      ip: "127.0.0.1",
    }],
  });
  const uri = mongoServer.getUri();
  await mongoose.connect(uri, { dbName: "jest", autoIndex:false, autoCreate:false });
  for(const name of ['User','AuthSession','AuthChallenge','PasskeyCredential','EmailVerificationToken','SignupReviewNotification','AdmissionDecisionNotification','AdminCommunicationAlert','LegalDocumentVersion','AuditLog','Notification','StorageDeletionTask']) {
    const model=mongoose.models[name];if(model){await model.createCollection();await model.createIndexes()}
  }
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
