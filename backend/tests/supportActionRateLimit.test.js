const express = require("express");
const request = require("supertest");

const {
  SUPPORT_ACTION_RATE_LIMIT,
  createSupportActionRateLimiter,
} = require("../services/support/supportActionRateLimit");

describe("support action rate limiting", () => {
  test("counts one user-submitted request once regardless of internal work", async () => {
    const app = express();
    let internalOperations = 0;
    app.use((req, _res, next) => {
      req.user = { _id: req.get("x-test-user") || "user-1" };
      next();
    });
    app.post(
      "/assistant-action",
      createSupportActionRateLimiter({ skip: () => false }),
      (_req, res) => {
        for (let index = 0; index < 8; index += 1) internalOperations += 1;
        res.json({ ok: true });
      }
    );

    for (let index = 0; index < SUPPORT_ACTION_RATE_LIMIT.limit; index += 1) {
      const response = await request(app)
        .post("/assistant-action")
        .set("x-test-user", "user-1");
      expect(response.status).toBe(200);
    }
    expect(internalOperations).toBe(SUPPORT_ACTION_RATE_LIMIT.limit * 8);

    const blocked = await request(app)
      .post("/assistant-action")
      .set("x-test-user", "user-1");
    expect(blocked.status).toBe(429);

    const otherUser = await request(app)
      .post("/assistant-action")
      .set("x-test-user", "user-2");
    expect(otherUser.status).toBe(200);
  });
});
