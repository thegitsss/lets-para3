const AuditLog = require("../../models/AuditLog");
const SalesAccount = require("../../models/SalesAccount");
const SalesInteraction = require("../../models/SalesInteraction");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const User = require("../../models/User");
const { compactText } = require("./shared");
const { publishEventSafe } = require("../lpcEvents/publishEventService");

async function createAccount(payload = {}) {
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Sales account name is required.");

  let linkedUserId = payload.linkedUserId || null;
  if (linkedUserId) {
    const user = await User.findById(linkedUserId).select("_id").lean();
    if (!user) throw new Error("Linked user not found.");
  }

  const sourceType = payload.sourceType || "manual";
  const primaryEmail = String(payload.primaryEmail || "").trim().toLowerCase();
  const sourceFingerprint =
    sourceType === "public_contact" && primaryEmail ? `public_contact:${primaryEmail}` : String(payload.sourceFingerprint || "").trim();

  const account = await SalesAccount.create({
    name,
    companyName: String(payload.companyName || "").trim(),
    primaryEmail,
    audienceType: payload.audienceType || "general",
    roleLabel: String(payload.roleLabel || "").trim(),
    status: payload.status || "active",
    sourceType,
    sourceFingerprint,
    linkedUserId,
    accountSummary: String(payload.accountSummary || "").trim(),
    notes: String(payload.notes || "").trim(),
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    metadata: payload.metadata || {},
  });

  await publishEventSafe({
    eventType: "sales.account.created",
    eventFamily: "sales",
    idempotencyKey: `sales-account:${account._id}:created`,
    correlationId: `sales:${account._id}`,
    actor: {
      actorType: "system",
      userId: linkedUserId || null,
      label: "Sales Account Service",
    },
    subject: {
      entityType: "sales_account",
      entityId: String(account._id),
    },
    related: {
      userId: linkedUserId || null,
      salesAccountId: account._id,
    },
    source: {
      surface: "admin",
      route: "/api/admin/sales/accounts",
      service: "sales",
      producer: "service",
    },
    facts: {
      title: account.name,
      summary: account.accountSummary || account.notes || "",
      after: {
        primaryEmail,
        audienceType: account.audienceType || "",
        sourceType: account.sourceType || "",
      },
    },
    signals: {
      confidence: "high",
      priority: "normal",
      publicFacing: false,
    },
  });

  return account.toObject();
}

async function importPublicContactSignals() {
  const logs = await AuditLog.find({ action: "public.contact.submit" })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const created = [];
  for (const log of logs) {
    const email = String(log.meta?.email || "").trim().toLowerCase();
    if (!email) continue;
    const role = String(log.meta?.role || "").trim().toLowerCase();
    const audienceType = ["attorney", "paralegal"].includes(role) ? role : "general";
    const existing = await SalesAccount.findOne({ sourceFingerprint: `public_contact:${email}` }).lean();
    if (existing) continue;

    const account = await SalesAccount.create({
      name: email,
      primaryEmail: email,
      audienceType,
      roleLabel: role || "public lead",
      sourceType: "public_contact",
      sourceFingerprint: `public_contact:${email}`,
      accountSummary: `Public contact signal captured for ${email}${role ? ` with self-reported role ${role}` : ""}.`,
      metadata: {
        importedFromAuditLogId: String(log._id),
        importedAt: new Date().toISOString(),
      },
    });

    await SalesInteraction.create({
      accountId: account._id,
      interactionType: "public_contact_signal",
      direction: "inbound",
      summary: `Public contact submission captured for ${email}.`,
      rawText: "",
      metadata: {
        auditLogId: String(log._id),
        role: role || "",
        ip: log.ip || "",
        path: log.path || "",
        createdAt: log.createdAt || null,
      },
    });

    await publishEventSafe({
      eventType: "sales.account.created",
      eventFamily: "sales",
      idempotencyKey: `sales-account:${account._id}:created`,
      correlationId: `sales:${account._id}`,
      actor: {
        actorType: "system",
        label: "Sales Account Import",
      },
      subject: {
        entityType: "sales_account",
        entityId: String(account._id),
      },
      related: {
        salesAccountId: account._id,
      },
      source: {
        surface: "system",
        route: "",
        service: "sales",
        producer: "service",
      },
      facts: {
        title: account.name,
        summary: account.accountSummary || "",
        after: {
          primaryEmail: account.primaryEmail || "",
          audienceType: account.audienceType || "",
          sourceType: account.sourceType || "",
        },
      },
      signals: {
        confidence: "high",
        priority: "normal",
      },
    });

    created.push(account.toObject());
  }

  return created;
}

async function listAccounts({ limit = 50 } = {}) {
  return SalesAccount.find({})
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .lean();
}

async function getAccountById(accountId) {
  return SalesAccount.findById(accountId).lean();
}

async function getSalesOverview() {
  const [accountsCount, interactionsCount, packetsCount, pendingReviewCount, latestPackets, latestAccounts] = await Promise.all([
    SalesAccount.countDocuments({ status: "active" }),
    SalesInteraction.countDocuments({}),
    SalesDraftPacket.countDocuments({}),
    SalesDraftPacket.countDocuments({ approvalState: "pending_review" }),
    SalesDraftPacket.find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
    SalesAccount.find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
  ]);

  return {
    counts: {
      accounts: accountsCount,
      interactions: interactionsCount,
      packets: packetsCount,
      pendingReview: pendingReviewCount,
    },
    latestAccounts: latestAccounts.map((account) => ({
      id: String(account._id),
      name: account.name,
      companyName: account.companyName,
      audienceType: account.audienceType,
      roleLabel: account.roleLabel,
      primaryEmail: account.primaryEmail,
      sourceType: account.sourceType,
      accountSummary: compactText(account.accountSummary || account.notes || "", 150),
      updatedAt: account.updatedAt,
    })),
    latestPackets: latestPackets.map((packet) => ({
      id: String(packet._id),
      accountId: String(packet.accountId),
      packetType: packet.packetType,
      approvalState: packet.approvalState,
      packetSummary: packet.packetSummary,
      recommendedNextStep: packet.recommendedNextStep,
      updatedAt: packet.updatedAt,
    })),
  };
}

module.exports = {
  createAccount,
  getAccountById,
  getSalesOverview,
  importPublicContactSignals,
  listAccounts,
};
