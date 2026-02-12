const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const adminRouter = require("../routes/admin");
const authRouter = require("../routes/auth");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const sendEmail = require("../utils/email");

jest.mock("../utils/email", () => {
  const fn = jest.fn();
  fn.sendWelcomePacket = jest.fn();
  fn.sendProfilePhotoRejectedEmail = jest.fn();
  return fn;
});

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/auth", authRouter);
  instance.use("/api/admin", adminRouter);
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
  sendEmail.mockClear();
  if (sendEmail.sendWelcomePacket?.mockClear) sendEmail.sendWelcomePacket.mockClear();
  if (sendEmail.sendProfilePhotoRejectedEmail?.mockClear) sendEmail.sendProfilePhotoRejectedEmail.mockClear();
});

describe("Admin workflows", () => {
  test("Admin approves attorney registration and login succeeds", async () => {
    // Description: Admin approves a pending attorney and the attorney can log in.
    // Input values: admin role=admin; attorney status=pending; approval note="Looks good".
    // Expected result: status=approved, approvedAt set, login returns success=true.

    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });

    const pendingLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(pendingLogin.status).toBe(403);
    expect(pendingLogin.body.msg).toMatch(/pending admin approval/i);

    const approveRes = await request(app)
      .post(`/api/admin/users/${attorney._id}/approve`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Looks good" });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.ok).toBe(true);
    expect(approveRes.body.user.status).toBe("approved");

    const updated = await User.findById(attorney._id);
    expect(updated.status).toBe("approved");
    expect(updated.approvedAt).toBeTruthy();

    const approvedLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(approvedLogin.status).toBe(200);
    expect(approvedLogin.body.success).toBe(true);
  });

  test("Admin denies attorney registration and denial email is sent", async () => {
    // Description: Admin denies a pending attorney and a denial email is sent.
    // Input values: admin role=admin; attorney status=pending; denial note="Missing docs".
    // Expected result: status=denied, sendEmail called with denial subject, login blocked.

    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner2@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const attorney = await User.create({
      firstName: "Morgan",
      lastName: "Lee",
      email: "morgan.lee@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });

    const denyRes = await request(app)
      .post(`/api/admin/users/${attorney._id}/deny`)
      .set("Cookie", authCookieFor(admin))
      .send({ note: "Missing docs" });
    expect(denyRes.status).toBe(200);
    expect(denyRes.body.ok).toBe(true);
    expect(denyRes.body.user.status).toBe("denied");

    const updated = await User.findById(attorney._id);
    expect(updated.status).toBe("denied");

    expect(sendEmail).toHaveBeenCalled();
    const [to, subject] = sendEmail.mock.calls[0];
    expect(to).toBe(attorney.email);
    expect(subject).toMatch(/not approved/i);

    const deniedLogin = await request(app).post("/api/auth/login").send({
      email: attorney.email,
      password: "Password123!",
    });
    expect(deniedLogin.status).toBe(403);
    expect(deniedLogin.body.msg).toMatch(/not approved/i);
  });

  test("Non-admin cannot approve attorney registrations", async () => {
    // Description: A non-admin user attempts to approve an attorney.
    // Input values: actor role=attorney; target status=pending.
    // Expected result: 403 forbidden.

    const actor = await User.create({
      firstName: "Avery",
      lastName: "Cruz",
      email: "avery.cruz@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const target = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });

    const res = await request(app)
      .post(`/api/admin/users/${target._id}/approve`)
      .set("Cookie", authCookieFor(actor))
      .send({ note: "Trying to approve" });
    expect(res.status).toBe(403);
  });
});
