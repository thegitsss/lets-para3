const {
  DEVELOPMENT_COOKIE_NAME,
  PRODUCTION_COOKIE_NAME,
  constantTimeEqual,
  csrfCookieName,
  csrfCookieOptions,
  csrfSecrets,
  csrfTokenMiddleware,
  generateCsrfToken,
  isCsrfError,
  isTokenValidForRequest,
  parseToken,
  respondToCsrfError,
} = require("../utils/csrf");
const cookieParser = require("cookie-parser");
const express = require("express");
const request = require("supertest");

function responseHarness() {
  return {
    status: jest.fn(function status() { return this; }),
    json: jest.fn(function json() { return this; }),
  };
}

describe("CSRF error responses", () => {
  test("recognizes only CSRF token failures", () => {
    expect(isCsrfError({ code: "EBADCSRFTOKEN" })).toBe(true);
    expect(isCsrfError({ code: "FORBIDDEN" })).toBe(false);
    expect(isCsrfError(null)).toBe(false);
  });

  test("returns a stable machine-readable 403 response", () => {
    const res = responseHarness();

    expect(respondToCsrfError({ code: "EBADCSRFTOKEN" }, res)).toBe(true);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Invalid CSRF token",
      code: "CSRF_INVALID",
    });
  });

  test("supports routers whose established message field is msg", () => {
    const res = responseHarness();

    expect(respondToCsrfError({ code: "EBADCSRFTOKEN" }, res, { field: "msg" })).toBe(true);
    expect(res.json).toHaveBeenCalledWith({
      msg: "Invalid CSRF token",
      code: "CSRF_INVALID",
    });
  });

  test("does not consume unrelated authorization failures", () => {
    const res = responseHarness();

    expect(respondToCsrfError({ code: "FORBIDDEN" }, res)).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("signed session-bound CSRF tokens", () => {
  const enabledEnv = {
    NODE_ENV: "test",
    ENABLE_CSRF: "true",
    JWT_SECRET: "csrf-test-jwt-secret-at-least-32-bytes-long",
  };

  function responseCookieHarness() {
    return { cookie: jest.fn() };
  }

  test("uses a host-only secure production cookie and a local development cookie", () => {
    expect(csrfCookieName({ NODE_ENV: "production" })).toBe(PRODUCTION_COOKIE_NAME);
    expect(csrfCookieOptions({ NODE_ENV: "production" })).toEqual({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
    });
    expect(csrfCookieName({ NODE_ENV: "test" })).toBe(DEVELOPMENT_COOKIE_NAME);
    expect(csrfCookieOptions({ NODE_ENV: "test" })).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    });
  });

  test("fails closed without server secret material when protection is enabled", () => {
    expect(() => csrfSecrets({ NODE_ENV: "production" })).toThrow(/secret material is required/i);
    expect(() => csrfSecrets({ NODE_ENV: "test", ENABLE_CSRF: "true" })).toThrow(
      /secret material is required/i
    );
  });

  test("generates, validates, reuses, and rotates signed tokens by session identity", () => {
    const req = { cookies: { token: "session-a" }, headers: {} };
    const res = responseCookieHarness();
    const token = generateCsrfToken(req, res, { env: enabledEnv });

    expect(parseToken(token)).toEqual({
      hmac: expect.stringMatching(/^[a-f0-9]{64}$/),
      randomValue: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(res.cookie).toHaveBeenCalledWith(
      DEVELOPMENT_COOKIE_NAME,
      token,
      csrfCookieOptions(enabledEnv)
    );
    expect(isTokenValidForRequest(token, req, enabledEnv)).toBe(true);
    expect(generateCsrfToken(req, res, { env: enabledEnv })).toBe(token);

    expect(isTokenValidForRequest(token, {
      cookies: { [DEVELOPMENT_COOKIE_NAME]: token, token: "session-b" },
      headers: {},
    }, enabledEnv)).toBe(false);
  });

  test("accepts a previous signing key during deliberate key rotation", () => {
    const oldEnv = { ...enabledEnv, JWT_SECRET: "old-csrf-jwt-secret-at-least-32-bytes-long" };
    const req = { cookies: { token: "session-a" }, headers: {} };
    const token = generateCsrfToken(req, responseCookieHarness(), { env: oldEnv });
    const rotationEnv = {
      ...enabledEnv,
      JWT_SECRET: "new-csrf-jwt-secret-at-least-32-bytes-long",
      JWT_SECRETS: oldEnv.JWT_SECRET,
    };

    expect(isTokenValidForRequest(token, req, rotationEnv)).toBe(true);
  });

  test("rejects malformed values and compares equal-length values in constant time", () => {
    expect(parseToken("not-a-token")).toBeNull();
    expect(parseToken(`${"a".repeat(64)}.${"b".repeat(63)}`)).toBeNull();
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "diff")).toBe(false);
    expect(constantTimeEqual("short", "longer")).toBe(false);
  });

  test("requires the matching cookie, header, signature, and session on mutations", async () => {
    const previousSetting = process.env.ENABLE_CSRF;
    process.env.ENABLE_CSRF = "true";
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.get("/csrf", csrfTokenMiddleware, (req, res) => {
      res.json({ csrfToken: req.csrfToken() });
    });
    app.post("/mutate", require("../utils/csrf").csrfProtection, (_req, res) => {
      res.json({ ok: true });
    });
    app.use((error, _req, res, _next) => {
      if (respondToCsrfError(error, res)) return;
      res.status(500).json({ error: "Unexpected error" });
    });

    try {
      const authCookie = "token=session-a";
      const tokenResponse = await request(app).get("/csrf").set("Cookie", authCookie);
      const token = tokenResponse.body.csrfToken;
      const csrfCookie = (tokenResponse.headers["set-cookie"] || []).find((entry) =>
        entry.startsWith(`${DEVELOPMENT_COOKIE_NAME}=`)
      );
      expect(tokenResponse.status).toBe(200);
      expect(csrfCookie).toBeTruthy();

      const accepted = await request(app)
        .post("/mutate")
        .set("Cookie", [authCookie, csrfCookie])
        .set("x-csrf-token", token)
        .send({ value: true });
      expect(accepted.status).toBe(200);

      const missingHeader = await request(app)
        .post("/mutate")
        .set("Cookie", [authCookie, csrfCookie])
        .send({ value: true, _csrf: token });
      expect(missingHeader.status).toBe(403);
      expect(missingHeader.body.code).toBe("CSRF_INVALID");

      const wrongSession = await request(app)
        .post("/mutate")
        .set("Cookie", ["token=session-b", csrfCookie])
        .set("x-csrf-token", token)
        .send({ value: true });
      expect(wrongSession.status).toBe(403);

      const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
      const tamperedHeader = await request(app)
        .post("/mutate")
        .set("Cookie", [authCookie, csrfCookie])
        .set("x-csrf-token", tampered)
        .send({ value: true });
      expect(tamperedHeader.status).toBe(403);
    } finally {
      process.env.ENABLE_CSRF = previousSetting;
    }
  });
});
