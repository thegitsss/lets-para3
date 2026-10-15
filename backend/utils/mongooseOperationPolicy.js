const MONGO_OPERATION_OPTIONS = Object.freeze({
  serverSelectionTimeoutMS: 15_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 60_000,
  maxPoolSize: 5,
  autoIndex: false,
});

function requireMongoUri(value, label = "MONGO_URI") {
  const uri = String(value || "").trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri) || /<cluster>/i.test(uri)) {
    throw new Error(`Set ${label} to the exact MongoDB database for this operation.`);
  }
  return uri;
}

module.exports = {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
};
