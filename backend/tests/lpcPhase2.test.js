const User = require("../models/User");
const Incident = require("../models/Incident");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const SupportTicket = require("../models/SupportTicket");
const FAQCandidate = require("../models/FAQCandidate");
const { LpcAction } = require("../models/LpcAction");
const { LpcEvent } = require("../models/LpcEvent");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { publishEvent } = require("../services/lpcEvents/publishEventService");
const { getFounderCopilotRollup } = require("../services/founderCopilot/rollupService");
const { syncSourceRegistry } = require("../services/knowledge/syncService");
const { subscribeToConversationEvents } = require("../services/support/liveUpdateService");
const { createSupportTicket, updateTicketStatus } = require("../services/support/ticketService");

async function createUser(overrides = {}) {
  return User.create({
    firstName: "Test",
    lastName: "User",
    email: `phase2-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    role: "paralegal",
    status: "pending",
    state: "NY",
    termsAccepted: true,
    emailVerified: true,
    ...overrides,
  });
}

describe("LPC Phase 2 support routing", () => {
  beforeAll(async () => {
    await connect();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  test("routes support submission into SupportTicket when the issue is not clearly a product defect", async () => {
    await syncSourceRegistry();

    const { event } = await publishEvent({
      eventType: "support.submission.created",
      eventFamily: "support",
      idempotencyKey: "support-submission:general-1",
      actor: {
        actorType: "user",
        role: "visitor",
        email: "visitor@example.com",
        label: "Visitor",
      },
      subject: {
        entityType: "support_submission",
        entityId: "submission-general-1",
      },
      source: {
        surface: "public",
        route: "/api/public/contact",
        service: "support",
        producer: "route",
      },
      facts: {
        summary: "Support-style submission received.",
        after: {
          email: "visitor@example.com",
          role: "visitor",
          subject: "Why is LPC approval-based?",
          message: "I want the support-safe explanation for why LPC is approval-based.",
          sourceLabel: "Public contact form",
        },
      },
      signals: {
        confidence: "medium",
        priority: "normal",
        publicFacing: true,
      },
    });

    expect(event.routing.status).toBe("routed");
    expect(await SupportTicket.countDocuments({})).toBe(1);
    expect(await Incident.countDocuments({})).toBe(0);

    const ticket = await SupportTicket.findOne({ requesterEmail: "visitor@example.com" }).lean();
    expect(ticket).toBeTruthy();
    expect(["admissions", "platform_explainer", "general_support"]).toContain(ticket.classification.category);
    expect(ticket.linkedIncidentIds).toHaveLength(0);
    expect(ticket.latestResponsePacket.recommendedReply).toMatch(/approval-based/i);
  });

  test("routes blocker-style support submission into SupportTicket plus Incident", async () => {
    await syncSourceRegistry();

    const { event } = await publishEvent({
      eventType: "support.submission.created",
      eventFamily: "support",
      idempotencyKey: "support-submission:blocker-1",
      actor: {
        actorType: "user",
        role: "visitor",
        email: "blocked@example.com",
        label: "Blocked User",
      },
      subject: {
        entityType: "support_submission",
        entityId: "submission-blocker-1",
      },
      source: {
        surface: "public",
        route: "/api/public/contact",
        service: "support",
        producer: "route",
      },
      facts: {
        summary: "Support-style blocker submission received.",
        after: {
          email: "blocked@example.com",
          role: "visitor",
          subject: "Login error",
          message: "I cannot login and keep getting an unauthorized error. The page is broken and I am blocked.",
          routePath: "/login",
          sourceLabel: "Public contact form",
        },
      },
      signals: {
        confidence: "high",
        priority: "high",
        publicFacing: true,
      },
    });

    expect(event.routing.status).toBe("routed");
    expect(await SupportTicket.countDocuments({})).toBe(1);
    expect(await Incident.countDocuments({})).toBe(1);

    const ticket = await SupportTicket.findOne({ requesterEmail: "blocked@example.com" }).lean();
    const incident = await Incident.findOne({ "context.routePath": "/login" }).lean();

    expect(ticket.linkedIncidentIds.map(String)).toContain(String(incident._id));
    expect(ticket.routingSuggestion.ownerKey).toBe("incident_watch");
    expect(ticket.riskFlags).toEqual(expect.arrayContaining(["account_access"]));
  });

  test("links to an active incident instead of creating a duplicate incident", async () => {
    await syncSourceRegistry();

    const existingIncident = await Incident.create({
      publicId: "INC-20260321-300001",
      source: "help_form",
      summary: "Login failures are blocking access.",
      originalReportText: "Users cannot login and are blocked at the login page.",
      state: "investigating",
      classification: {
        domain: "auth",
        severity: "high",
        riskLevel: "high",
        confidence: "high",
      },
      context: {
        surface: "public",
        routePath: "/login",
        featureKey: "login",
      },
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
    });

    await publishEvent({
      eventType: "support.submission.created",
      eventFamily: "support",
      idempotencyKey: "support-submission:blocker-link-1",
      actor: {
        actorType: "user",
        role: "visitor",
        email: "again@example.com",
      },
      subject: {
        entityType: "support_submission",
        entityId: "submission-blocker-link-1",
      },
      source: {
        surface: "public",
        route: "/api/public/contact",
        service: "support",
        producer: "route",
      },
      facts: {
        after: {
          email: "again@example.com",
          role: "visitor",
          subject: "Login still broken",
          message: "I cannot login. It is broken and I am blocked from the login page.",
          routePath: "/login",
          sourceLabel: "Public contact form",
        },
      },
      signals: {
        confidence: "high",
        priority: "high",
      },
    });

    expect(await Incident.countDocuments({})).toBe(1);

    const ticket = await SupportTicket.findOne({ requesterEmail: "again@example.com" }).lean();
    expect(ticket.linkedIncidentIds.map(String)).toContain(String(existingIncident._id));
  });

  test("creates FAQCandidate from repeated stable resolved patterns when linked incidents are closed", async () => {
    await syncSourceRegistry();

    for (let index = 0; index < 2; index += 1) {
      const ticket = await createSupportTicket({
        requesterRole: "paralegal",
        requesterEmail: `faq-${index}@example.com`,
        sourceSurface: "paralegal",
        subject: "Why is LPC approval-based?",
        message: "I want the support-safe explanation for why LPC is approval-based.",
      });

      await updateTicketStatus({
        ticketId: ticket._id,
        status: "resolved",
        resolutionSummary: "Stable approval-based explanation confirmed.",
        resolutionIsStable: true,
      });
    }

    const candidates = await FAQCandidate.find({}).lean();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        approvalState: "pending_review",
        repeatCount: 2,
      })
    );
  });

  test("does not create FAQCandidate while linked incidents are still open, then creates one after incident resolution", async () => {
    await syncSourceRegistry();

    const incident = await Incident.create({
      publicId: "INC-20260321-300002",
      source: "help_form",
      summary: "Approval page is broken.",
      originalReportText: "The approval page is broken and blocks the workflow.",
      state: "investigating",
      classification: {
        domain: "approvals",
        severity: "high",
        riskLevel: "high",
        confidence: "high",
      },
      context: {
        surface: "paralegal",
        routePath: "/approvals",
        featureKey: "approval flow",
      },
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
    });

    for (let index = 0; index < 2; index += 1) {
      const ticket = await createSupportTicket({
        requesterRole: "paralegal",
        requesterEmail: `approval-${index}@example.com`,
        sourceSurface: "paralegal",
        routePath: "/approvals",
        subject: "Approval flow is broken",
        message: "The approval page is broken and I am blocked from continuing.",
      });

      expect(ticket.linkedIncidentIds.map(String)).toContain(String(incident._id));

      await updateTicketStatus({
        ticketId: ticket._id,
        status: "resolved",
        resolutionSummary: "Stable support-safe guidance captured.",
        resolutionIsStable: true,
      });
    }

    expect(await FAQCandidate.countDocuments({})).toBe(0);

    const liveIncident = await Incident.findById(incident._id);
    liveIncident.state = "resolved";
    liveIncident.resolution = {
      code: "fixed_deployed",
      summary: "Resolved cleanly.",
      resolvedAt: new Date(),
      closedAt: null,
    };
    await liveIncident.save();

    const candidates = await FAQCandidate.find({}).lean();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceIncidentIds.map(String)).toContain(String(incident._id));
  });

  test("auto-resolves linked support tickets when the engineering incident resolves", async () => {
    await syncSourceRegistry();

    const incident = await Incident.create({
      publicId: "INC-20260325-410001",
      source: "inline_help",
      summary: "Save Preferences issue",
      originalReportText: "The Save Preferences button is not working.",
      state: "investigating",
      classification: {
        domain: "profile",
        severity: "medium",
        riskLevel: "medium",
        confidence: "high",
      },
      context: {
        surface: "paralegal",
        routePath: "/profile-settings.html",
        featureKey: "preferences",
      },
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
    });

    const ticket = await createSupportTicket({
      requesterRole: "paralegal",
      requesterEmail: "save-preferences@example.com",
      sourceSurface: "paralegal",
      routePath: "/profile-settings.html",
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
    });

    const liveTicket = await SupportTicket.findById(ticket.id || ticket._id);
    liveTicket.linkedIncidentIds = [incident._id];
    await liveTicket.save();

    const liveIncident = await Incident.findById(incident._id);
    liveIncident.state = "resolved";
    liveIncident.resolution = {
      code: "fixed_deployed",
      summary: "The Save Preferences workflow was fixed and verified.",
      resolvedAt: new Date(),
      closedAt: null,
    };
    await liveIncident.save();

    const refreshedTicket = await SupportTicket.findById(liveTicket._id).lean();
    expect(refreshedTicket.status).toBe("resolved");
    expect(refreshedTicket.resolutionIsStable).toBe(true);
    expect(refreshedTicket.resolutionSummary).toMatch(/fixed and verified/i);
  });

  test("posts an assistant follow-up into linked support conversations when the incident resolves", async () => {
    await syncSourceRegistry();

    const user = await createUser({
      role: "paralegal",
      status: "approved",
      email: "resolved-conversation@example.com",
    });

    const conversation = await SupportConversation.create({
      userId: user._id,
      role: "paralegal",
      status: "escalated",
      sourceSurface: "paralegal",
      sourcePage: "/profile-settings.html",
      pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
      lastMessageAt: new Date(),
      escalation: {
        requested: true,
        requestedAt: new Date(),
      },
    });

    const incident = await Incident.create({
      publicId: "INC-20260325-410002",
      source: "inline_help",
      summary: "Save Preferences issue",
      originalReportText: "The Save Preferences button is not working.",
      state: "investigating",
      classification: {
        domain: "profile",
        severity: "medium",
        riskLevel: "medium",
        confidence: "high",
      },
      context: {
        surface: "paralegal",
        routePath: "/profile-settings.html",
        featureKey: "preferences",
      },
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
    });

    const ticket = await createSupportTicket({
      requesterRole: "paralegal",
      requesterUserId: user._id,
      requesterEmail: user.email,
      sourceSurface: "paralegal",
      routePath: "/profile-settings.html",
      pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
      conversationId: conversation._id,
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
    });

    const liveTicket = await SupportTicket.findById(ticket.id || ticket._id);
    liveTicket.linkedIncidentIds = [incident._id];
    await liveTicket.save();

    const conversationUpdatePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for the incident-resolved support update."));
      }, 3000);
      const unsubscribe = subscribeToConversationEvents(conversation._id, (payload) => {
        if (payload?.reason !== "incident.resolved_support_message") return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(payload);
      });
    });

    const liveIncident = await Incident.findById(incident._id);
    liveIncident.state = "resolved";
    liveIncident.resolution = {
      code: "fixed_deployed",
      summary: "The Save Preferences workflow was fixed and verified.",
      resolvedAt: new Date(),
      closedAt: null,
    };
    await liveIncident.save();

    const conversationUpdate = await conversationUpdatePromise;

    expect(conversationUpdate).toEqual(
      expect.objectContaining({
        type: "conversation.updated",
        reason: "incident.resolved_support_message",
        incidentId: String(incident._id),
        incidentPublicId: "INC-20260325-410002",
      })
    );

    const refreshedConversation = await SupportConversation.findById(conversation._id).lean();
    const followUpMessage = await SupportMessage.findOne({
      conversationId: conversation._id,
      sender: "assistant",
      "metadata.kind": "incident_resolution_follow_up",
      "metadata.incidentId": String(incident._id),
    })
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    expect(followUpMessage).toEqual(
      expect.objectContaining({
        sender: "assistant",
        text:
          "Great news - the issue you reported has been fixed by our engineering team. Please try again and let me know if everything is working!",
        metadata: expect.objectContaining({
          kind: "incident_resolution_follow_up",
          source: "lpc_event_router",
          incidentId: String(incident._id),
          incidentPublicId: "INC-20260325-410002",
        }),
      })
    );
    expect(new Date(refreshedConversation.lastMessageAt).getTime()).toBeGreaterThanOrEqual(
      new Date(followUpMessage.createdAt).getTime()
    );
  });

  test("dedupes support submission events by idempotency key", async () => {
    await syncSourceRegistry();

    const payload = {
      eventType: "support.submission.created",
      eventFamily: "support",
      idempotencyKey: "support-submission:dedupe-1",
      actor: {
        actorType: "user",
        role: "visitor",
        email: "dedupe@example.com",
      },
      subject: {
        entityType: "support_submission",
        entityId: "submission-dedupe-1",
      },
      source: {
        surface: "public",
        route: "/api/public/contact",
        service: "support",
        producer: "route",
      },
      facts: {
        after: {
          email: "dedupe@example.com",
          role: "visitor",
          subject: "Why is LPC approval-based?",
          message: "I want the support-safe explanation for why LPC is approval-based.",
          sourceLabel: "Public contact form",
        },
      },
      signals: {
        confidence: "medium",
        priority: "normal",
      },
    };

    const first = await publishEvent(payload);
    const second = await publishEvent(payload);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await LpcEvent.countDocuments({ eventType: "support.submission.created" })).toBe(1);
    expect(await SupportTicket.countDocuments({ requesterEmail: "dedupe@example.com" })).toBe(1);
  });

  test("preserves founder copilot and lifecycle behavior while support routing stays operational", async () => {
    const user = await createUser({ role: "attorney", status: "pending" });

    await publishEvent({
      eventType: "user.signup.created",
      eventFamily: "platform_user",
      idempotencyKey: `user:${user._id}:signup-phase2`,
      correlationId: `user:${user._id}`,
      actor: {
        actorType: "user",
        userId: user._id,
        role: user.role,
        email: user.email,
      },
      subject: {
        entityType: "user",
        entityId: String(user._id),
      },
      related: {
        userId: user._id,
      },
      source: {
        surface: "public",
        route: "/api/auth/register",
        service: "auth",
        producer: "route",
      },
      facts: {
        after: {
          email: user.email,
          role: user.role,
          status: user.status,
        },
      },
      signals: {
        confidence: "high",
        priority: "normal",
      },
    });

    await syncSourceRegistry();

    await publishEvent({
      eventType: "support.submission.created",
      eventFamily: "support",
      idempotencyKey: "support-submission:no-founder-noise",
      actor: {
        actorType: "user",
        role: "visitor",
        email: "support-noise@example.com",
      },
      subject: {
        entityType: "support_submission",
        entityId: "submission-no-founder-noise",
      },
      source: {
        surface: "public",
        route: "/api/public/contact",
        service: "support",
        producer: "route",
      },
      facts: {
        after: {
          email: "support-noise@example.com",
          role: "visitor",
          subject: "Why is LPC approval-based?",
          message: "I want the support-safe explanation for why LPC is approval-based.",
        },
      },
      signals: {
        confidence: "medium",
        priority: "normal",
      },
    });

    const rollup = await getFounderCopilotRollup();

    expect(rollup.lifecycle.totalOpen).toBe(1);
    expect(rollup.founder.urgentCount).toBe(0);
    expect(await LpcAction.countDocuments({ actionType: "founder_alert", status: "open" })).toBe(0);
  });
});
