const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";
process.env.ENABLE_CSRF = "false";

const User = require("../models/User");
const Case = require("../models/Case");
const Message = require("../models/Message");
const CaseFile = require("../models/CaseFile");
const casesRouter = require("../routes/cases");
const messagesRouter = require("../routes/messages");
const uploadsRouter = require("../routes/uploads");
const { connect, clearDatabase, closeDatabase } = require("../tests/helpers/db");

const CASE_COUNT = Number(process.env.LOAD_CASE_COUNT || 12);
const ROUNDS = Number(process.env.LOAD_ROUNDS || 25);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 24);
const MESSAGES_PER_CASE = Number(process.env.LOAD_MESSAGES_PER_CASE || 10);
const DOCS_PER_CASE = Number(process.env.LOAD_DOCS_PER_CASE || 4);

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

function authCookieFor(user) {
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
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
    firstName: "Alex",
    lastName: "Stone",
    email: "load.attorney@example.com",
    password: "Password123!",
    role: "attorney",
    status: "approved",
    state: "CA",
  });

  const paralegal = await User.create({
    firstName: "Priya",
    lastName: "Ng",
    email: "load.paralegal@example.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
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
    await CaseFile.insertMany(fileDocs);
  }

  return { attorney, cases };
}

async function runWithConcurrency(tasks, limit, worker) {
  let cursor = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const next = () => {
      if (cursor >= tasks.length && active === 0) {
        resolve();
        return;
      }
      while (active < limit && cursor < tasks.length) {
        const task = tasks[cursor++];
        active += 1;
        Promise.resolve(worker(task))
          .then(() => {
            active -= 1;
            next();
          })
          .catch(reject);
      }
    };
    next();
  });
}

async function run() {
  await connect();
  await clearDatabase();
  const startedAt = Date.now();
  try {
    const { attorney, cases } = await seedDataset();
    const cookie = authCookieFor(attorney);
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

    await runWithConcurrency(tasks, CONCURRENCY, async (task) => {
      const t0 = process.hrtime.bigint();
      const res = await request(app).get(task.path).set("Cookie", cookie);
      const t1 = process.hrtime.bigint();
      const ms = Number(t1 - t0) / 1_000_000;

      durations[task.type].push(ms);
      completed += 1;

      if (res.status !== 200) {
        failures.push({
          path: task.path,
          type: task.type,
          status: res.status,
          body: res.body,
        });
      }
    });

    const elapsedMs = Date.now() - startedAt;
    const totalRequests = tasks.length;
    const perSecond = totalRequests / Math.max(1, elapsedMs / 1000);

    console.log("Load test dataset");
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
            entry.body?.error || entry.body?.msg || ""
          }`
        );
      });
      process.exitCode = 1;
      return;
    }

    console.log("Load test passed: no non-200 responses.");
  } finally {
    await closeDatabase();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
