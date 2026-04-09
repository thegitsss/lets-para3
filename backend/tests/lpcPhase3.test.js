const ApprovalTask = require("../models/ApprovalTask");
const KnowledgeCollection = require("../models/KnowledgeCollection");
const KnowledgeItem = require("../models/KnowledgeItem");
const KnowledgeRevision = require("../models/KnowledgeRevision");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const SalesDraftPacket = require("../models/SalesDraftPacket");
const { LpcAction } = require("../models/LpcAction");
const { LpcEvent } = require("../models/LpcEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { publishEvent } = require("../services/lpcEvents/publishEventService");
const { emitKnowledgeStaleDueEvents } = require("../services/lpcEvents/timedTriggerService");
const { createBrief } = require("../services/marketing/briefService");
const { approveMarketingPacket } = require("../services/marketing/reviewService");
const { createAccount } = require("../services/sales/accountService");
const { rejectSalesPacket } = require("../services/sales/reviewService");
const { syncSourceRegistry } = require("../services/knowledge/syncService");

function buildAdminActor(overrides = {}) {
  return {
    _id: overrides._id || null,
    id: overrides.id || overrides._id || null,
    email: overrides.email || "phase3-admin@example.com",
    firstName: overrides.firstName || "Phase3",
    lastName: overrides.lastName || "Admin",
  };
}

describe("LPC Phase 3 governed routing", () => {
  beforeAll(async () => {
    await connect();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("marketing.brief.created routes into MarketingDraftPacket and ApprovalTask", async () => {
    await syncSourceRegistry();

    const brief = await createBrief(
      {
        workflowType: "founder_linkedin_post",
        title: "Phase 3 marketing routing",
        targetAudience: "attorneys",
        objective: "Create a founder-safe marketing draft from the event spine.",
        briefSummary: "Internal draft only for LPC Phase 3 routing coverage.",
      },
      buildAdminActor()
    );

    const packet = await MarketingDraftPacket.findOne({ briefId: brief._id }).lean();
    const task = await ApprovalTask.findOne({
      taskType: "marketing_review",
      targetType: "marketing_draft_packet",
      targetId: String(packet?._id || ""),
      approvalState: "pending",
    }).lean();
    const founderAlert = await LpcAction.findOne({
      dedupeKey: `founder-alert:approval:marketing_draft_packet:${packet?._id}`,
      status: "open",
    }).lean();

    expect(packet).toBeTruthy();
    expect(packet.workflowType).toBe("founder_linkedin_post");
    expect(task).toBeTruthy();
    expect(founderAlert).toBeTruthy();
    expect(await LpcEvent.countDocuments({ eventType: "marketing.brief.created" })).toBe(1);
    expect(await LpcEvent.countDocuments({ eventType: "approval.requested" })).toBe(1);
  });

  test("sales.account.created routes into SalesDraftPacket account snapshot and ApprovalTask", async () => {
    await syncSourceRegistry();

    const account = await createAccount({
      name: "Phase 3 Counsel",
      primaryEmail: "phase3-counsel@example.com",
      audienceType: "attorney",
      companyName: "Phase 3 Counsel",
      roleLabel: "Managing attorney",
      accountSummary: "Attorney lead for account snapshot routing coverage.",
    });

    const packet = await SalesDraftPacket.findOne({
      accountId: account._id,
      packetType: "account_snapshot",
    }).lean();
    const task = await ApprovalTask.findOne({
      taskType: "sales_review",
      targetType: "sales_draft_packet",
      targetId: String(packet?._id || ""),
      approvalState: "pending",
    }).lean();
    const founderAlert = await LpcAction.findOne({
      dedupeKey: `founder-alert:approval:sales_draft_packet:${packet?._id}`,
      status: "open",
    }).lean();

    expect(packet).toBeTruthy();
    expect(packet.packetType).toBe("account_snapshot");
    expect(task).toBeTruthy();
    expect(founderAlert).toBeTruthy();
    expect(await LpcEvent.countDocuments({ eventType: "sales.account.created" })).toBe(1);
  });

  test("knowledge.item.drift_detected routes into pending KnowledgeRevision and ApprovalTask with idempotency", async () => {
    await syncSourceRegistry();

    const item = await KnowledgeItem.findOne({ key: "platform_lpc_core_explainer" }).lean();
    expect(item).toBeTruthy();

    const payload = {
      eventType: "knowledge.item.drift_detected",
      eventFamily: "knowledge",
      idempotencyKey: `knowledge-item:${item._id}:drift:phase3-drift-1`,
      correlationId: `knowledge:${item._id}`,
      actor: {
        actorType: "system",
        label: "Knowledge Sync Service",
      },
      subject: {
        entityType: "knowledge_item",
        entityId: String(item._id),
      },
      related: {
        knowledgeItemId: item._id,
      },
      source: {
        surface: "system",
        route: "backend/services/knowledge/sourceRegistry.js",
        service: "knowledge",
        producer: "service",
      },
      facts: {
        title: item.title,
        summary: `Registry drift detected for ${item.title}.`,
        sourceKey: "phase3-test",
        fingerprint: "phase3-drift-fingerprint-1",
        itemDef: {
          key: item.key,
          title: item.title,
          domain: item.domain,
          recordType: item.recordType,
          audienceScopes: item.audienceScopes,
          ownerLabel: item.ownerLabel,
          freshnessDays: item.freshnessDays,
          tags: item.tags,
          content: {
            summary: "Phase 3 drifted content that requires review before it can replace the approved revision.",
          },
          citations: [
            {
              sourceKey: "phase3-test",
              label: "Phase 3 drift test",
              filePath: "backend/tests/lpcPhase3.test.js",
              excerpt: "Drifted content for review.",
              locator: "phase3",
            },
          ],
        },
      },
      signals: {
        confidence: "high",
        priority: "high",
        founderVisible: true,
        publicFacing: true,
      },
    };

    const first = await publishEvent(payload);
    const second = await publishEvent(payload);
    const pendingRevision = await KnowledgeRevision.findOne({
      knowledgeItemId: item._id,
      fingerprint: "phase3-drift-fingerprint-1",
      approvalState: "pending_review",
    }).lean();
    const task = await ApprovalTask.findOne({
      taskType: "knowledge_review",
      targetType: "knowledge_revision",
      targetId: String(pendingRevision?._id || ""),
      approvalState: "pending",
    }).lean();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(pendingRevision).toBeTruthy();
    expect(task).toBeTruthy();
    expect(await LpcEvent.countDocuments({ eventType: "knowledge.item.drift_detected" })).toBe(1);
    expect(await KnowledgeRevision.countDocuments({ knowledgeItemId: item._id, fingerprint: "phase3-drift-fingerprint-1" })).toBe(1);
  });

  test("knowledge.item.stale_due creates founder alert for public approved items and lifecycle follow-up for internal items", async () => {
    const collection = await KnowledgeCollection.create({
      key: "phase3_collection",
      title: "Phase 3 Collection",
      description: "Phase 3 stale knowledge collection.",
      domain: "ops",
      audienceScopes: ["internal_ops"],
      ownerLabel: "Samantha",
      isActive: true,
    });

    const overdue = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const publicItem = await KnowledgeItem.create({
      key: "phase3_public_knowledge",
      title: "Phase 3 Public Knowledge",
      slug: "phase3-public-knowledge",
      collectionId: collection._id,
      domain: "platform",
      recordType: "policy_card",
      audienceScopes: ["public_approved"],
      approvalState: "approved",
      ownerLabel: "Samantha",
      freshnessDays: 30,
      nextReviewAt: overdue,
      isActive: true,
    });
    const internalItem = await KnowledgeItem.create({
      key: "phase3_internal_knowledge",
      title: "Phase 3 Internal Knowledge",
      slug: "phase3-internal-knowledge",
      collectionId: collection._id,
      domain: "ops",
      recordType: "policy_card",
      audienceScopes: ["internal_ops"],
      approvalState: "approved",
      ownerLabel: "Samantha",
      freshnessDays: 30,
      nextReviewAt: overdue,
      isActive: true,
    });
    const pendingItem = await KnowledgeItem.create({
      key: "phase3_pending_knowledge",
      title: "Phase 3 Pending Knowledge",
      slug: "phase3-pending-knowledge",
      collectionId: collection._id,
      domain: "ops",
      recordType: "policy_card",
      audienceScopes: ["public_approved"],
      approvalState: "pending_review",
      ownerLabel: "Samantha",
      freshnessDays: 30,
      nextReviewAt: overdue,
      isActive: true,
    });

    const result = await emitKnowledgeStaleDueEvents();

    const founderAlert = await LpcAction.findOne({
      dedupeKey: `founder-alert:knowledge-stale:${publicItem._id}`,
      status: "open",
    }).lean();
    const lifecycleFollowUp = await LpcAction.findOne({
      dedupeKey: `lifecycle:knowledge-stale:${internalItem._id}`,
      status: "open",
    }).lean();

    expect(result.emittedCount).toBe(3);
    expect(founderAlert).toBeTruthy();
    expect(lifecycleFollowUp).toBeTruthy();
    expect(await LpcAction.countDocuments({ dedupeKey: `founder-alert:knowledge-stale:${pendingItem._id}`, status: "open" })).toBe(0);
    expect(await LpcAction.countDocuments({ dedupeKey: `lifecycle:knowledge-stale:${pendingItem._id}`, status: "open" })).toBe(0);
  });

  test("approval request and decision events keep founder approval alerts event-backed", async () => {
    await syncSourceRegistry();

    const brief = await createBrief(
      {
        workflowType: "platform_update_announcement",
        title: "Phase 3 approval normalization",
        targetAudience: "attorneys",
        objective: "Verify approval event routing.",
        updateFacts: ["Phase 3 uses event-backed approval routing only."],
      },
      buildAdminActor({ email: "approval-phase3@example.com" })
    );
    const marketingPacket = await MarketingDraftPacket.findOne({ briefId: brief._id }).lean();
    const marketingAlertKey = `founder-alert:approval:marketing_draft_packet:${marketingPacket._id}`;

    expect(await LpcAction.countDocuments({ dedupeKey: marketingAlertKey, status: "open" })).toBe(1);

    await approveMarketingPacket({
      packetId: marketingPacket._id,
      actor: {
        actorType: "user",
        label: "approval-phase3@example.com",
      },
      note: "Approved for internal use only.",
    });

    const account = await createAccount({
      name: "Phase 3 Reject Account",
      primaryEmail: "phase3-reject@example.com",
      audienceType: "attorney",
      accountSummary: "Sales account used to verify rejection routing.",
    });
    const salesPacket = await SalesDraftPacket.findOne({
      accountId: account._id,
      packetType: "account_snapshot",
    }).lean();
    const salesAlertKey = `founder-alert:approval:sales_draft_packet:${salesPacket._id}`;

    expect(await LpcAction.countDocuments({ dedupeKey: salesAlertKey, status: "open" })).toBe(1);

    await rejectSalesPacket({
      packetId: salesPacket._id,
      actor: {
        actorType: "user",
        label: "approval-phase3@example.com",
      },
      note: "Rejected because the framing needs revision.",
    });

    const approvedEvent = await LpcEvent.findOne({
      eventType: "approval.approved",
      "facts.approvalTargetId": String(marketingPacket._id),
    }).lean();
    const rejectedEvent = await LpcEvent.findOne({
      eventType: "approval.rejected",
      "facts.approvalTargetId": String(salesPacket._id),
    }).lean();

    expect(approvedEvent).toBeTruthy();
    expect(rejectedEvent).toBeTruthy();
    expect(await LpcAction.countDocuments({ dedupeKey: marketingAlertKey, status: "open" })).toBe(0);
    expect(await LpcAction.countDocuments({ dedupeKey: salesAlertKey, status: "open" })).toBe(0);
    expect(await LpcAction.countDocuments({ dedupeKey: marketingAlertKey, status: "resolved" })).toBe(1);
    expect(await LpcAction.countDocuments({ dedupeKey: salesAlertKey, status: "resolved" })).toBe(1);
  });
});
