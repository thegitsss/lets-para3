const express = require("express");
const cookieParser = require("cookie-parser");
const http = require("http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.ENABLE_CSRF = "false";
process.env.EMAIL_DISABLE = "true";

const User = require("../models/User");
const adminRouter = require("../routes/admin");
const authRouter = require("../routes/auth");

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

async function startServer() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, port };
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "e2e" });

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  try {
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Owner",
      email: "owner@lets-paraconnect.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const pending = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });

    // Login blocked before approval.
    let res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pending.email, password: "Password123!" }),
    });
    if (res.status !== 403) {
      throw new Error(`Expected pending login to be blocked (403), got ${res.status}`);
    }

    // Approve via admin.
    res = await fetch(`${baseUrl}/api/admin/users/${pending._id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookieFor(admin) },
      body: JSON.stringify({ note: "Approved in e2e" }),
    });
    if (res.status !== 200) {
      throw new Error(`Expected admin approval 200, got ${res.status}`);
    }
    const approvedPayload = await res.json().catch(() => ({}));
    if (!approvedPayload?.ok || approvedPayload?.user?.status !== "approved") {
      throw new Error("Approval response missing expected status");
    }

    // Login succeeds after approval.
    res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pending.email, password: "Password123!" }),
    });
    if (res.status !== 200) {
      throw new Error(`Expected approved login to succeed (200), got ${res.status}`);
    }

    const denied = await User.create({
      firstName: "Morgan",
      lastName: "Lee",
      email: "morgan.lee@example.com",
      password: "Password123!",
      role: "attorney",
      status: "pending",
      state: "CA",
    });

    // Deny via admin.
    res = await fetch(`${baseUrl}/api/admin/users/${denied._id}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookieFor(admin) },
      body: JSON.stringify({ note: "Denied in e2e" }),
    });
    if (res.status !== 200) {
      throw new Error(`Expected admin denial 200, got ${res.status}`);
    }
    const deniedFresh = await User.findById(denied._id).lean();
    if (deniedFresh?.status !== "denied") {
      throw new Error("Denied user status not updated");
    }

    // Login blocked after denial.
    res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: denied.email, password: "Password123!" }),
    });
    if (res.status !== 403) {
      throw new Error(`Expected denied login to be blocked (403), got ${res.status}`);
    }

    console.log("E2E admin workflows validation complete.");
  } catch (err) {
    console.error("❌ E2E admin workflows failed:", err?.message || err);
    process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main();
