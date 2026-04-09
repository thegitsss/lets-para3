const { MongoMemoryServer } = require("mongodb-memory-server");

async function main() {
  process.env.MONGOMS_IP = process.env.MONGOMS_IP || "127.0.0.1";
  const mongoInstance = {
    ip: "127.0.0.1",
  };
  if (process.env.PLAYWRIGHT_MONGO_PORT) {
    mongoInstance.port = Number(process.env.PLAYWRIGHT_MONGO_PORT);
  }
  const mongo = await MongoMemoryServer.create({
    instance: mongoInstance,
  });

  process.env.MONGO_URI = mongo.getUri("control-room-playwright");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "control-room-playwright-secret";
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_control_room_playwright";
  process.env.STRIPE_PUBLISHABLE_KEY =
    process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_control_room_playwright";
  process.env.STRIPE_WEBHOOK_SECRET =
    process.env.STRIPE_WEBHOOK_SECRET || "whsec_control_room_playwright";
  process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://127.0.0.1:5050";
  process.env.CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || process.env.APP_BASE_URL;
  process.env.FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL;
  process.env.AGENT_SCHEDULER_ENABLED = "false";
  process.env.INCIDENT_SCHEDULER_ENABLED = "false";
  process.env.INCIDENT_ALLOW_ADMIN_APPROVER_FALLBACK = "true";
  process.env.INCIDENT_FOUNDER_APPROVER_EMAILS =
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS ||
    process.env.CONTROL_ROOM_E2E_ADMIN_EMAIL ||
    "control-room.e2e.admin@lets-paraconnect.dev";
  process.env.DISABLE_CASE_PURGER = "true";

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

  require("../../../index.js");
}

main().catch((error) => {
  console.error("[control-room-playwright] Failed to start web server.", error);
  process.exit(1);
});
