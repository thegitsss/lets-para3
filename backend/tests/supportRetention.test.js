const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

process.env.STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "sk_test_support_retention_fixture";
process.env.EMAIL_DISABLE = "true";

const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const {
  SUPPORT_CONVERSATION_RETENTION_MS,
  SUPPORT_INACTIVITY_RESTART_MS,
  getOrCreateOpenConversation,
  pruneExpiredSupportHistory,
  restartConversation,
} = require("../services/support/conversationService");

describe("support conversation retention and active-memory reset", () => {
  beforeAll(async () => {
    await connect();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("removes expired conversations and their messages but retains current history", async () => {
    const userId = new mongoose.Types.ObjectId();
    const expired = await SupportConversation.create({
      userId,
      role: "attorney",
      status: "closed",
      lastMessageAt: new Date(Date.now() - SUPPORT_CONVERSATION_RETENTION_MS - 1000),
    });
    const current = await SupportConversation.create({
      userId,
      role: "attorney",
      status: "open",
      lastMessageAt: new Date(Date.now() - SUPPORT_CONVERSATION_RETENTION_MS + 60_000),
    });
    await SupportMessage.create([
      { conversationId: expired._id, sender: "user", text: "expired history" },
      { conversationId: current._id, sender: "user", text: "current history" },
    ]);

    await pruneExpiredSupportHistory({ force: true });

    expect(await SupportConversation.exists({ _id: expired._id })).toBeNull();
    expect(await SupportMessage.exists({ conversationId: expired._id })).toBeNull();
    expect(await SupportConversation.exists({ _id: current._id })).not.toBeNull();
    expect(await SupportMessage.exists({ conversationId: current._id })).not.toBeNull();
  });

  test("manual restart clears active context without deleting stored history", async () => {
    const userId = new mongoose.Types.ObjectId();
    const original = await SupportConversation.create({
      userId,
      role: "paralegal",
      status: "open",
      lastMessageAt: new Date(),
      metadata: {
        support: {
          activeTask: "FACT_LOOKUP",
          activeEntity: { type: "matter", id: "matter-1", name: "Smith" },
        },
      },
    });
    const oldMessage = await SupportMessage.create({
      conversationId: original._id,
      sender: "user",
      text: "What is the Smith matter status?",
    });

    const restarted = await restartConversation({
      conversationId: String(original._id),
      user: { _id: userId, role: "paralegal" },
    });

    const closed = await SupportConversation.findById(original._id).lean();
    const next = await SupportConversation.findById(restarted.conversation.id).lean();
    expect(closed.status).toBe("closed");
    expect(await SupportMessage.exists({ _id: oldMessage._id })).not.toBeNull();
    expect(next.metadata.support.activeTask).toBe("");
    expect(next.metadata.support.activeEntity).toBeNull();
  });

  test("24-hour inactivity starts fresh active context and preserves the closed history", async () => {
    const userId = new mongoose.Types.ObjectId();
    const original = await SupportConversation.create({
      userId,
      role: "attorney",
      status: "open",
      lastMessageAt: new Date(Date.now() - SUPPORT_INACTIVITY_RESTART_MS - 1000),
      metadata: {
        support: {
          activeTask: "FACT_LOOKUP",
          activeEntity: { type: "case", id: "matter-1", name: "Smith" },
        },
      },
    });
    const oldMessage = await SupportMessage.create({
      conversationId: original._id,
      sender: "assistant",
      text: "The Smith matter is in progress.",
    });

    const next = await getOrCreateOpenConversation({
      user: { _id: userId, role: "attorney", status: "approved" },
    });

    const closed = await SupportConversation.findById(original._id).lean();
    expect(closed.status).toBe("closed");
    expect(String(next._id)).not.toBe(String(original._id));
    expect(await SupportMessage.exists({ _id: oldMessage._id })).not.toBeNull();
    expect(next.metadata?.support?.activeEntity || null).toBeNull();
  });

  test("privacy policy states the implemented 183-day and restart behavior", () => {
    const privacy = fs.readFileSync(
      path.join(__dirname, "../../frontend/privacy.html"),
      "utf8"
    );
    const retentionSection = privacy.match(/<section id="retention"[\s\S]*?<\/section>/i)?.[0] || "";
    expect(retentionSection).toMatch(/Assistant conversations and associated messages/is);
    expect(retentionSection).toMatch(/support-assistant messages/is);
    expect(retentionSection).toMatch(/up to 183 days after the conversation’s last message/is);
    expect(retentionSection).toMatch(/Starting or restarting an Assistant conversation resets its active conversational context/is);
    expect(retentionSection).toMatch(/does not immediately delete earlier records/is);
    expect(retentionSection).toMatch(/scheduled cleanup removes eligible conversation and message records/is);
  });
});
