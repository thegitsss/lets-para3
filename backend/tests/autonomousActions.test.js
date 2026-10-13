const mongoose = require("mongoose");

const SupportTicket = require("../models/SupportTicket");
const AutonomousAction = require("../models/AutonomousAction");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const {
  getRecentActions,
  logAction,
  undoAction,
} = require("../services/ai/autonomousActionService");
const { scoreConfidence } = require("../services/ai/confidenceScorer");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

async function createTicket(overrides = {}) {
  return SupportTicket.create({
    subject: "Support issue",
    message: "Something broke in support.",
    latestUserMessage: "Please help.",
    ...overrides,
  });
}

describe("autonomous action foundation", () => {
  test("logAction rejects below threshold", async () => {
    const ticket = await createTicket();

    await expect(
      logAction({
        agentRole: "CCO",
        actionType: "ticket_resolved",
        confidenceScore: 0.9,
        confidenceReason: "The ticket looked stable but did not meet the strict closure threshold.",
        targetModel: "SupportTicket",
        targetId: ticket._id,
        changedFields: {
          status: "resolved",
        },
        previousValues: {
          status: "open",
        },
        actionTaken: "Marked the ticket resolved.",
      })
    ).rejects.toThrow(/below the minimum threshold/i);
  });

  test("logAction saves correctly above threshold", async () => {
    const ticket = await createTicket();

    const action = await logAction({
      agentRole: "CCO",
      actionType: "ticket_escalated",
      confidenceScore: 0.9,
      confidenceReason: "The user explicitly requested human help after the assistant had already offered escalation.",
      targetModel: "SupportTicket",
      targetId: ticket._id,
      changedFields: {
        status: "in_review",
        escalationReason: "human_help_requested",
      },
      previousValues: {
        status: "open",
        escalationReason: "",
      },
      actionTaken: "Escalated the support ticket for manual review.",
    });

    expect(action).toEqual(
      expect.objectContaining({
        agentRole: "CCO",
        actionType: "ticket_escalated",
        confidenceScore: 0.9,
        targetModel: "SupportTicket",
        status: "completed",
      })
    );

    const stored = await AutonomousAction.findById(action._id).lean();
    expect(stored).toEqual(
      expect.objectContaining({
        actionTaken: "Escalated the support ticket for manual review.",
        changedFields: {
          status: "in_review",
          escalationReason: "human_help_requested",
        },
        previousValues: {
          status: "open",
          escalationReason: "",
        },
      })
    );
  });

  test("undoAction restores changed fields only", async () => {
    const ticket = await createTicket({
      status: "resolved",
      resolutionSummary: "Resolved by autonomous support.",
      escalationReason: "bot_resolved",
      assistantSummary: "Keep this detail unchanged.",
    });

    const action = await logAction({
      agentRole: "CCO",
      actionType: "ticket_resolved",
      confidenceScore: 0.97,
      confidenceReason: "The ticket had a stable resolved signal and no risky support context.",
      targetModel: "SupportTicket",
      targetId: ticket._id,
      changedFields: {
        status: "resolved",
        resolutionSummary: "Resolved by autonomous support.",
        escalationReason: "bot_resolved",
      },
      previousValues: {
        status: "open",
        resolutionSummary: "",
        escalationReason: "",
      },
      actionTaken: "Resolved the support ticket after a stable support-safe outcome.",
    });

    const restored = await undoAction(action._id);

    expect(restored.status).toBe("open");
    expect(restored.resolutionSummary).toBe("");
    expect(restored.escalationReason).toBe("");
    expect(restored.assistantSummary).toBe("Keep this detail unchanged.");

    const storedAction = await AutonomousAction.findById(action._id).lean();
    expect(storedAction.status).toBe("undone");
    expect(storedAction.undoneAt).toEqual(expect.any(Date));
  });

  test("undoAction does NOT overwrite unrelated fields", async () => {
    const ticket = await createTicket({
      status: "in_review",
      escalationReason: "manual_review",
      assistantSummary: "Original summary.",
    });

    const action = await logAction({
      agentRole: "CCO",
      actionType: "ticket_escalated",
      confidenceScore: 0.9,
      confidenceReason: "The ticket was safely escalated after repeated unresolved user replies.",
      targetModel: "SupportTicket",
      targetId: ticket._id,
      changedFields: {
        status: "in_review",
        escalationReason: "manual_review",
      },
      previousValues: {
        status: "open",
        escalationReason: "",
      },
      actionTaken: "Escalated the support ticket.",
    });

    await SupportTicket.updateOne(
      { _id: ticket._id },
      {
        $set: {
          assistantSummary: "Updated after the autonomous action and should remain.",
        },
      }
    );

    const restored = await undoAction(action._id);
    expect(restored.status).toBe("open");
    expect(restored.escalationReason).toBe("");
    expect(restored.assistantSummary).toBe("Updated after the autonomous action and should remain.");
  });

  test("undoAction fails if already undone", async () => {
    const ticket = await createTicket({
      status: "resolved",
    });

    const action = await logAction({
      agentRole: "CCO",
      actionType: "ticket_resolved",
      confidenceScore: 0.98,
      confidenceReason: "The support-safe signals were fully aligned for closure.",
      targetModel: "SupportTicket",
      targetId: ticket._id,
      changedFields: {
        status: "resolved",
      },
      previousValues: {
        status: "open",
      },
      actionTaken: "Resolved the support ticket.",
    });

    await undoAction(action._id);

    await expect(undoAction(action._id)).rejects.toThrow(/already been undone/i);
  });

  test("scoreConfidence returns 0 on disqualifiers", () => {
    const score = scoreConfidence([
      { key: "involvesPayment", value: true, weight: 1 },
      { value: 1, weight: 2 },
    ]);

    expect(score).toBe(0);
  });

  test("scoreConfidence returns correct weighted value", () => {
    const score = scoreConfidence([
      { value: true, weight: 3 },
      { value: 0.5, weight: 1 },
    ]);

    expect(score).toBeCloseTo(0.875, 5);
  });

  test("getRecentActions returns newest actions first with projected fields", async () => {
    const firstTicket = await createTicket({ subject: "First" });
    const secondTicket = await createTicket({ subject: "Second" });

    await logAction({
      agentRole: "CCO",
      actionType: "ticket_escalated",
      confidenceScore: 0.9,
      confidenceReason: "The first ticket was safe to escalate.",
      targetModel: "SupportTicket",
      targetId: firstTicket._id,
      changedFields: { status: "in_review" },
      previousValues: { status: "open" },
      actionTaken: "Escalated the first ticket.",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await logAction({
      agentRole: "CCO",
      actionType: "ticket_reopened",
      confidenceScore: 0.9,
      confidenceReason: "The second ticket had an explicit still-broken follow-up.",
      targetModel: "SupportTicket",
      targetId: secondTicket._id,
      changedFields: { status: "open" },
      previousValues: { status: "resolved" },
      actionTaken: "Reopened the second ticket.",
    });

    const actions = await getRecentActions(10);
    expect(actions).toHaveLength(2);
    expect(actions[0].actionType).toBe("ticket_reopened");
    expect(actions[1].actionType).toBe("ticket_escalated");
    expect(Object.keys(actions[0]).sort()).toEqual(
      ["_id", "actionTaken", "actionType", "agentRole", "confidenceScore", "createdAt", "status", "targetId", "targetModel"].sort()
    );
  });

  test("AutonomousAction records cannot be deleted", async () => {
    const ticket = await createTicket();
    const action = await logAction({
      agentRole: "CCO",
      actionType: "ticket_escalated",
      confidenceScore: 0.9,
      confidenceReason: "The user explicitly asked for escalation.",
      targetModel: "SupportTicket",
      targetId: ticket._id,
      changedFields: { status: "in_review" },
      previousValues: { status: "open" },
      actionTaken: "Escalated the ticket.",
    });

    await expect(AutonomousAction.deleteOne({ _id: action._id })).rejects.toThrow(/append-only/i);
  });
});
