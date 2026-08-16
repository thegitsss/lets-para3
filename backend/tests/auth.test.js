const request = require("supertest");
const User = require("../models/User");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { buildTestApp } = require("./helpers/testApp");
const sendEmail = require("../utils/email");
const AuthSession = require("../models/AuthSession");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("../utils/legalDocuments");
const { csrfCookieName } = require("../utils/csrf");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));

const app = buildTestApp();

const validAttorneyPayload = {
  firstName: "Alex",
  lastName: "Johnson",
  email: "alex.johnson@example.com",
  password: "A unique test passphrase",
  role: "attorney",
  barNumber: "CA-12345",
  barState: "CA",
  lawFirm: "Johnson Law",
  attorneyPricingAccepted: true,
  termsAccepted: true,
  privacyAcknowledged: true,
  state: "CA",
  timezone: "America/Los_Angeles",
};

function extractTokenFromEmailCall(call = []) {
  const [, , body = "", opts = {}] = call;
  const haystack = [body, opts?.text || ""].filter(Boolean).join("\n");
  const match = haystack.match(/token=([^&\s"'<>]+)/i);
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
    expect(user.termsVersion).toBe(CURRENT_TERMS_VERSION);
    expect(user.privacyVersion).toBe(CURRENT_PRIVACY_VERSION);
    expect(user.termsAcceptedAt).toBeInstanceOf(Date);
    expect(user.privacyAcknowledgedAt).toBeInstanceOf(Date);
    expect(user.legalAcceptanceSource).toBe("signup");
  });

  test("Sign up requires a separate privacy acknowledgement", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validAttorneyPayload, privacyAcknowledged: false });

    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/acknowledge the Privacy Policy/i);
    expect(await User.countDocuments()).toBe(0);
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
      emailVerified: true,
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
    expect(res.body.msg).toMatch(/invalid email or password/i);
  });

  test("Production auth failures do not disclose raw exception details", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const rawError = "database host and credential detail must stay private";
    const findSpy = jest.spyOn(User, "findOne").mockImplementationOnce(() => {
      throw new Error(rawError);
    });
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.NODE_ENV = "production";

    try {
      const csrfRes = await request(app).get("/api/csrf");
      const csrfToken = csrfRes.body.csrfToken;
      const cookiePrefix = `${csrfCookieName()}=`;
      const csrfCookie = (csrfRes.headers["set-cookie"] || []).find((cookie) =>
        cookie.startsWith(cookiePrefix)
      );
      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", csrfCookie)
        .set("x-csrf-token", csrfToken)
        .send({
          email: "safe-error@example.com",
          password: "Password123!",
        });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ msg: "Server error" });
      expect(JSON.stringify(res.body)).not.toContain(rawError);
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(rawError);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      findSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  test("Google authorization uses the configured callback with signed state and nonce", async () => {
    const previous = {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    };
    process.env.GOOGLE_CLIENT_ID = "test-google-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
    process.env.GOOGLE_REDIRECT_URI =
      "https://www.lets-paraconnect.com/api/auth/google/callback";

    try {
      const res = await request(app).get("/api/auth/google?intent=signup&role=paralegal");
      expect(res.status).toBe(302);
      const authorizationUrl = new URL(res.headers.location);
      expect(authorizationUrl.origin).toBe("https://accounts.google.com");
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "https://www.lets-paraconnect.com/api/auth/google/callback"
      );
      expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
      expect(authorizationUrl.searchParams.get("nonce")).toBeTruthy();
      expect(res.headers["set-cookie"]?.join(";")).toMatch(/lpc_google_oauth=/);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("Google callback rejects invalid state without accepting a provider code", async () => {
    const previous = {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    };
    process.env.GOOGLE_CLIENT_ID = "test-google-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
    process.env.GOOGLE_REDIRECT_URI =
      "https://www.lets-paraconnect.com/api/auth/google/callback";

    try {
      const res = await request(app).get(
        "/api/auth/google/callback?state=untrusted&code=untrusted"
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login.html?google_error=invalid_state");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("Login does not disclose whether an account exists", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "missing.user@example.com",
      password: "Password123!",
    });

    expect(res.status).toBe(401);
    expect(res.body.msg).toMatch(/invalid email or password/i);
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

  test("Approved user with an unverified email remains blocked until verification", async () => {
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

    expect(res.status).toBe(403);
    expect(res.body.msg).toMatch(/verify your email/i);

    const updated = await User.findById(user._id);
    expect(updated.emailVerified).toBe(false);
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
    expect(pendingLogin.status).toBe(401);

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

  test("Password reset token changes the password used for login", async () => {
    await User.create({
      firstName: "Morgan",
      lastName: "Lane",
      email: "morgan.lane@example.com",
      password: "OldPassword123!",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "CA",
    });

    const requestReset = await request(app).post("/api/auth/request-password-reset").send({
      email: "morgan.lane@example.com",
    });
    expect(requestReset.status).toBe(200);
    expect(requestReset.body.ok).toBe(true);

    const token = extractTokenFromEmailCall(sendEmail.mock.calls[0]);
    expect(token).toBeTruthy();

    const reset = await request(app).post("/api/auth/reset-password").send({
      token,
      newPassword: "NewPassword123!",
    });
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    const oldLogin = await request(app).post("/api/auth/login").send({
      email: "morgan.lane@example.com",
      password: "OldPassword123!",
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post("/api/auth/login").send({
      email: "morgan.lane@example.com",
      password: "NewPassword123!",
    });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.success).toBe(true);
  });

  test("Password reset tokens are single-use", async () => {
    await User.create({
      firstName: "Single",
      lastName: "Use",
      email: "single.use@example.com",
      password: "Original passphrase value",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "CA",
    });

    await request(app).post("/api/auth/request-password-reset").send({
      email: "single.use@example.com",
    });
    const token = extractTokenFromEmailCall(sendEmail.mock.calls[0]);

    const first = await request(app).post("/api/auth/reset-password").send({
      token,
      newPassword: "Replacement passphrase value",
    });
    expect(first.status).toBe(200);

    const reuse = await request(app).post("/api/auth/reset-password").send({
      token,
      newPassword: "Another replacement passphrase",
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.msg).toMatch(/invalid or expired/i);
  });

  test("a newer password reset request invalidates the older link", async () => {
    await User.create({
      firstName: "Newest",
      lastName: "Link",
      email: "newest.link@example.com",
      password: "Original passphrase value",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "CA",
    });

    await request(app).post("/api/auth/request-password-reset").send({ email: "newest.link@example.com" });
    const oldToken = extractTokenFromEmailCall(sendEmail.mock.calls[0]);
    await request(app).post("/api/auth/request-password-reset").send({ email: "newest.link@example.com" });
    const newToken = extractTokenFromEmailCall(sendEmail.mock.calls[1]);

    const oldReset = await request(app).post("/api/auth/reset-password").send({
      token: oldToken,
      newPassword: "Replacement passphrase value",
    });
    expect(oldReset.status).toBe(400);

    const newReset = await request(app).post("/api/auth/reset-password").send({
      token: newToken,
      newPassword: "Replacement passphrase value",
    });
    expect(newReset.status).toBe(200);
  });

  test("logout revokes the server-side session", async () => {
    await User.create({
      firstName: "Server",
      lastName: "Session",
      email: "server.session@example.com",
      password: "A unique login passphrase",
      role: "attorney",
      status: "approved",
      emailVerified: true,
      state: "CA",
    });
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({
      email: "server.session@example.com",
      password: "A unique login passphrase",
    });
    expect(login.status).toBe(200);
    expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(1);

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(200);
    expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(0);
  });
});
