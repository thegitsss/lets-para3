const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));

const User = require("../models/User");
const Case = require("../models/Case");
const Block = require("../models/Block");
const Notification = require("../models/Notification");
const blocksRouter = require("../routes/blocks");
const messagesRouter = require("../routes/messages");
const { BLOCKED_MESSAGE } = require("../utils/blocks");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/blocks", blocksRouter);
  instance.use("/api/messages", messagesRouter);
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

async function createApprovedUser({ email, role, firstName = "Test", lastName = "User" }) {
  return User.create({
    firstName,
    lastName,
    email,
    password: "Password123!",
    role,
    status: "approved",
    state: "CA",
  });
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Finalized block rules", () => {
  test("blocking is rejected while a case is still active", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+block-attorney-active@gmail.com",
      role: "attorney",
      firstName: "Avery",
    });
    const paralegal = await createApprovedUser({
      email: "samanthasider+block-paralegal-active@gmail.com",
      role: "paralegal",
      firstName: "Parker",
    });

    const caseDoc = await Case.create({
      title: "Active matter",
      practiceArea: "immigration",
      details: "Active case should not allow blocking.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_active_block",
      totalAmount: 40000,
      currency: "usd",
    });

    const res = await request(app)
      .post("/api/blocks")
      .set("Cookie", authCookieFor(attorney))
      .send({ caseId: caseDoc._id.toString() });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/finalized case outcome|finalized/i);
    expect(await Block.countDocuments()).toBe(0);
  });

  test("attorney can block after a finalized zero-payout withdrawal and messaging is then blocked", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+block-attorney-withdraw@gmail.com",
      role: "attorney",
      firstName: "Avery",
    });
    const paralegal = await createApprovedUser({
      email: "samanthasider+block-paralegal-withdraw@gmail.com",
      role: "paralegal",
      firstName: "Parker",
    });

    const withdrawnCase = await Case.create({
      title: "Withdrawn matter",
      practiceArea: "family law",
      details: "Withdrawal finalized at zero payout.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      withdrawnParalegalId: paralegal._id,
      paralegalNameSnapshot: "Parker User",
      status: "paused",
      pausedReason: "paralegal_withdrew",
      payoutFinalizedAt: new Date(),
      payoutFinalizedType: "zero_auto",
      partialPayoutAmount: 0,
      totalAmount: 55000,
      remainingAmount: 55000,
      currency: "usd",
    });

    const createRes = await request(app)
      .post("/api/blocks")
      .set("Cookie", authCookieFor(attorney))
      .send({ caseId: withdrawnCase._id.toString() });

    expect(createRes.status).toBe(201);
    expect(createRes.body.block?.sourceType).toBe("withdrawal_zero_payout");

    const storedBlock = await Block.findOne({
      blockerId: attorney._id,
      blockedId: paralegal._id,
    }).lean();
    expect(storedBlock).toBeTruthy();
    expect(storedBlock.active).toBe(true);
    expect(storedBlock.sourceType).toBe("withdrawal_zero_payout");

    const laterCase = await Case.create({
      title: "Later matter",
      practiceArea: "family law",
      details: "Any later messaging should be blocked.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_blocked_message",
      totalAmount: 62000,
      currency: "usd",
    });

    const messageRes = await request(app)
      .post(`/api/messages/${laterCase._id}`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ text: "Checking in on the later matter." });

    expect(messageRes.status).toBe(403);
    expect(messageRes.body.error).toBe(BLOCKED_MESSAGE);
  });

  test("paralegal can block after a completed paid case", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+block-attorney-complete@gmail.com",
      role: "attorney",
      firstName: "Avery",
    });
    const paralegal = await createApprovedUser({
      email: "samanthasider+block-paralegal-complete@gmail.com",
      role: "paralegal",
      firstName: "Parker",
    });

    const completedCase = await Case.create({
      title: "Completed matter",
      practiceArea: "probate",
      details: "Completed paid case should allow paralegal block.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "completed",
      paymentReleased: true,
      completedAt: new Date(),
      paidOutAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_completed_block",
      totalAmount: 47000,
      currency: "usd",
    });

    const res = await request(app)
      .post("/api/blocks")
      .set("Cookie", authCookieFor(paralegal))
      .send({ caseId: completedCase._id.toString() });

    expect(res.status).toBe(201);
    expect(res.body.block?.sourceType).toBe("closed_case");

    const storedBlock = await Block.findOne({
      blockerId: paralegal._id,
      blockedId: attorney._id,
    }).lean();
    expect(storedBlock).toBeTruthy();
    expect(storedBlock.active).toBe(true);
    expect(storedBlock.sourceType).toBe("closed_case");
  });

  test("unblocking deactivates the pairwise restriction without creating notifications", async () => {
    const attorney = await createApprovedUser({
      email: "samanthasider+block-attorney-unblock@gmail.com",
      role: "attorney",
      firstName: "Avery",
    });
    const paralegal = await createApprovedUser({
      email: "samanthasider+block-paralegal-unblock@gmail.com",
      role: "paralegal",
      firstName: "Parker",
    });

    const completedCase = await Case.create({
      title: "Closed matter",
      practiceArea: "estate planning",
      details: "Completed paid case should allow blocking and later silent unblock.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "completed",
      paymentReleased: true,
      completedAt: new Date(),
      paidOutAt: new Date(),
      escrowStatus: "funded",
      escrowIntentId: "pi_completed_unblock",
      totalAmount: 52000,
      currency: "usd",
    });

    const createRes = await request(app)
      .post("/api/blocks")
      .set("Cookie", authCookieFor(attorney))
      .send({ caseId: completedCase._id.toString() });

    expect(createRes.status).toBe(201);

    const deleteRes = await request(app)
      .delete(`/api/blocks/${paralegal._id.toString()}`)
      .set("Cookie", authCookieFor(attorney));

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toMatchObject({ ok: true, blocked: false });

    const storedBlock = await Block.findOne({
      blockerId: attorney._id,
      blockedId: paralegal._id,
    }).lean();
    expect(storedBlock).toBeTruthy();
    expect(storedBlock.active).toBe(false);
    expect(storedBlock.deactivatedAt).toBeTruthy();

    const notifications = await Notification.find({ userId: { $in: [attorney._id, paralegal._id] } }).lean();
    expect(notifications).toHaveLength(0);
  });
});
