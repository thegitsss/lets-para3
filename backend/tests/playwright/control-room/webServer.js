const { MongoMemoryReplSet } = require("mongodb-memory-server");

async function prepareDatabaseModels(uri) {
  // Provision the empty test database before HTTP opens. Otherwise automatic
  // index creation can take collection locks during sign-in or an invitation.
  const mongoose = require("mongoose");
  const fs = require("node:fs");
  const path = require("node:path");
  const automatic = { autoCreate: mongoose.get("autoCreate"), autoIndex: mongoose.get("autoIndex") };
  mongoose.set("autoCreate", false);
  mongoose.set("autoIndex", false);
  const modelDirectory = path.resolve(__dirname, "../../../models");
  for (const name of fs.readdirSync(modelDirectory).filter(name => name.endsWith(".js")).sort()) {
    require(path.join(modelDirectory, name));
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 20000 });
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection();
    await model.ensureIndexes();
  }
  mongoose.set("autoCreate", automatic.autoCreate);
  mongoose.set("autoIndex", automatic.autoIndex);
}

async function main() {
  process.env.MONGOMS_IP = process.env.MONGOMS_IP || "127.0.0.1";
  const mongoInstance = {
    ip: "127.0.0.1",
    launchTimeout: 60000,
  };
  if (process.env.PLAYWRIGHT_MONGO_PORT) {
    mongoInstance.port = Number(process.env.PLAYWRIGHT_MONGO_PORT);
  }
  // Every suite served by the full application signs in through account-guarded
  // session writes. Those transactions require a replica set, even when a suite
  // does not exercise a financial workflow.
  const mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, ip: "127.0.0.1" },
    instanceOpts: [mongoInstance],
  });

  process.env.MONGO_URI = mongo.getUri("control-room-playwright");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "control-room-playwright-secret";
  process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || "0123456789abcdef".repeat(4);
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_control_room_playwright";
  process.env.STRIPE_PUBLISHABLE_KEY =
    process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_control_room_playwright";
  process.env.STRIPE_WEBHOOK_SECRET =
    process.env.STRIPE_WEBHOOK_SECRET || "whsec_control_room_playwright";
  const serverOrigin = `http://127.0.0.1:${process.env.PORT || "5050"}`;
  process.env.APP_BASE_URL = process.env.APP_BASE_URL || serverOrigin;
  process.env.CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || process.env.APP_BASE_URL;
  process.env.FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL;
  process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK = "true";
  process.env.INCIDENT_FOUNDER_APPROVER_EMAILS =
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS ||
    process.env.CONTROL_ROOM_E2E_ADMIN_EMAIL ||
    "control-room.e2e.admin@lets-paraconnect.dev";

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await mongo.stop();
    } catch (_) {
      // Best effort cleanup for the Playwright-local Mongo server.
    }
  };

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("exit", () => {
    void shutdown();
  });

  await prepareDatabaseModels(process.env.MONGO_URI);
  require("../../../index.js");
}

main().catch((error) => {
  console.error("[control-room-playwright] Failed to start web server.", error);
  process.exit(1);
});
