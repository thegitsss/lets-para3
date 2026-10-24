const crypto = require("node:crypto");
if (process.env.NODE_ENV && process.env.NODE_ENV !== "test") {
  throw new Error("The read-load rehearsal requires NODE_ENV=test and never uses a configured database.");
}
function countOption(name, fallback, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}
const CASE_COUNT = countOption("LOAD_CASE_COUNT", 12, 100);
const ROUNDS = countOption("LOAD_ROUNDS", 25, 100);
const CONCURRENCY = countOption("LOAD_CONCURRENCY", 24, 64);
const MESSAGES_PER_CASE = countOption("LOAD_MESSAGES_PER_CASE", 10, 100);
const DOCS_PER_CASE = countOption("LOAD_DOCS_PER_CASE", 4, 50);

// This command owns a fresh loopback replica. Never inherit provider secrets or
// a production encryption key for synthetic records; no .env is loaded.
Object.assign(process.env, {
  NODE_ENV: "test", APP_ENV: "test", REQUIRE_AUTH_SESSION: "true", JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
  STRIPE_SECRET_KEY: "sk_test_read_load_synthetic", OPENAI_API_KEY: "",
  EMAIL_DISABLE: "true", S3_MALWARE_SCAN_REQUIRED: "false",
  S3_BUCKET: "synthetic-read-load", AWS_EC2_METADATA_DISABLED: "true",
  ENABLE_CSRF: "false",
  LPC_TEST_MONGO_NAMESPACE: process.env.LPC_TEST_MONGO_NAMESPACE || `read-load-${crypto.randomUUID()}`,
});
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");
require("../tests/helpers/supertestLoopback").isolateSupertestLoopback();

const User = require("../models/User");
const Case = require("../models/Case");
const Message = require("../models/Message");
const CaseFile = require("../models/CaseFile");
const casesRouter = require("../routes/cases");
const messagesRouter = require("../routes/messages");
const uploadsRouter = require("../routes/uploads");
const { connect, clearDatabase, closeDatabase } = require("../tests/helpers/db");
const setupDatabase = require("../tests/helpers/globalMongoSetup");
const teardownDatabase = require("../tests/helpers/globalMongoTeardown");
const acceptedPolicyFixture = require("../tests/helpers/legalPolicyFixture");
const { createAuthSession } = require("../services/authSessionService");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
  instance.use("/api/messages", messagesRouter);
  instance.use("/api/uploads", uploadsRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return instance;
})();

async function authCookieFor(user) {
  const session = await createAuthSession(user, { headers: { "user-agent": "Synthetic loopback read-load" }, ip: "127.0.0.1" });
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
    sid: session.sessionId,
    av: user.authVersion || 0,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function seedDataset() {
  const attorney = await User.create({
    ...acceptedPolicyFixture(),
    firstName: "Alex",
    lastName: "Stone",
    email: "load.attorney@example.com",
    password: "Password123!",
    role: "attorney",
    status: "approved",
    emailVerified: true,
    state: "CA",
  });

  const paralegal = await User.create({
    ...acceptedPolicyFixture(),
    firstName: "Priya",
    lastName: "Ng",
    email: "load.paralegal@example.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    emailVerified: true,
    state: "CA",
  });

  const cases = [];
  for (let i = 0; i < CASE_COUNT; i += 1) {
    const c = await Case.create({
      title: `Load test case ${i + 1}`,
      practiceArea: "immigration",
      details: `Case ${i + 1} used for read-load verification.`,
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: `pi_load_${i + 1}`,
      totalAmount: 80000,
      lockedTotalAmount: 80000,
      currency: "usd",
      tasks: [
        { title: "Draft filing", completed: true },
        { title: "Serve party", completed: false },
      ],
    });
    cases.push(c);
  }

  for (const c of cases) {
    const messageDocs = [];
    for (let idx = 0; idx < MESSAGES_PER_CASE; idx += 1) {
      messageDocs.push({
        caseId: c._id,
        senderId: idx % 2 === 0 ? attorney._id : paralegal._id,
        senderRole: idx % 2 === 0 ? "attorney" : "paralegal",
        type: "text",
        text: `Load message ${idx + 1} for case ${c._id}`,
        content: `Load message ${idx + 1} for case ${c._id}`,
      });
    }
    await Message.insertMany(messageDocs);

    const fileDocs = [];
    for (let idx = 0; idx < DOCS_PER_CASE; idx += 1) {
      fileDocs.push({
        caseId: c._id,
        userId: attorney._id,
        originalName: `doc-${idx + 1}.pdf`,
        storageKey: `cases/${c._id}/documents/doc-${idx + 1}.pdf`,
        mimeType: "application/pdf",
        size: 2048,
        uploadedByRole: "attorney",
        status: "pending_review",
        version: idx + 1,
      });
    }
    // create() runs the encryption save hook; insertMany bypasses that hook.
    await CaseFile.create(fileDocs);
  }

  return { attorney, cases };
}

async function runWithConcurrency(tasks, limit, worker) {
  let cursor = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      await worker(tasks[cursor++]);
    }
  }));
  const failures = outcomes.filter(outcome => outcome.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), "Read-load workers failed after all in-flight requests settled.");
}

async function run() {
  let databaseReady = false;
  let listener;
  try {
    await setupDatabase();
    databaseReady = true;
    await connect();
    await clearDatabase();
    listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
      server.once("error", reject);
    });
    const { attorney, cases } = await seedDataset();
    const cookie = await authCookieFor(attorney);
    const caseIds = cases.map((c) => String(c._id));

    const tasks = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const caseId of caseIds) {
        tasks.push({ type: "case", path: `/api/cases/${caseId}` });
        tasks.push({ type: "messages", path: `/api/messages/${caseId}` });
        tasks.push({ type: "documents", path: `/api/uploads/case/${caseId}` });
      }
    }

    const durations = { case: [], messages: [], documents: [] };
    const failures = [];
    let completed = 0;
    const startedAt = Date.now();

    await runWithConcurrency(tasks, CONCURRENCY, async (task) => {
      const t0 = process.hrtime.bigint();
      const res = await request(listener).get(task.path).set("Cookie", cookie).timeout({ response: 10000, deadline: 15000 });
      const t1 = process.hrtime.bigint();
      const ms = Number(t1 - t0) / 1_000_000;

      durations[task.type].push(ms);
      completed += 1;

      const completePayload = task.type === "case" ? String(res.body.id || res.body._id) === task.path.split("/").pop()
        : task.type === "messages" ? Array.isArray(res.body.messages) && res.body.messages.length === MESSAGES_PER_CASE && res.body.messages.every(message => String(message.text).startsWith("Load message "))
        : Array.isArray(res.body.files) && res.body.files.length === DOCS_PER_CASE && res.body.files.every(file => /^doc-\d+\.pdf$/.test(file.originalName));
      if (res.status !== 200 || !completePayload) {
        failures.push({
          path: task.path,
          type: task.type,
          status: res.status,
          completePayload,
        });
      }
    });

    const elapsedMs = Date.now() - startedAt;
    const totalRequests = tasks.length;
    const perSecond = totalRequests / Math.max(1, elapsedMs / 1000);

    console.log("Synthetic loopback read-load dataset; no provider or production capacity acceptance");
    console.log(`- Cases: ${CASE_COUNT}`);
    console.log(`- Messages per case: ${MESSAGES_PER_CASE}`);
    console.log(`- Documents per case: ${DOCS_PER_CASE}`);
    console.log(`- Rounds: ${ROUNDS}`);
    console.log(`- Concurrency: ${CONCURRENCY}`);
    console.log("Load test execution");
    console.log(`- Requests completed: ${completed}/${totalRequests}`);
    console.log(`- Total runtime: ${elapsedMs} ms`);
    console.log(`- Throughput: ${perSecond.toFixed(2)} req/s`);

    const reportLine = (label, values) => {
      console.log(
        `- ${label}: avg=${average(values).toFixed(2)}ms p50=${percentile(values, 50).toFixed(
          2
        )}ms p95=${percentile(values, 95).toFixed(2)}ms max=${Math.max(...values, 0).toFixed(2)}ms`
      );
    };

    console.log("Latency summary");
    reportLine("Case detail", durations.case);
    reportLine("Messages", durations.messages);
    reportLine("Documents", durations.documents);

    if (failures.length) {
      console.error(`Failures detected: ${failures.length}`);
      failures.slice(0, 5).forEach((entry, idx) => {
        console.error(
          `  ${idx + 1}. [${entry.type}] ${entry.path} -> ${entry.status} ${
            entry.completePayload ? "" : "incomplete or unreadable seeded payload"
          }`
        );
      });
      process.exitCode = 1;
      return;
    }

    console.log("Read-load requests passed: complete seeded responses; graceful cleanup must also pass.");
  } finally {
    const cleanupErrors = [];
    if (listener) {
      listener.closeAllConnections?.();
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())).catch(error => cleanupErrors.push(error));
    }
    await closeDatabase().catch(error => cleanupErrors.push(error));
    if (databaseReady) await teardownDatabase().catch(error => cleanupErrors.push(error));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "The read-load rehearsal did not clean up completely.");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
