const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");
const { PassThrough } = require("stream");

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn(async () => "https://signed-url.test/object");

jest.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor() {
      this.send = mockSend;
    }
  }
  class PutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class DeleteObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class HeadObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class GetObjectTaggingCommand {
    constructor(input) {
      this.input = input;
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectTaggingCommand };
});

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args) => mockGetSignedUrl(...args),
}));

const User = require("../models/User");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const uploadsRouter = require("../routes/uploads");
const casesRouter = require("../routes/cases");
const notificationsRouter = require("../routes/notifications");
const sendEmail = require("../utils/email");
const { buildCaseFileKeyQuery } = require("../utils/dataEncryption");
const { resetWorkspacePresence } = require("../utils/workspacePresence");
const { addSubscriber: addCaseSubscriber } = require("../utils/caseEvents");
const { addSubscriber: addNotificationSubscriber } = require("../utils/notificationEvents");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/uploads", uploadsRouter);
  instance.use("/api/cases", casesRouter);
  instance.use("/api/notifications", notificationsRouter);
  instance.use((err, _req, res, _next) => {
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
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

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  mockSend.mockReset();
  mockGetSignedUrl.mockClear();
  sendEmail.mockClear();
  await resetWorkspacePresence();
  mockSend.mockImplementation((cmd) => {
    const key = cmd?.input?.Key || "";
    if (String(key).includes("missing")) {
      const err = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    if (cmd?.constructor?.name === "GetObjectCommand") {
      return { Body: { transformToByteArray: async () => Buffer.from("%PDF-1.4\ntest document") } };
    }
    return {};
  });
});

describe("File uploads + downloads", () => {
  test("Retired attachment probes do not report false upload success", async () => {
    const attorney = await User.create({
      firstName: "Upload",
      lastName: "Probe",
      email: "upload.probe@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const response = await request(app)
      .post("/api/uploads/attach")
      .set("Cookie", authCookieFor(attorney))
      .send({});

    expect(response.status).toBe(404);
  });

  test("Profile-photo upload stores private object keys and returns only LPC delivery URLs", async () => {
    const paralegal = await User.create({
      firstName: "Photo",
      lastName: "Privacy",
      email: "photo.privacy@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const response = await request(app)
      .post("/api/uploads/profile-photo")
      .set("Cookie", authCookieFor(paralegal))
      .attach("file", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), {
        filename: "profile.jpg",
        contentType: "image/jpeg",
      })
      .attach("original", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: "original.png",
        contentType: "image/png",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      pending: true,
      status: "pending_review",
    });
    expect(response.body.url).toContain(`/api/users/profile-photo/${paralegal._id}?variant=pending`);
    expect(response.body.pendingProfileImageOriginal).toContain(
      `/api/users/profile-photo/${paralegal._id}?variant=pending-original`
    );
    expect(JSON.stringify(response.body)).not.toMatch(/amazonaws\.com|profile-photos\//i);

    const putInputs = mockSend.mock.calls
      .map(([command]) => command?.input)
      .filter((input) => input?.Key?.startsWith(`profile-photos/${paralegal._id}/`));
    expect(putInputs).toHaveLength(2);
    expect(putInputs.every((input) => !("ACL" in input))).toBe(true);

    const stored = await User.findById(paralegal._id)
      .select("+pendingProfileImageKey +pendingProfileImageOriginalKey")
      .lean();
    expect(stored.pendingProfileImageKey).toMatch(
      new RegExp(`^profile-photos/${paralegal._id}/profile-[0-9]+-[a-f0-9]{12}\\.jpg$`)
    );
    expect(stored.pendingProfileImageOriginalKey).toMatch(
      new RegExp(`^profile-photos/${paralegal._id}/original-[0-9]+-[a-f0-9]{12}\\.png$`)
    );
    expect(stored.pendingProfileImage).toContain(`/api/users/profile-photo/${paralegal._id}?variant=pending`);
  });

  test("Paralegal recrop stays pending and changes the private delivery cache version token", async () => {
    const paralegal = await User.create({
      firstName: "Cache",
      lastName: "Refresh",
      email: "cache.refresh@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      profilePhotoStatus: "approved",
      profileImage: "https://test-bucket.s3.us-east-1.amazonaws.com/profile-photos/64b000000000000000000001/profile-1700000000000.jpg",
      avatarURL: "https://test-bucket.s3.us-east-1.amazonaws.com/profile-photos/64b000000000000000000001/profile-1700000000000.jpg",
    });
    const previousVersion = String(paralegal.updatedAt.getTime());

    const response = await request(app)
      .post("/api/uploads/profile-photo")
      .set("Cookie", authCookieFor(paralegal))
      .field("editExisting", "true")
      .attach("file", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), {
        filename: "replacement.jpg",
        contentType: "image/jpeg",
      });

    expect(response.status).toBe(200);
    expect(response.body.pending).toBe(true);
    expect(response.body.status).toBe("pending_review");
    const delivered = new URL(response.body.url, "https://www.lets-paraconnect.com");
    expect(delivered.pathname).toBe(`/api/users/profile-photo/${paralegal._id}`);
    expect(delivered.searchParams.get("variant")).toBe("pending");
    expect(delivered.searchParams.get("v")).toMatch(/^[0-9]+$/);
    expect(delivered.searchParams.get("v")).not.toBe(previousVersion);
  });

  test("Presign upload returns signed URL for funded case", async () => {
    // Description: Assigned paralegal requests presigned upload for funded case.
    // Input values: contentType="application/pdf", ext="pdf", size=1024.
    // Expected result: 200 OK with signed url and key.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "Upload test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_123",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const signedUrl = "https://signed-url.test/object?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match";
    mockGetSignedUrl.mockResolvedValueOnce(signedUrl);
    const res = await request(app)
      .post("/api/uploads/presign")
      .set("Cookie", authCookieFor(paralegal))
      .send({
        caseId: caseDoc._id,
        contentType: "application/pdf",
        ext: "pdf",
        size: 1024,
      });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(signedUrl);
    expect(res.body.requiredHeaders).toEqual({ "content-type": "application/pdf", "if-none-match": "*" });
    expect(res.body.key).toContain(`cases/${caseDoc._id}`);
  });

  test("Presign upload rejects invalid content type", async () => {
    // Description: Content type blocked by server.
    // Input values: contentType="text/html".
    // Expected result: 400 with "Type not allowed".

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone2@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng2@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Contract review",
      details: "Upload test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_234",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .post("/api/uploads/presign")
      .set("Cookie", authCookieFor(paralegal))
      .send({
        caseId: caseDoc._id,
        contentType: "text/html",
        ext: "html",
        size: 1024,
      });
    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/Type not allowed/i);
  });

  test("Signed-get returns 404 for missing key", async () => {
    // Description: Signed URL requested for missing object.
    // Input values: key="cases/<id>/documents/missing.pdf".
    // Expected result: 404 File not found.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone3@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng3@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "Upload test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_345",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const key = `cases/${caseDoc._id}/documents/missing.pdf`;
    const res = await request(app)
      .get(`/api/uploads/signed-get?caseId=${caseDoc._id}&key=${encodeURIComponent(key)}`)
      .set("Cookie", authCookieFor(paralegal));
    expect(res.status).toBe(404);
    expect(res.body.msg).toMatch(/File not found/i);
  });

  test("Matter File signed access remains participant-only and rejects anonymous, unrelated, and revoked viewers", async () => {
    const attorney = await User.create({
      firstName: "File",
      lastName: "Owner",
      email: "file.owner@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const assigned = await User.create({
      firstName: "Assigned",
      lastName: "Viewer",
      email: "assigned.viewer@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const unrelated = await User.create({
      firstName: "Unrelated",
      lastName: "Viewer",
      email: "unrelated.viewer@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Private Matter file",
      details: "Matter File access regression.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: assigned._id,
      paralegalId: assigned._id,
      escrowIntentId: "pi_private_file",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });
    const key = `cases/${caseDoc._id}/documents/private.pdf`;
    await CaseFile.create({
      caseId: caseDoc._id,
      userId: attorney._id,
      originalName: "private.pdf",
      storageKey: key,
      mimeType: "application/pdf",
      size: 1234,
      securityStatus: "not_required",
      securityScanResult: "NOT_REQUIRED",
    });
    const path = `/api/uploads/signed-get?caseId=${caseDoc._id}&key=${encodeURIComponent(key)}`;

    const authorized = await request(app).get(path).set("Cookie", authCookieFor(assigned));
    expect(authorized.status).toBe(200);
    expect(authorized.body.url).toBe("https://signed-url.test/object");

    const anonymous = await request(app).get(path);
    expect(anonymous.status).toBe(401);

    const unrelatedResponse = await request(app).get(path).set("Cookie", authCookieFor(unrelated));
    expect(unrelatedResponse.status).toBe(403);

    caseDoc.paralegalAccessRevokedAt = new Date();
    await caseDoc.save();
    const revoked = await request(app).get(path).set("Cookie", authCookieFor(assigned));
    expect(revoked.status).toBe(403);
  });

  test.each([
    [[], 423, "FILE_SCAN_PENDING"],
    [[{ Key: "GuardDutyMalwareScanStatus", Value: "THREATS_FOUND" }], 422, "FILE_SECURITY_BLOCKED"],
    [[{ Key: "GuardDutyMalwareScanStatus", Value: "FAILED" }], 503, "FILE_SCAN_ERROR"],
  ])("Matter file access fails closed for scan result %#", async (tagSet, status, code) => {
    const previousRequired = process.env.S3_MALWARE_SCAN_REQUIRED;
    process.env.S3_MALWARE_SCAN_REQUIRED = "true";
    try {
      const attorney = await User.create({
        firstName: "Scan",
        lastName: "Owner",
        email: `scan.owner.${status}@example.com`,
        password: "Password123!",
        role: "attorney",
        status: "approved",
        state: "CA",
      });
      const paralegal = await User.create({
        firstName: "Scan",
        lastName: "Viewer",
        email: `scan.viewer.${status}@example.com`,
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        state: "CA",
      });
      const caseDoc = await Case.create({
        title: "Quarantined Matter file",
        details: "File scan access regression.",
        status: "in progress",
        attorney: attorney._id,
        attorneyId: attorney._id,
        paralegal: paralegal._id,
        paralegalId: paralegal._id,
        escrowIntentId: `pi_scan_${status}`,
        escrowStatus: "funded",
        totalAmount: 100000,
        currency: "usd",
      });
      const key = `cases/${caseDoc._id}/documents/quarantined.pdf`;
      const record = await CaseFile.create({
        caseId: caseDoc._id,
        userId: attorney._id,
        originalName: "quarantined.pdf",
        storageKey: key,
        mimeType: "application/pdf",
        size: 1234,
        securityStatus: "pending",
        securityScanResult: "PENDING",
      });
      mockSend.mockImplementation((command) => {
        if (command?.constructor?.name === "GetObjectTaggingCommand") return { TagSet: tagSet };
        return {};
      });

      const response = await request(app)
        .get(`/api/uploads/signed-get?caseId=${caseDoc._id}&key=${encodeURIComponent(key)}`)
        .set("Cookie", authCookieFor(paralegal));
      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
      const refreshed = await CaseFile.findById(record._id).lean();
      expect(refreshed.securityStatus).toBe(status === 423 ? "pending" : status === 422 ? "blocked" : "error");
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    } finally {
      if (previousRequired == null) delete process.env.S3_MALWARE_SCAN_REQUIRED;
      else process.env.S3_MALWARE_SCAN_REQUIRED = previousRequired;
    }
  });

  test("Requested pre-engagement paralegal can access confidentiality document signed-get", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone-pre@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng-pre@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const key = `cases/${new mongoose.Types.ObjectId()}/pre-engagement/confidentiality-agreement.pdf`;
    const caseId = key.match(/cases\/([a-f0-9]{24})\//i)?.[1];
    const caseDoc = await Case.create({
      _id: caseId,
      title: "Pre-engagement confidentiality review",
      details: "Requested confidentiality review before hire.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 50000,
      currency: "usd",
      tasks: [{ title: "Prepare first draft", completed: false }],
      preEngagement: {
        status: "requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: true,
        conflictsCheckRequired: false,
        confidentialityDocument: {
          key,
          name: "confidentiality-agreement.pdf",
          mimeType: "application/pdf",
          size: 1024,
          uploadedAt: new Date(),
        },
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const res = await request(app)
      .get(`/api/uploads/signed-get?caseId=${caseDoc._id}&key=${encodeURIComponent(key)}`)
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://signed-url.test/object");
  });

  test("Requested pre-engagement paralegal cannot access another known Matter key", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone-pre-isolation@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng-pre-isolation@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseId = new mongoose.Types.ObjectId();
    const confidentialityKey = `cases/${caseId}/pre-engagement/confidentiality-agreement.pdf`;
    const unrelatedKey = `cases/${caseId}/documents/attorney-private-draft.pdf`;
    const caseDoc = await Case.create({
      _id: caseId,
      title: "Pre-engagement document isolation",
      details: "Only the requested confidentiality document is visible before hire.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 50000,
      currency: "usd",
      preEngagement: {
        status: "requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: true,
        confidentialityDocument: {
          key: confidentialityKey,
          name: "confidentiality-agreement.pdf",
          mimeType: "application/pdf",
          size: 1024,
          uploadedAt: new Date(),
        },
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const res = await request(app)
      .get(`/api/uploads/signed-get?caseId=${caseDoc._id}&key=${encodeURIComponent(unrelatedKey)}`)
      .set("Cookie", authCookieFor(paralegal));

    expect(res.status).toBe(403);
    expect(res.body.msg).toBe("Forbidden");
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("Requested paralegal can upload a signed confidentiality agreement with pre-engagement response", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone-pre2@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng-pre2@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Signed confidentiality upload",
      details: "Requested signed agreement upload before hire.",
      status: "open",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 50000,
      currency: "usd",
      tasks: [{ title: "Prepare first draft", completed: false }],
      applicants: [
        {
          paralegalId: paralegal._id,
          status: "pending",
          appliedAt: new Date(),
          note: "Application submitted.",
        },
      ],
      preEngagement: {
        status: "requested",
        requestedParalegalId: paralegal._id,
        confidentialityAgreementRequired: true,
        conflictsCheckRequired: false,
        confidentialityDocument: {
          key: `cases/${new mongoose.Types.ObjectId()}/pre-engagement/original-confidentiality.pdf`,
          name: "original-confidentiality.pdf",
          mimeType: "application/pdf",
          size: 1024,
          uploadedAt: new Date(),
        },
        requestedAt: new Date(),
        requestedBy: attorney._id,
      },
    });

    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
      .set("Cookie", authCookieFor(paralegal))
      .field("confidentialityAcknowledged", "true")
      .field("conflictsResponseType", "")
      .field("conflictsDisclosureText", "")
      .attach("paralegalConfidentialityFile", Buffer.from("%PDF-1.4\nsigned agreement"), "signed-confidentiality.pdf");

    expect(res.status).toBe(200);
    expect(res.body.preEngagement?.status).toBe("submitted");
    expect(res.body.preEngagement?.paralegalConfidentialityDocument).toBeTruthy();
    expect(res.body.preEngagement?.paralegalConfidentialityDocument?.name).toBe("signed-confidentiality.pdf");

    const updated = await Case.findById(caseDoc._id).lean();
    expect(updated?.preEngagement?.paralegalConfidentialityDocument).toBeTruthy();
    expect(updated?.preEngagement?.paralegalConfidentialityDocument?.name).toBe("signed-confidentiality.pdf");
  });

  test("Case file upload notification is suppressed while the recipient is active in case detail", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone-upload@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng-upload@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Workspace document upload",
      details: "Recipient is already in the workspace.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_567",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const presenceRes = await request(app)
      .post("/api/notifications/workspace-presence")
      .set("Cookie", authCookieFor(paralegal))
      .send({ caseId: String(caseDoc._id) });

    expect(presenceRes.status).toBe(200);

    const caseEvents = [];
    const recipientEvents = [];
    const unsubscribeCase = addCaseSubscriber(caseDoc._id, { write: (value) => caseEvents.push(String(value)) });
    const unsubscribeRecipient = addNotificationSubscriber(paralegal._id, { write: (value) => recipientEvents.push(String(value)) });

    const res = await request(app)
      .post(`/api/uploads/case/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .attach("file", Buffer.from("%PDF-1.4\ndraft content"), "draft.pdf");
    unsubscribeCase();
    unsubscribeRecipient();

    expect(res.status).toBe(201);

    const notif = await require("../models/Notification")
      .findOne({ userId: paralegal._id, type: "case_file_uploaded" })
      .lean();
    expect(notif).toBeFalsy();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(caseEvents.join("\n")).toContain("event: documents");
    expect(recipientEvents.join("\n")).toContain("case_file_uploaded_refresh");
  });

  test("Being on Matter overview does not suppress a new-file alert, while the Files surface does", async () => {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Surface",
      email: "alex.surface-upload@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Surface",
      email: "priya.surface-upload@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Surface-aware file alerts",
      details: "Only an open Files surface suppresses its stored alert.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_surface_file_alerts",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const overviewPresence = await request(app)
      .post("/api/notifications/workspace-presence")
      .set("Cookie", authCookieFor(paralegal))
      .send({ caseId: String(caseDoc._id), surface: "overview" });
    expect(overviewPresence.status).toBe(200);

    const firstUpload = await request(app)
      .post(`/api/uploads/case/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .attach("file", Buffer.from("%PDF-1.4\nfirst"), "first.pdf");
    expect(firstUpload.status).toBe(201);
    expect(
      await require("../models/Notification").countDocuments({
        userId: paralegal._id,
        type: "case_file_uploaded",
      })
    ).toBe(1);

    const filesPresence = await request(app)
      .post("/api/notifications/workspace-presence")
      .set("Cookie", authCookieFor(paralegal))
      .send({ caseId: String(caseDoc._id), surface: "files" });
    expect(filesPresence.status).toBe(200);

    const secondUpload = await request(app)
      .post(`/api/uploads/case/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .attach("file", Buffer.from("%PDF-1.4\nsecond"), "second.pdf");
    expect({ status: secondUpload.status, body: secondUpload.body }).toMatchObject({ status: 201 });
    expect(
      await require("../models/Notification").countDocuments({
        userId: paralegal._id,
        type: "case_file_uploaded",
      })
    ).toBe(1);
  });

  test("Direct Matter upload retries are idempotent for the same client request", async () => {
    const attorney = await User.create({
      firstName: "Upload",
      lastName: "Idempotency",
      email: "upload.idempotency.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Upload",
      lastName: "Recipient",
      email: "upload.idempotency.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Idempotent upload",
      details: "A retried browser request must not duplicate the Matter file.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_upload_idempotency",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });
    const clientUploadId = "upload-request-1234567890";
    const send = () => request(app)
      .post(`/api/uploads/case/${caseDoc._id}?presentation=matter`)
      .set("Cookie", authCookieFor(attorney))
      .field("clientUploadId", clientUploadId)
      .attach("file", Buffer.from("%PDF-1.4\nidempotent content"), "idempotent.pdf");

    const first = await send();
    const retry = await send();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ idempotent: true });
    expect(retry.body.file.id).toBe(first.body.file.id);
    expect(await CaseFile.countDocuments({ caseId: caseDoc._id })).toBe(1);
    const storedObjectWrites = mockSend.mock.calls
      .map(([command]) => command?.input || {})
      .filter((input) => input.Body && input.Key?.includes("/documents/"));
    expect(storedObjectWrites).toHaveLength(1);
  });

  test("Direct Matter upload retains attempt evidence without deleting a possibly committed object after metadata failure", async () => {
    const attorney = await User.create({
      firstName: "Upload",
      lastName: "Recovery",
      email: "upload.recovery.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Upload",
      lastName: "Participant",
      email: "upload.recovery.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Upload recovery",
      details: "A failed acknowledgement cannot prove it is safe to delete an uploaded object.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_upload_recovery",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });
    const createSpy = jest.spyOn(CaseFile, "create").mockRejectedValueOnce(new Error("metadata unavailable"));

    const response = await request(app)
      .post(`/api/uploads/case/${caseDoc._id}`)
      .set("Cookie", authCookieFor(attorney))
      .attach("file", Buffer.from("%PDF-1.4\ndraft content"), "draft.pdf");
    createSpy.mockRestore();

    expect(response.status).toBe(503);
    const storageCalls = mockSend.mock.calls.map(([command]) => command?.input || {});
    const uploaded = storageCalls.find((input) => input.Body && input.Key?.includes(`/documents/`));
    const deleted = storageCalls.find((input) => !input.Body && input.Key === uploaded?.Key);
    expect(uploaded).toBeTruthy();
    expect(deleted).toBeUndefined();
    expect(await CaseFile.countDocuments({ caseId: caseDoc._id })).toBe(0);
    const operation = await require("../models/MatterFileUpload").collection.findOne({ caseId: caseDoc._id });
    expect(operation.status).toBe("unconfirmed"); expect(operation.attempts).toHaveLength(1);
    expect(uploaded.Key).toContain(`${operation.fileId}-${operation.attempts[0].token}`);
  });

  test("Unauthorized user cannot presign uploads", async () => {
    // Description: Non-participant attempts to presign a case upload.
    // Input values: other paralegal.
    // Expected result: 404 (case not found/hidden).

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone4@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng4@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const outsider = await User.create({
      firstName: "Casey",
      lastName: "Doe",
      email: "casey.doe@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Contract review",
      details: "Upload test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_456",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const res = await request(app)
      .post("/api/uploads/presign")
      .set("Cookie", authCookieFor(outsider))
      .send({
        caseId: caseDoc._id,
        contentType: "application/pdf",
        ext: "pdf",
        size: 1024,
      });
    expect([403, 404]).toContain(res.status);
  });

  test("A valid File id cannot be replayed against a different Matter", async () => {
    const attorney = await User.create({
      firstName: "Cross",
      lastName: "Matter",
      email: "cross-matter-file-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Assigned",
      lastName: "Paralegal",
      email: "cross-matter-file-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const common = {
      details: "Cross-Matter object binding regression fixture.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    };
    const firstMatter = await Case.create({ ...common, title: "First Matter", escrowIntentId: "pi_first_file" });
    const secondMatter = await Case.create({ ...common, title: "Second Matter", escrowIntentId: "pi_second_file" });
    const file = await CaseFile.create({
      caseId: secondMatter._id,
      userId: paralegal._id,
      originalName: "second-matter-only.pdf",
      storageKey: `cases/${secondMatter._id}/documents/second-matter-only.pdf`,
      mimeType: "application/pdf",
      size: 512,
      uploadedByRole: "paralegal",
      status: "pending_review",
    });

    const response = await request(app)
      .get(`/api/uploads/case/${firstMatter._id}/${file._id}/download`)
      .set("Cookie", authCookieFor(attorney));

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("second-matter-only.pdf");
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("Authorized preview uses inline disposition only for an allowlisted file type", async () => {
    const previewBody = Buffer.from("%PDF-1.4\nauthorized preview");
    const attorney = await User.create({
      firstName: "Preview",
      lastName: "Attorney",
      email: "preview.attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Preview",
      lastName: "Paralegal",
      email: "preview.paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const matter = await Case.create({
      title: "Preview Matter",
      details: "Authorized file preview contract.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_preview_file",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });
    const file = await CaseFile.create({
      caseId: matter._id,
      userId: attorney._id,
      originalName: "authorized-preview.pdf",
      storageKey: `cases/${matter._id}/documents/authorized-preview.pdf`,
      mimeType: "application/pdf",
      size: previewBody.length,
      securityStatus: "not_required",
      uploadedByRole: "attorney",
    });
    mockSend.mockImplementation((command) => {
      if (command?.constructor?.name !== "GetObjectCommand") return {};
      const body = new PassThrough();
      body.end(previewBody);
      return { Body: body };
    });

    const response = await request(app)
      .get(`/api/uploads/case/${matter._id}/${file._id}/download?preview=true`)
      .set("Cookie", authCookieFor(paralegal));

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(response.headers["content-disposition"]).toMatch(/^inline;/);
  });

  test("A replacement paralegal cannot list, preview, sign, or download a prior assignment's files", async () => {
    const attorney = await User.create({
      firstName: "File",
      lastName: "Attorney",
      email: "reassignment-file-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const priorParalegal = await User.create({
      firstName: "Prior",
      lastName: "Fileworker",
      email: "reassignment-file-prior@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const replacement = await User.create({
      firstName: "Replacement",
      lastName: "Fileworker",
      email: "reassignment-file-current@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Reassigned file Matter",
      details: "Assignment-scoped file fixture.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: replacement._id,
      paralegalId: replacement._id,
      withdrawnParalegalId: priorParalegal._id,
      hiredAt: new Date("2026-09-02T12:00:00.000Z"),
      escrowIntentId: "pi_reassignment_files",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });
    const oldKey = `cases/${caseDoc._id}/documents/prior-assignment.pdf`;
    const currentKey = `cases/${caseDoc._id}/documents/current-assignment.pdf`;
    const oldFile = await CaseFile.create({
      caseId: caseDoc._id,
      userId: priorParalegal._id,
      originalName: "prior-assignment.pdf",
      storageKey: oldKey,
      mimeType: "application/pdf",
      size: 256,
      uploadedByRole: "paralegal",
      securityStatus: "not_required",
      securityScanResult: "NOT_REQUIRED",
      createdAt: new Date("2026-09-01T12:00:00.000Z"),
    });
    const currentFile = await CaseFile.create({
      caseId: caseDoc._id,
      userId: attorney._id,
      originalName: "current-assignment.pdf",
      storageKey: currentKey,
      mimeType: "application/pdf",
      size: 256,
      uploadedByRole: "attorney",
      securityStatus: "not_required",
      securityScanResult: "NOT_REQUIRED",
      createdAt: new Date("2026-09-03T12:00:00.000Z"),
    });

    const list = await request(app)
      .get(`/api/uploads/case/${caseDoc._id}?presentation=matter`)
      .set("Cookie", authCookieFor(replacement));
    expect(list.status).toBe(200);
    expect(list.body.files.map((file) => file.id)).toEqual([String(currentFile._id)]);

    const oldStatus = await request(app)
      .get(`/api/uploads/case/${caseDoc._id}/${oldFile._id}/security-status`)
      .set("Cookie", authCookieFor(replacement));
    expect(oldStatus.status).toBe(404);

    const oldDownload = await request(app)
      .get(`/api/uploads/case/${caseDoc._id}/${oldFile._id}/download`)
      .set("Cookie", authCookieFor(replacement));
    expect(oldDownload.status).toBe(404);

    const oldSignedUploadRoute = await request(app)
      .get(`/api/uploads/signed-get?caseId=${caseDoc._id}&key=${encodeURIComponent(oldKey)}`)
      .set("Cookie", authCookieFor(replacement));
    expect(oldSignedUploadRoute.status).toBe(403);

    const oldSignedCaseRoute = await request(app)
      .get(`/api/cases/${caseDoc._id}/files/signed-get?key=${encodeURIComponent(oldKey)}`)
      .set("Cookie", authCookieFor(replacement));
    expect(oldSignedCaseRoute.status).toBe(404);

    const attorneyList = await request(app)
      .get(`/api/uploads/case/${caseDoc._id}?presentation=matter`)
      .set("Cookie", authCookieFor(attorney));
    expect(attorneyList.status).toBe(200);
    expect(attorneyList.body.files.map((file) => file.id)).toEqual([
      String(currentFile._id),
      String(oldFile._id),
    ]);
  });

  test("Assigned paralegal can attach case file metadata", async () => {
    // Description: Paralegal attaches file metadata to case.
    // Input values: key="cases/<id>/documents/sample.pdf".
    // Expected result: 201 and CaseFile record created.

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone5@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });
    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng5@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });
    const caseDoc = await Case.create({
      title: "Immigration support",
      details: "Upload test case details.",
      status: "in progress",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      escrowIntentId: "pi_567",
      escrowStatus: "funded",
      totalAmount: 100000,
      currency: "usd",
    });

    const key = `cases/${caseDoc._id}/documents/sample.pdf`;
    mockSend.mockImplementation((cmd) => {
      if (cmd?.constructor?.name === "HeadObjectCommand") {
        return { ContentLength: 1234, ContentType: "application/pdf" };
      }
      if (cmd?.constructor?.name === "GetObjectCommand") {
        return { Body: { transformToByteArray: async () => Buffer.from("%PDF-1.4\nsample") } };
      }
      return {};
    });
    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ key, original: "sample.pdf", mime: "application/pdf", size: 1234 });
    expect(res.status).toBe(201);

    const record = await CaseFile.findOne(buildCaseFileKeyQuery({ caseId: caseDoc._id, storageKey: key })).lean();
    expect(record).toBeTruthy();
  });
});
