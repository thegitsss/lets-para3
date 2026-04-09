const Incident = require("../models/Incident");
const IncidentNotification = require("../models/IncidentNotification");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const SupportTicket = require("../models/SupportTicket");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

jest.mock("../utils/email", () => jest.fn(async () => ({ messageId: "mock-message-id" })));

const sendEmail = require("../utils/email");
const { notifyFounderSupportEngineeringIssue, syncIncidentNotifications } = require("../services/incidents/notificationService");

function buildIncident(overrides = {}) {
  return Incident.create({
    publicId: overrides.publicId || `INC-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: "inline_help",
    reporter: {
      userId: null,
      role: "paralegal",
      email: "paralegal@example.com",
    },
    context: {
      surface: "paralegal",
      routePath: "/profile-settings.html",
      pageUrl: "/profile-settings.html",
      featureKey: "preferences_save",
    },
    summary: "Save Preferences button is not working",
    originalReportText: "the Save Preferences button isnt working",
    state: "reported",
    classification: {
      domain: "unknown",
      severity: "low",
      riskLevel: "low",
      confidence: "medium",
    },
    approvalState: "not_needed",
    autonomyMode: "full_auto",
    userVisibleStatus: "received",
    adminVisibleStatus: "new",
    orchestration: {
      nextJobType: "intake_validation",
      nextJobRunAt: new Date(),
    },
    lastEventSeq: 0,
    ...overrides,
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
  jest.clearAllMocks();
  process.env.INCIDENT_FOUNDER_ALERT_EMAILS = "admin@lets-paraconnect.com";
  process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";
});

describe("Founder engineering issue emails", () => {
  test("emails the founder once when a support chat issue becomes an engineering incident", async () => {
    const incident = await buildIncident();

    await notifyFounderSupportEngineeringIssue({
      incident,
      ticket: { id: "ticket-1", reference: "SUP-123ABC" },
      diagnosisKickoff: { started: true, reused: false },
      linkedToExisting: false,
    });

    await notifyFounderSupportEngineeringIssue({
      incident,
      ticket: { id: "ticket-1", reference: "SUP-123ABC" },
      diagnosisKickoff: { started: true, reused: false },
      linkedToExisting: false,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      "admin@lets-paraconnect.com",
      expect.stringMatching(/new engineering issue from support/i),
      expect.stringContaining("Save Preferences button is not working"),
      expect.objectContaining({
        text: expect.stringContaining("Engineering diagnosis started automatically."),
      })
    );

    const founderNotifications = await IncidentNotification.find({
      incidentId: incident._id,
      audience: "founder",
      channel: "email",
      templateKey: "received",
    }).lean();

    expect(founderNotifications).toHaveLength(1);
  });

  test("emails the founder once when a support-linked engineering incident is fixed", async () => {
    const incident = await buildIncident({
      publicId: "INC-TEST-FIXED-1",
      state: "resolved",
      userVisibleStatus: "fixed_live",
      resolution: {
        code: "fixed_deployed",
        summary: "Restored the Save Preferences submit handler.",
        resolvedAt: new Date(),
      },
    });

    await syncIncidentNotifications({ incident });
    await syncIncidentNotifications({ incident });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      "admin@lets-paraconnect.com",
      expect.stringMatching(/fixed engineering issue/i),
      expect.stringContaining("A support-linked engineering issue is now fixed."),
      expect.objectContaining({
        text: expect.stringContaining("Restored the Save Preferences submit handler."),
      })
    );

    const founderFixedNotifications = await IncidentNotification.find({
      incidentId: incident._id,
      audience: "founder",
      channel: "email",
      templateKey: "fixed_live",
    }).lean();

    expect(founderFixedNotifications).toHaveLength(1);
  });

  test("posts one support-thread update when a support-linked issue reaches final review", async () => {
    const conversation = await SupportConversation.create({
      userId: new Incident()._id,
      role: "paralegal",
      status: "escalated",
      sourceSurface: "paralegal",
      sourcePage: "/profile-settings.html",
      pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
      lastMessageAt: new Date(),
    });

    const incident = await buildIncident({
      publicId: "INC-TEST-THREAD-REVIEW-1",
      state: "awaiting_founder_approval",
      userVisibleStatus: "awaiting_internal_review",
      adminVisibleStatus: "awaiting_approval",
    });

    await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "open",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterEmail: "paralegal@example.com",
      conversationId: conversation._id,
      routePath: "/profile-settings.html",
      pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
      linkedIncidentIds: [incident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    await syncIncidentNotifications({ incident });
    await syncIncidentNotifications({ incident });

    const messages = await SupportMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        sender: "system",
        text: "A fix for the issue you reported (Save Preferences button is not working) is under final review now. I'll share another update here as soon as that review is complete.",
        metadata: expect.objectContaining({
          kind: "support_status_update",
          source: "incident_lifecycle",
          lifecycleStatusKey: "awaiting_internal_review",
        }),
      })
    );
  });

  test("posts one support-thread resolved update when a support-linked engineering issue is fixed", async () => {
    const conversation = await SupportConversation.create({
      userId: new Incident()._id,
      role: "paralegal",
      status: "escalated",
      sourceSurface: "paralegal",
      sourcePage: "/profile-settings.html",
      pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
      lastMessageAt: new Date(),
    });

    const incident = await buildIncident({
      publicId: "INC-TEST-THREAD-FIXED-1",
      state: "resolved",
      userVisibleStatus: "fixed_live",
      resolution: {
        code: "fixed_deployed",
        summary: "Restored the Save Preferences submit handler.",
        resolvedAt: new Date(),
      },
    });

    await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "open",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterEmail: "paralegal@example.com",
      conversationId: conversation._id,
      routePath: "/profile-settings.html",
      pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
      linkedIncidentIds: [incident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    await syncIncidentNotifications({ incident });
    await syncIncidentNotifications({ incident });

    const messages = await SupportMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        sender: "system",
        text: "The issue you reported (Save Preferences button is not working) has been resolved. If it's still happening, reply here and we'll reopen it.",
        metadata: expect.objectContaining({
          kind: "support_status_update",
          source: "incident_lifecycle",
          lifecycleStatusKey: "fixed_live",
        }),
      })
    );
  });
});
