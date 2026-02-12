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
  termsAccepted: true,
  state: "CA",
  timezone: "America/Los_Angeles",
};

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

    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/Invalid credentials/i);
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
