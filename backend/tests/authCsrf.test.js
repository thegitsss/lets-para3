const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");

const previousCsrfSetting = process.env.ENABLE_CSRF;
process.env.ENABLE_CSRF = "true";
const authRouter = require("../routes/auth");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/auth", authRouter);

afterAll(() => {
  process.env.ENABLE_CSRF = previousCsrfSetting;
});

describe("auth mutation CSRF contract", () => {
  test("logout rejects a request without a CSRF token using the shared error code", async () => {
    const response = await request(app)
      .post("/api/auth/logout")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      msg: "Invalid CSRF token",
      code: "CSRF_INVALID",
    });
  });
});
