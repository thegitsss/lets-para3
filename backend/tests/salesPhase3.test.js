const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const SalesAccount = require("../models/SalesAccount");
const SalesInteraction = require("../models/SalesInteraction");
const SalesDraftPacket = require("../models/SalesDraftPacket");
const adminKnowledgeRouter = require("../routes/adminKnowledge");
const adminSalesRouter = require("../routes/adminSales");
const aiAdminRouter = require("../routes/aiAdmin");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.JWT_SECRET = process.env.JWT_SECRET || "sales-phase3-test-secret";

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/admin/knowledge", adminKnowledgeRouter);
  instance.use("/api/admin/sales", adminSalesRouter);
  instance.use("/api/admin/ai", aiAdminRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
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

async function createAdmin() {
  return User.create({
    firstName: "Admin",
    lastName: "Owner",
    email: "sales-phase3-admin@lets-paraconnect.test",
    password: "Password123!",
    role: "admin",
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

describe("Sales Phase 3", () => {
  test("imports public contact signals into sales account memory", async () => {
    const admin = await createAdmin();

    await AuditLog.create({
      actorRole: "system",
      action: "public.contact.submit",
      targetType: "other",
      meta: {
        email: "lead.attorney@example.com",
        role: "attorney",
      },
    });

    const importRes = await request(app)
      .post("/api/admin/sales/accounts/import-public-signals")
      .set("Cookie", authCookieFor(admin))
      .send({});

    expect(importRes.status).toBe(200);
    expect(importRes.body.accounts.length).toBe(1);

    const account = await SalesAccount.findOne({ primaryEmail: "lead.attorney@example.com" }).lean();
    const interaction = await SalesInteraction.findOne({ accountId: account._id }).lean();

    expect(account).toEqual(
      expect.objectContaining({
        sourceType: "public_contact",
        audienceType: "attorney",
      })
    );
    expect(interaction).toEqual(
      expect.objectContaining({
        interactionType: "public_contact_signal",
        direction: "inbound",
      })
    );
  });

  test("creates account memory and generates snapshot, outreach, objection, and answer packets", async () => {
    const admin = await createAdmin();

    await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    const accountRes = await request(app)
      .post("/api/admin/sales/accounts")
      .set("Cookie", authCookieFor(admin))
      .send({
        name: "Apex Legal Group",
        primaryEmail: "hello@apexlegal.test",
        audienceType: "attorney",
        companyName: "Apex Legal Group",
        roleLabel: "Managing attorney",
        accountSummary: "Small-firm attorney lead evaluating whether LPC fits structured overflow support.",
      });

    expect(accountRes.status).toBe(201);
    const accountId = accountRes.body.account._id;

    const interactionRes = await request(app)
      .post(`/api/admin/sales/accounts/${accountId}/interactions`)
      .set("Cookie", authCookieFor(admin))
      .send({
        interactionType: "objection_note",
        direction: "inbound",
        summary: "Asked why LPC is approval-based and how the platform fee works.",
        objections: ["Why is LPC approval-based?", "How should the platform fee be explained?"],
        rawText: "Need clear truthful answers before moving forward.",
      });

    expect(interactionRes.status).toBe(201);

    const snapshotRes = await request(app)
      .post(`/api/admin/sales/accounts/${accountId}/account-snapshot`)
      .set("Cookie", authCookieFor(admin))
      .send({});
    const outreachRes = await request(app)
      .post(`/api/admin/sales/accounts/${accountId}/outreach-draft`)
      .set("Cookie", authCookieFor(admin))
      .send({
        outreachGoal: "Introduce LPC to this attorney lead through standards, workflow, and audience fit.",
      });
    const objectionRes = await request(app)
      .post(`/api/admin/sales/accounts/${accountId}/objection-review`)
      .set("Cookie", authCookieFor(admin))
      .send({});
    const answerRes = await request(app)
      .post(`/api/admin/sales/accounts/${accountId}/prospect-answer`)
      .set("Cookie", authCookieFor(admin))
      .send({
        incomingQuestion: "How should LPC be explained truthfully for this firm?",
      });

    expect(snapshotRes.status).toBe(201);
    expect(outreachRes.status).toBe(201);
    expect(objectionRes.status).toBe(201);
    expect(answerRes.status).toBe(201);

    expect(snapshotRes.body.packet.approvedPositioningBlocks.length).toBeGreaterThan(0);
    expect(snapshotRes.body.packet.citations.length).toBeGreaterThan(0);
    expect(snapshotRes.body.packet.whatStillNeedsSamantha).toEqual(
      expect.arrayContaining([expect.stringMatching(/approve/i)])
    );

    expect(outreachRes.body.packet.channelDraft).toEqual(
      expect.objectContaining({
        channel: "email",
        body: expect.stringMatching(/structured|project-based|attorney/i),
      })
    );
    expect(outreachRes.body.packet.riskFlags.length).toBeGreaterThan(0);

    expect(objectionRes.body.packet.channelDraft.objections).toEqual(
      expect.arrayContaining(["Why is LPC approval-based?", "How should the platform fee be explained?"])
    );
    expect(answerRes.body.packet.channelDraft.channel).toBe("prospect_answer");

    const storedPackets = await SalesDraftPacket.find({ accountId }).lean();
    expect(storedPackets).toHaveLength(5);
  });

  test("sales control room view reflects active accounts and pending review packets", async () => {
    const admin = await createAdmin();

    await request(app)
      .post("/api/admin/knowledge/sync")
      .set("Cookie", authCookieFor(admin))
      .send({});

    const accountRes = await request(app)
      .post("/api/admin/sales/accounts")
      .set("Cookie", authCookieFor(admin))
      .send({
        name: "Harbor Counsel",
        audienceType: "attorney",
        accountSummary: "Attorney account for awareness review.",
      });
    const accountId = accountRes.body.account._id;

    await request(app)
      .post(`/api/admin/sales/accounts/${accountId}/outreach-draft`)
      .set("Cookie", authCookieFor(admin))
      .send({});

    const summaryRes = await request(app)
      .get("/api/admin/ai/control-room/summary")
      .set("Cookie", authCookieFor(admin));
    const focusRes = await request(app)
      .get("/api/admin/ai/control-room/sales")
      .set("Cookie", authCookieFor(admin));

    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "cso",
          queues: expect.arrayContaining([
            expect.objectContaining({ label: "Pending review", value: 2 }),
            expect.objectContaining({ label: "Active accounts", value: 1 }),
          ]),
        }),
      ])
    );

    expect(focusRes.status).toBe(200);
    expect(focusRes.body.view.title).toBe("Sales / Awareness");
    expect(focusRes.body.view.quaternary.items).toEqual(
      expect.arrayContaining([expect.stringMatching(/outreach_draft/i)])
    );
  });
});
