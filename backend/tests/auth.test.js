const request = require("supertest");
const User = require("../models/User");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { buildTestApp } = require("./helpers/testApp");
const sendEmail = require("../utils/email");

jest.mock("../utils/email", () => jest.fn());

const app = buildTestApp();

const validAttorneyPayload = {
  firstName: "Alex",
  lastName: "Johnson",
  email: "alex.johnson@example.com",
  password: "Password123!",
  role: "attorney",
  barNumber: "CA-12345",
  barState: "CA",
  lawFirm: "Johnson Law",
  attorneyPricingAccepted: true,
  termsAccepted: true,
  state: "CA",
  timezone: "America/Los_Angeles",
};

function extractTokenFromEmailCall(call = []) {
  const [, , body = "", opts = {}] = call;
  const haystack = [body, opts?.text || ""].filter(Boolean).join("\n");
  const match = haystack.match(/token=([^&\s]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

afterAll(async () => {
  await closeDatabase();
});

beforeAll(async () => {
  await connect();
});

beforeEach(async () => {
  await clearDatabase();
  sendEmail.mockClear();
});

describe("Auth workflows", () => {
  test("Sign up with valid account", async () => {
    const res = await request(app).post("/api/auth/register").send(validAttorneyPayload);

    expect(res.status).toBe(200);
    expect(res.body.msg).toMatch(/Registered successfully/i);

    const user = await User.findOne({ email: validAttorneyPayload.email });
    expect(user).toBeTruthy();
    expect(user.role).toBe("attorney");
    expect(user.status).toBe("pending");
  });

  test("Sign up with invalid data returns error", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        ...validAttorneyPayload,
        email: "not-an-email",
      });

    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/Invalid email/i);
  });

  test("Login works after logout", async () => {
    await User.create({
      firstName: "Casey",
      lastName: "Lee",
      email: "casey.lee@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const agent = request.agent(app);

    const firstLogin = await agent.post("/api/auth/login").send({
      email: "casey.lee@example.com",
      password: "Password123!",
    });

    expect(firstLogin.status).toBe(200);
    expect(firstLogin.body.success).toBe(true);

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(200);
    expect(logout.body.success).toBe(true);

    const secondLogin = await agent.post("/api/auth/login").send({
      email: "casey.lee@example.com",
      password: "Password123!",
    });

    expect(secondLogin.status).toBe(200);
    expect(secondLogin.body.success).toBe(true);
  });

  test("Login fails with invalid credentials", async () => {
    await User.create({
      firstName: "Jamie",
      lastName: "Smith",
      email: "jamie.smith@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const res = await request(app).post("/api/auth/login").send({
      email: "jamie.smith@example.com",
      password: "WrongPassword",
    });

    expect(res.status).toBe(401);
    expect(res.body.msg).toMatch(/incorrect password/i);
  });

  test("Login returns a truthful error when no account exists", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "missing.user@example.com",
      password: "Password123!",
    });

    expect(res.status).toBe(404);
    expect(res.body.msg).toMatch(/no account found/i);
  });

  test("Existing unverified user does not get a no-user error", async () => {
    await User.create({
      firstName: "Robin",
      lastName: "Cole",
      email: "robin.cole@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      emailVerified: false,
      state: "CA",
    });

    const res = await request(app).post("/api/auth/login").send({
      email: "robin.cole@example.com",
      password: "Password123!",
    });

    expect(res.status).toBe(403);
    expect(res.body.msg).toMatch(/under review/i);
    expect(res.body.msg).not.toMatch(/no account found/i);
  });

  test("Approved user with stale emailVerified flag is repaired on login", async () => {
    const user = await User.create({
      firstName: "Dana",
      lastName: "Price",
      email: "dana.price@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      emailVerified: false,
      state: "CA",
    });

    const res = await request(app).post("/api/auth/login").send({
      email: "dana.price@example.com",
      password: "Password123!",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updated = await User.findById(user._id);
    expect(updated.emailVerified).toBe(true);
    expect(updated.approvedAt).toBeTruthy();
  });

  test("Pending email change does not replace the live login email until verified", async () => {
    const user = await User.create({
      firstName: "Blair",
      lastName: "Hart",
      email: "blair.hart@example.com",
      pendingEmail: "blair.new@example.com",
      pendingEmailRequestedAt: new Date(),
      password: "Password123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "CA",
    });

    const beforeVerify = await request(app).post("/api/auth/login").send({
      email: "blair.hart@example.com",
      password: "Password123!",
    });
    expect(beforeVerify.status).toBe(200);

    const pendingLogin = await request(app).post("/api/auth/login").send({
      email: "blair.new@example.com",
      password: "Password123!",
    });
    expect(pendingLogin.status).toBe(404);

    const resend = await request(app).post("/api/auth/resend-verification").send({
      email: "blair.new@example.com",
    });
    expect(resend.status).toBe(200);
    expect(sendEmail).toHaveBeenCalled();
    expect(sendEmail.mock.calls[0][0]).toBe("blair.new@example.com");

    const token = extractTokenFromEmailCall(sendEmail.mock.calls[0]);
    expect(token).toBeTruthy();

    const verify = await request(app).post("/api/auth/verify-email").send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);

    const updated = await User.findById(user._id);
    expect(updated.email).toBe("blair.new@example.com");
    expect(updated.pendingEmail).toBeNull();
    expect(updated.emailVerified).toBe(true);

    const afterVerify = await request(app).post("/api/auth/login").send({
      email: "blair.new@example.com",
      password: "Password123!",
    });
    expect(afterVerify.status).toBe(200);
  });

  test("Password reset emails are sent", async () => {
    await User.create({
      firstName: "Taylor",
      lastName: "Ray",
      email: "taylor.ray@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const res = await request(app).post("/api/auth/request-password-reset").send({
      email: "taylor.ray@example.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalled();
    const [to, subject] = sendEmail.mock.calls[0];
    expect(to).toBe("taylor.ray@example.com");
    expect(subject).toMatch(/Reset your password/i);
  });
});
