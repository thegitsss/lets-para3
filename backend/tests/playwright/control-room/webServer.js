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
  await require("../../helpers/prepareModelIndexes")(Object.values(mongoose.models));
  mongoose.set("autoCreate", automatic.autoCreate);
  mongoose.set("autoIndex", automatic.autoIndex);
}

async function main() {
  process.env.MONGOMS_IP = process.env.MONGOMS_IP || "127.0.0.1";
  const mongoInstance = {
    ip: "127.0.0.1",
    launchTimeout: 60000,
    args: ["--setParameter", "shutdownTimeoutMillisForSignaledShutdown=1000"],
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

  const mongoose = require("mongoose");
  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      // index.js owns HTTP draining and then disconnects its application client.
      // Keep the owned replica alive until that drain has actually completed.
      if (mongoose.connection.readyState !== 0) {
        await new Promise(resolve => mongoose.connection.once("disconnected", resolve));
      }
      await mongo.stop({ doCleanup: true, force: true });
    })();
    return shutdownPromise;
  };

  try {
    await prepareDatabaseModels(process.env.MONGO_URI);
    require("../../../index.js");
  } catch (error) {
    await mongoose.disconnect();
    await mongo.stop({ doCleanup: true, force: true });
    throw error;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown().catch(error => {
        console.error("[control-room-playwright] Owned replica cleanup failed.", error);
        process.exitCode = 1;
      });
    });
  }

}

main().catch((error) => {
  console.error("[control-room-playwright] Failed to start web server.", error);
  process.exit(1);
});
