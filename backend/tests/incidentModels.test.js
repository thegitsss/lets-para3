const mongoose = require("mongoose");

const Incident = require("../models/Incident");
const IncidentEvent = require("../models/IncidentEvent");
const IncidentArtifact = require("../models/IncidentArtifact");
const IncidentInvestigation = require("../models/IncidentInvestigation");
const IncidentPatch = require("../models/IncidentPatch");
const IncidentVerification = require("../models/IncidentVerification");
const IncidentRelease = require("../models/IncidentRelease");
const IncidentApproval = require("../models/IncidentApproval");
const IncidentNotification = require("../models/IncidentNotification");
const {
  INCIDENT_STATES,
  INCIDENT_RISK_LEVELS,
  INCIDENT_APPROVAL_TYPES,
  INCIDENT_NOTIFICATION_TEMPLATE_KEYS,
  INCIDENT_VERIFICATION_CHECK_KEYS,
  ACTIVE_INCIDENT_RELEASE_STATUSES,
  DEPRECATED_INCIDENT_RELEASE_STATUSES,
} = require("../utils/incidentConstants");

describe("Incident model schema sanity", () => {
  test("incident models use explicit collection names", () => {
    expect(Incident.collection.collectionName).toBe("incidents");
    expect(IncidentEvent.collection.collectionName).toBe("incident_events");
    expect(IncidentArtifact.collection.collectionName).toBe("incident_artifacts");
    expect(IncidentInvestigation.collection.collectionName).toBe("incident_investigations");
    expect(IncidentPatch.collection.collectionName).toBe("incident_patches");
    expect(IncidentVerification.collection.collectionName).toBe("incident_verifications");
    expect(IncidentRelease.collection.collectionName).toBe("incident_releases");
    expect(IncidentApproval.collection.collectionName).toBe("incident_approvals");
    expect(IncidentNotification.collection.collectionName).toBe("incident_notifications");
  });

  test("schemas remain strict and versionless", () => {
    [
      Incident,
      IncidentEvent,
      IncidentArtifact,
      IncidentInvestigation,
      IncidentPatch,
      IncidentVerification,
      IncidentRelease,
      IncidentApproval,
      IncidentNotification,
    ].forEach((model) => {
      expect(model.schema.options.strict).toBe(true);
      expect(model.schema.options.versionKey).toBe(false);
    });
  });

  test("incident schema carries the canonical state and risk enums", () => {
    expect(Incident.schema.path("state").options.enum).toEqual(expect.arrayContaining(INCIDENT_STATES));
    expect(Incident.schema.path("classification.riskLevel").options.enum).toEqual(
      expect.arrayContaining(INCIDENT_RISK_LEVELS)
    );
  });

  test("critical write-once fields are schema-immutable", () => {
    expect(Incident.schema.path("publicId").options.immutable).toBe(true);
    expect(Incident.schema.path("originalReportText").options.immutable).toBe(true);
    expect(IncidentEvent.schema.path("incidentId").options.immutable).toBe(true);
    expect(IncidentPatch.schema.path("baseCommitSha").options.immutable).toBe(true);
    expect(IncidentRelease.schema.path("deployProvider").options.immutable).toBe(true);
    expect(IncidentApproval.schema.path("requestedAt").options.immutable).toBe(true);
    expect(IncidentNotification.schema.path("templateKey").options.immutable).toBe(true);
  });

  test("nested enums on approval, verification, and notification schemas match shared constants", () => {
    expect(IncidentApproval.schema.path("approvalType").options.enum).toEqual(
      expect.arrayContaining(INCIDENT_APPROVAL_TYPES)
    );
    expect(
      IncidentVerification.schema.path("requiredChecks").schema.path("key").options.enum
    ).toEqual(expect.arrayContaining(INCIDENT_VERIFICATION_CHECK_KEYS));
    expect(IncidentNotification.schema.path("templateKey").options.enum).toEqual(
      expect.arrayContaining(INCIDENT_NOTIFICATION_TEMPLATE_KEYS)
    );
  });

  test("deprecated preview_passed release status is compatibility-only and normalizes on validate", async () => {
    expect(ACTIVE_INCIDENT_RELEASE_STATUSES).not.toContain("preview_passed");
    expect(DEPRECATED_INCIDENT_RELEASE_STATUSES).toContain("preview_passed");

    const release = new IncidentRelease({
      incidentId: new mongoose.Types.ObjectId(),
      verificationId: new mongoose.Types.ObjectId(),
      attemptNumber: 1,
      status: "preview_passed",
      policyDecision: "blocked",
      previewVerificationStatus: "passed",
    });

    await release.validate();

    expect(release.status).toBe("preview_blocked");
    expect(release.previewVerificationStatus).toBe("blocked");
    expect(release.previewVerificationSummary).toMatch(/deprecated/i);
    expect(release.previewVerificationChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "legacy_preview_status",
          status: "blocked",
        }),
      ])
    );
  });

  test("schema indexes include the main queue and lookup keys", () => {
    const incidentIndexes = Incident.schema.indexes().map(([spec]) => spec);
    expect(incidentIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ publicId: 1 }),
        expect.objectContaining({ state: 1, updatedAt: -1 }),
        expect.objectContaining({ "orchestration.nextJobType": 1, "orchestration.nextJobRunAt": 1 }),
      ])
    );

    const eventIndexes = IncidentEvent.schema.indexes().map(([spec]) => spec);
    expect(eventIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ incidentId: 1, seq: 1 }),
      ])
    );
  });
});
