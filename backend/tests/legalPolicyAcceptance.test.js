const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const LegalDocumentVersion = require("../models/LegalDocumentVersion");
const verifyToken = require("../utils/verifyToken");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { currentPolicyMetadata } = require("../utils/legalDocuments");

const app = express();
app.use(express.json(), cookieParser());
app.use("/api/auth/legal", require("../routes/legalPolicies"));
app.use("/api/auth/legal", (_req, res) => res.sendStatus(404));
app.use("/api", verifyToken, (_req, res) => res.json({ allowed: true }));
const metadata = currentPolicyMetadata();
const cookie = user => `token=${jwt.sign({ id: String(user._id), av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

beforeAll(connect);
beforeEach(clearDatabase);
afterAll(closeDatabase);

test.each(["attorney", "paralegal"])("%s can continue working without an updated-policy review", async role => {
  const user = await User.create({ firstName: "Policy", lastName: "Fixture", email: `${role}@example.test`, password: "Synthetic policy fixture", role, status: "approved" });
  expect((await request(app).post("/api/cases").set("Cookie", cookie(user))).body).toEqual({ allowed: true });
  expect((await request(app).post("/api/cases/123/apply").set("Cookie", cookie(user))).body).toEqual({ allowed: true });
  expect((await request(app).post("/api/cases/123/hire/456").set("Cookie", cookie(user))).body).toEqual({ allowed: true });
  expect((await request(app).get("/api/auth/legal/status").set("Cookie", cookie(user))).status).toBe(404);
  expect((await request(app).post("/api/auth/legal/accept").set("Cookie", cookie(user))).status).toBe(404);
  const saved = await User.findById(user._id).select("+policyAcknowledgements");
  expect(saved.policyAcknowledgements).toHaveLength(0);
});

test("current and historical policy copies remain readable", async () => {
  const response = await request(app).get("/api/auth/legal/current");
  expect(response.status).toBe(200);
  expect(response.body.documents).toEqual(metadata);
  for (const kind of ["terms", "privacy"]) {
    const saved = await LegalDocumentVersion.findOne({ kind, hash: metadata[kind].hash });
    expect(crypto.createHash("sha256").update(saved.html).digest("hex")).toBe(metadata[kind].hash);
    const downloaded = await request(app).get(`${metadata[kind].url}?download=1`);
    expect(downloaded.text).toBe(saved.html);
    expect(downloaded.headers["content-security-policy"]).toContain("default-src 'none'");
  }
  const oldHtml = "<html><head></head><body>Earlier terms</body></html>";
  const hash = crypto.createHash("sha256").update(oldHtml).digest("hex");
  await LegalDocumentVersion.create({ kind: "terms", version: "2026-03-03", hash, html: oldHtml });
  expect((await request(app).get(`/api/auth/legal/documents/terms/${hash}?download=1`)).text).toBe(oldHtml);
});
