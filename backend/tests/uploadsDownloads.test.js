const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub";

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
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand };
});

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args) => mockGetSignedUrl(...args),
}));

const User = require("../models/User");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const uploadsRouter = require("../routes/uploads");
const casesRouter = require("../routes/cases");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/uploads", uploadsRouter);
  instance.use("/api/cases", casesRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
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
  mockSend.mockImplementation((cmd) => {
    const key = cmd?.input?.Key || "";
    if (String(key).includes("missing")) {
      const err = new Error("NotFound");
      err.name = "NotFound";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    return {};
  });
});

describe("File uploads + downloads", () => {
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
    expect(res.body.url).toBe("https://signed-url.test/object");
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
    const res = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ key, original: "sample.pdf", mime: "application/pdf", size: 1234 });
    expect(res.status).toBe(201);

    const record = await CaseFile.findOne({ caseId: caseDoc._id, storageKey: key }).lean();
    expect(record).toBeTruthy();
  });
});
