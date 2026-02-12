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
const uploadsRouter = require("../routes/uploads");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/uploads", uploadsRouter);
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
});

describe("Performance + limits", () => {
  test("Presign rejects files larger than maximum size", async () => {
    // Description: Oversized uploads are blocked before S3 presign.
    // Input values: size=25MB (above 20MB max).
    // Expected result: 400 with size limit message.

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
      details: "Performance limit test case details.",
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
        size: 25 * 1024 * 1024,
      });

    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/maximum allowed size/i);
  });
});
