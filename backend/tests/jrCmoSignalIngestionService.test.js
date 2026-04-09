const SupportInsight = require("../models/SupportInsight");
const KnowledgeInsight = require("../models/KnowledgeInsight");
const { LpcEvent } = require("../models/LpcEvent");
const { collectInternalSignalInputs } = require("../services/marketing/jrCmoSignalIngestionService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("Jr. CMO signal ingestion service", () => {
  test("collects support, knowledge, and event signals into facts and opportunities", async () => {
    await SupportInsight.create({
      patternKey: "platform-explainer-gap",
      category: "platform_explainer",
      insightType: "confusion_pattern",
      title: "Users are asking what LPC actually does",
      summary: "Recent support traffic shows confusion around the platform's scope and workflow.",
      state: "active",
      repeatCount: 4,
      priority: "needs_review",
    });

    await KnowledgeInsight.create({
      sourceType: "manual",
      sourceId: "ops-note-1",
      title: "Workflow milestone is ready for marketing-safe use",
      summary: "A recent workflow update tightened the approval path and is safe for marketing planning.",
      audienceScopes: ["marketing_safe", "public_approved"],
      status: "promoted",
      tags: ["workflow", "update", "milestone"],
    });

    await LpcEvent.create({
      version: 1,
      eventType: "support.ticket.resolved",
      eventFamily: "support",
      occurredAt: new Date(),
      recordedAt: new Date(),
      subject: { entityType: "support_ticket", entityId: "ticket-1" },
      source: { surface: "system", service: "support", producer: "service" },
      signals: { confidence: "high", priority: "normal", founderVisible: true, publicFacing: false },
    });
    await LpcEvent.create({
      version: 1,
      eventType: "approval.approved",
      eventFamily: "approval",
      occurredAt: new Date(),
      recordedAt: new Date(),
      subject: { entityType: "approval_task", entityId: "task-1" },
      source: { surface: "system", service: "approvals", producer: "service" },
      signals: { confidence: "high", priority: "normal", founderVisible: true, publicFacing: false },
    });

    const result = await collectInternalSignalInputs();

    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "knowledge_insight",
          contentLaneHints: expect.arrayContaining(["updates_momentum"]),
        }),
      ])
    );
    expect(result.opportunities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opportunityKey: expect.stringMatching(/^support-signal:/),
          contentLane: "platform_explanation",
        }),
        expect.objectContaining({
          opportunityKey: expect.stringMatching(/^internal-momentum:/),
          contentLane: "updates_momentum",
        }),
      ])
    );
    expect(result.meta).toEqual(
      expect.objectContaining({
        supportInsightCount: 1,
        knowledgeInsightCount: 1,
        recentEventCount: 2,
      })
    );
  });
});
