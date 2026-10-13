jest.mock("../models/Incident", () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
}));

jest.mock("../models/SupportTicket", () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock("../models/CtoAgentRun", () => ({
  findOne: jest.fn(),
}));

jest.mock("../models/CtoExecutionRun", () => ({
  findOne: jest.fn(),
}));

jest.mock("../services/incidents/controlRoomService", () => ({
  getIncidentDetail: jest.fn(),
  serializeIncidentSummary: jest.fn((incident = {}) => ({
    id: String(incident._id || ""),
    publicId: incident.publicId || "",
    state: incident.state || "",
    summary: incident.summary || "",
    approvalState: incident.approvalState || "",
  })),
}));

jest.mock("../services/incidents/workflowService", () => ({
  buildEventRecorder: jest.fn(),
  buildNextJobFields: jest.fn(() => ({
    nextJobType: "none",
    nextJobRunAt: new Date("2026-03-25T12:30:00.000Z"),
  })),
  clearIncidentLock: jest.fn(),
}));

const Incident = require("../models/Incident");
const SupportTicket = require("../models/SupportTicket");
const CtoAgentRun = require("../models/CtoAgentRun");
const CtoExecutionRun = require("../models/CtoExecutionRun");
const controlRoomService = require("../services/incidents/controlRoomService");
const workflowService = require("../services/incidents/workflowService");
const {
  listEngineeringItems,
  resolveEngineeringIncident,
} = require("../services/engineering/workspaceService");

function createChain(result) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe("engineering workspace service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("surfaces repeat support reports and sorts the queue by latest report activity", async () => {
    const olderIncident = {
      _id: "inc-old",
      publicId: "INC-OLD",
      summary: "Older dashboard issue",
      originalReportText: "dashboard button not working",
      state: "reported",
      approvalState: "not_needed",
      classification: { riskLevel: "low", severity: "low", domain: "ui" },
      context: { surface: "paralegal", routePath: "/dashboard-paralegal.html" },
      reporter: { role: "paralegal", email: "old@lets-paraconnect.test" },
      createdAt: new Date("2026-03-24T08:00:00.000Z"),
      updatedAt: new Date("2026-03-24T09:00:00.000Z"),
    };
    const repeatedIncident = {
      _id: "inc-repeat",
      publicId: "INC-REPEAT",
      summary: "Save Preferences issue",
      originalReportText: "save preferences button not working",
      state: "reported",
      approvalState: "not_needed",
      classification: { riskLevel: "low", severity: "low", domain: "profile" },
      context: { surface: "paralegal", routePath: "/profile-settings.html", featureKey: "preferences" },
      reporter: { role: "paralegal", email: "repeat@lets-paraconnect.test" },
      createdAt: new Date("2026-03-24T10:00:00.000Z"),
      updatedAt: new Date("2026-03-24T10:15:00.000Z"),
    };

    Incident.find.mockReturnValue(createChain([olderIncident, repeatedIncident]));
    controlRoomService.getIncidentDetail.mockImplementation(async (identifier) => ({
      incident: {
        id: identifier === "INC-OLD" ? "inc-old" : "inc-repeat",
      },
      latestInvestigation: null,
      latestPatch: null,
      latestVerification: null,
      latestApproval: null,
    }));

    CtoAgentRun.findOne.mockReturnValue(createChain(null));
    CtoExecutionRun.findOne.mockReturnValue(createChain(null));

    SupportTicket.find
      .mockReturnValueOnce(
        createChain([
          {
            _id: "ticket-old",
            subject: "Older dashboard issue",
            status: "open",
            urgency: "medium",
            requesterRole: "paralegal",
            requesterEmail: "old@lets-paraconnect.test",
            latestUserMessage: "dashboard button not working",
            updatedAt: new Date("2026-03-24T09:05:00.000Z"),
            createdAt: new Date("2026-03-24T09:00:00.000Z"),
          },
        ])
      )
      .mockReturnValueOnce(
        createChain([
          {
            _id: "ticket-repeat-2",
            subject: "Save Preferences issue",
            status: "open",
            urgency: "high",
            requesterRole: "paralegal",
            requesterEmail: "repeat2@lets-paraconnect.test",
            latestUserMessage: "save profile button still not working",
            updatedAt: new Date("2026-03-25T11:45:00.000Z"),
            createdAt: new Date("2026-03-25T11:44:00.000Z"),
          },
          {
            _id: "ticket-repeat-1",
            subject: "Save Preferences issue",
            status: "open",
            urgency: "medium",
            requesterRole: "paralegal",
            requesterEmail: "repeat1@lets-paraconnect.test",
            latestUserMessage: "save preferences button not working",
            updatedAt: new Date("2026-03-25T09:30:00.000Z"),
            createdAt: new Date("2026-03-25T09:29:00.000Z"),
          },
        ])
      );

    SupportTicket.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    SupportTicket.findOne
      .mockReturnValueOnce(
        createChain({
          _id: "ticket-old",
          subject: "Older dashboard issue",
          status: "open",
          urgency: "medium",
          requesterRole: "paralegal",
          requesterEmail: "old@lets-paraconnect.test",
          latestUserMessage: "dashboard button not working",
          updatedAt: new Date("2026-03-24T09:05:00.000Z"),
          createdAt: new Date("2026-03-24T09:00:00.000Z"),
        })
      )
      .mockReturnValueOnce(
        createChain({
          _id: "ticket-repeat-2",
          subject: "Save Preferences issue",
          status: "open",
          urgency: "high",
          requesterRole: "paralegal",
          requesterEmail: "repeat2@lets-paraconnect.test",
          latestUserMessage: "save profile button still not working",
          updatedAt: new Date("2026-03-25T11:45:00.000Z"),
          createdAt: new Date("2026-03-25T11:44:00.000Z"),
        })
      );

    const items = await listEngineeringItems({ limit: 12 });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(
      expect.objectContaining({
        publicId: "INC-REPEAT",
        linkedSupportCount: 2,
        additionalSupportReportCount: 1,
        additionalSupportReportLabel: "+1 new user report",
        lastReportedAt: new Date("2026-03-25T11:45:00.000Z"),
        urgency: expect.objectContaining({
          severity: "Low",
          affectedUsers: 2,
          affectedUsersLabel: "2 affected users",
          visualLevel: "low",
        }),
        recommendedNextAction: expect.objectContaining({
          actionType: "run_diagnosis",
          label: "Run Diagnosis",
        }),
        latestSupportReport: expect.objectContaining({
          latestUserMessage: "save profile button still not working",
        }),
      })
    );
    expect(items[1]).toEqual(
      expect.objectContaining({
        publicId: "INC-OLD",
        linkedSupportCount: 1,
        additionalSupportReportCount: 0,
        additionalSupportReportLabel: "",
      })
    );
  });

  test("marks an engineering item resolved and returns the resolved detail payload", async () => {
    const recorder = {
      push: jest.fn(),
      finalize: jest.fn(),
      save: jest.fn(async () => []),
    };
    workflowService.buildEventRecorder.mockReturnValue(recorder);

    const incidentDoc = {
      _id: "inc-ready",
      publicId: "INC-READY",
      summary: "Save flow fix is ready",
      originalReportText: "save profile still fails",
      state: "awaiting_verification",
      approvalState: "not_needed",
      userVisibleStatus: "testing_fix",
      adminVisibleStatus: "active",
      classification: { riskLevel: "high", severity: "high", domain: "profile" },
      context: { surface: "paralegal", routePath: "/profile-settings.html", featureKey: "preferences" },
      reporter: { role: "paralegal", email: "ready@lets-paraconnect.test" },
      orchestration: {},
      resolution: {},
      createdAt: new Date("2026-03-25T08:00:00.000Z"),
      updatedAt: new Date("2026-03-25T11:00:00.000Z"),
      save: jest.fn(async function save() {
        return this;
      }),
      toObject() {
        return {
          _id: this._id,
          publicId: this.publicId,
          summary: this.summary,
          originalReportText: this.originalReportText,
          state: this.state,
          approvalState: this.approvalState,
          userVisibleStatus: this.userVisibleStatus,
          adminVisibleStatus: this.adminVisibleStatus,
          classification: this.classification,
          context: this.context,
          reporter: this.reporter,
          orchestration: this.orchestration,
          resolution: this.resolution,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
        };
      },
    };

    Incident.findOne.mockResolvedValue(incidentDoc);
    controlRoomService.getIncidentDetail.mockResolvedValue({
      incident: { id: "inc-ready" },
      latestInvestigation: null,
      latestPatch: { status: "completed" },
      latestVerification: null,
      latestApproval: null,
    });

    CtoAgentRun.findOne.mockImplementation(() =>
      createChain({
        _id: "cto-ready",
        category: "profile_save",
        urgency: "high",
        technicalSeverity: "high",
        diagnosisSummary: "The execution packet should be enough to finish the save fix.",
        recommendedFixStrategy: "Apply the save handler fix and verify the UI state reset.",
        generatedAt: new Date("2026-03-25T10:00:00.000Z"),
      })
    );
    CtoExecutionRun.findOne.mockImplementation(() =>
      createChain({
        _id: "exec-ready",
        ctoRunId: "cto-ready",
        executionStatus: "ready_for_test",
        implementationSummary: "Patch applied and ready for verification.",
        resolutionMessageDraft: "The issue is fixed and ready for the user to retry.",
        generatedAt: new Date("2026-03-25T10:30:00.000Z"),
      })
    );

    SupportTicket.find.mockImplementation(() =>
      createChain([
        {
          _id: "ticket-ready",
          subject: "Save profile issue",
          status: "open",
          urgency: "high",
          requesterRole: "paralegal",
          requesterEmail: "ready@lets-paraconnect.test",
          latestUserMessage: "save profile still fails",
          updatedAt: new Date("2026-03-25T11:45:00.000Z"),
          createdAt: new Date("2026-03-25T11:44:00.000Z"),
        },
      ])
    );
    SupportTicket.countDocuments.mockResolvedValue(1);
    SupportTicket.findOne.mockImplementation(() =>
      createChain({
        _id: "ticket-ready",
        subject: "Save profile issue",
        status: "open",
        urgency: "high",
        requesterRole: "paralegal",
        requesterEmail: "ready@lets-paraconnect.test",
        latestUserMessage: "save profile still fails",
        updatedAt: new Date("2026-03-25T11:45:00.000Z"),
        createdAt: new Date("2026-03-25T11:44:00.000Z"),
      })
    );

    const result = await resolveEngineeringIncident({
      incidentIdentifier: "INC-READY",
      actor: { userId: "67f0f1f1f1f1f1f1f1f1f1f1", role: "admin" },
    });

    expect(result.alreadyResolved).toBe(false);
    expect(incidentDoc.state).toBe("resolved");
    expect(incidentDoc.userVisibleStatus).toBe("fixed_live");
    expect(incidentDoc.adminVisibleStatus).toBe("resolved");
    expect(incidentDoc.resolution).toEqual(
      expect.objectContaining({
        code: "fixed_deployed",
        summary: "The issue is fixed and ready for the user to retry.",
        resolvedAt: expect.any(Date),
      })
    );
    expect(incidentDoc.save).toHaveBeenCalledTimes(1);
    expect(recorder.push).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "state_changed",
        fromState: "awaiting_verification",
        toState: "resolved",
      })
    );
    expect(recorder.finalize).toHaveBeenCalledTimes(1);
    expect(recorder.save).toHaveBeenCalledTimes(1);
    expect(result.item).toEqual(
      expect.objectContaining({
        publicId: "INC-READY",
        engineeringStatus: "Resolved",
        recommendedNextAction: expect.objectContaining({
          actionType: "open_incident_workspace",
          label: "Review Resolution",
        }),
        resolveAction: null,
      })
    );
  });
});
