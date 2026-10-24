const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_phase8e";

const User = require("../models/User");
const Case = require("../models/Case");
const Notification = require("../models/Notification");
const casesRouter = require("../routes/cases");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
  instance.use((err, _req, res, _next) => {
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const token = jwt.sign({
    id: String(user._id),
    role: user.role,
    email: user.email,
    status: user.status,
  }, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function fixture() {
  const attorney = await User.create({
    firstName: "Jordan",
    lastName: "Lee",
    email: "phase8e.attorney@example.com",
    password: "Password123!",
    role: "attorney",
    status: "approved",
    state: "NY",
  });
  const paralegal = await User.create({
    firstName: "Dana",
    lastName: "Young",
    email: "phase8e.paralegal@example.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    state: "NY",
  });
  const matter = await Case.create({
    title: "Phase 8E Matter",
    details: "Completion authority characterization.",
    status: "in progress",
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal._id,
    paralegalId: paralegal._id,
    hiredAt: new Date("2026-09-01T12:00:00.000Z"),
    escrowIntentId: "pi_phase8e_funded",
    escrowStatus: "funded",
    totalAmount: 100000,
    currency: "usd",
    tasks: [{ title: "Prepare responses", completed: false }],
  });
  return { attorney, paralegal, matter };
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("Paralegal V2 completion authority", () => {
  test("the paralegal can observe task progress but cannot approve tasks or complete the Matter", async () => {
    const { paralegal, matter } = await fixture();
    const cookie = authCookieFor(paralegal);
    const notificationCount = await Notification.countDocuments({ userId: paralegal._id });

    const taskAttempt = await request(app)
      .patch(`/api/cases/${matter._id}`)
      .set("Cookie", cookie)
      .send({ tasks: [{ title: "Prepare responses", completed: true }] });
    expect(taskAttempt.status).toBe(403);
    expect(taskAttempt.body.error).toMatch(/only the Matter attorney/i);

    const completionAttempt = await request(app)
      .post(`/api/cases/${matter._id}/complete`)
      .set("Cookie", cookie)
      .send({});
    expect(completionAttempt.status).toBe(403);
    expect(completionAttempt.body.error).toMatch(/only the Matter attorney/i);

    const stored = await Case.findById(matter._id).lean();
    expect(stored.status).toBe("in progress");
    expect(stored.paymentReleased).toBe(false);
    expect(stored.tasks[0].completed).toBe(false);
    expect(await Notification.countDocuments({ userId: paralegal._id })).toBe(notificationCount);
  });

  test("attorney task decisions reach the paralegal projection without granting completion authority", async () => {
    const { attorney, paralegal, matter } = await fixture();
    const updated = await request(app)
      .patch(`/api/cases/${matter._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({ tasks: [{ title: "Prepare responses", completed: true }] });
    expect(updated.status).toBe(200);

    const projected = await request(app)
      .get(`/api/cases/${matter._id}`)
      .set("Cookie", authCookieFor(paralegal));
    expect(projected.status).toBe(200);
    expect(projected.body).toMatchObject({
      status: "in progress",
      paymentReleased: false,
      matterExperience: {
        header: { primaryAction: { code: "continue_work", tab: "work" } },
        overview: { taskProgress: { completed: 1, total: 1 } },
        work: { completed: 1, total: 1, readOnly: false },
      },
    });
    expect(projected.body.matterExperience.work.tasks).toEqual([
      { title: "Prepare responses", completed: true },
    ]);
  });

  test("completion removes the live workspace and preserves the completed-history projection", async () => {
    const { paralegal, matter } = await fixture();
    const completedAt = new Date("2026-09-03T12:00:00.000Z");
    await Case.updateOne({ _id: matter._id }, {
      $set: {
        "tasks.0.completed": true,
        status: "completed",
        archived: true,
        readOnly: true,
        completedAt,
        paymentReleased: true,
        paidOutAt: completedAt,
        payoutFinalizedAt: completedAt,
        payoutFinalizedType: "full",
        feeParalegalPct: 18,
        stripeMode: "test",
        payoutTransferId: "tr_phase8e_completed",
        paralegalAccessRevokedAt: completedAt,
      },
    });

    // A completed flag is not payout evidence. Retain the synthetic transfer
    // that this positive history/receipt case is asserting survived closure.
    await require("../models/Payout").create({ caseId: matter._id, paralegalId: paralegal._id, operationKey: `case_payout:${matter._id}`, amountPaid: 82000, transferId: "tr_phase8e_completed", status: "paid", stripeMode: "test", createdAt: completedAt });
    await require("../models/PaymentOperation").create({ caseId: matter._id, operationKey: `case_payout:${matter._id}`, kind: "case_payout", fingerprint: "phase8e_completed", amount: 82000, currency: "usd", status: "succeeded", stripeTransferId: "tr_phase8e_completed", stripeMode: "test" });

    const cookie = authCookieFor(paralegal);
    const workspace = await request(app).get(`/api/cases/${matter._id}`).set("Cookie", cookie);
    expect([403, 404]).toContain(workspace.status);
    expect(workspace.body.error).toMatch(/completed Matters are no longer accessible|Matter not found/i);

    const history = await request(app).get("/api/cases/my-completed").set("Cookie", cookie);
    expect(history.status).toBe(200);
    const record = history.body.items.find((item) => String(item.caseId) === String(matter._id));
    expect(record).toEqual(expect.objectContaining({
      caseId: expect.anything(),
      title: "Phase 8E Matter",
      receiptAvailable: true,
    }));
    expect(record.completedAt).toBeTruthy();
  });
});
