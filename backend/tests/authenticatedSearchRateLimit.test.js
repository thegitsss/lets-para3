const express = require("express");
const request = require("supertest");

const {
  AUTHENTICATED_SEARCH_RATE_LIMIT,
  authenticatedSearchKey,
  createAuthenticatedSearchRateLimiter,
} = require("../services/authenticatedSearchRateLimit");

describe("authenticated search rate limiting", () => {
  test("uses isolated user keys and subnet-normalized IPv6 fallback keys", () => {
    expect(authenticatedSearchKey({ user: { id: "2001:db8::1" }, ip: "192.0.2.1" })).toBe(
      "user:2001:db8::1"
    );
    expect(authenticatedSearchKey({ ip: "2001:db8:abcd:12::1" })).toBe(
      "ip:2001:db8:abcd::/56"
    );
    expect(authenticatedSearchKey({ ip: "2001:db8:abcd:12::9" })).toBe(
      "ip:2001:db8:abcd::/56"
    );
    expect(authenticatedSearchKey({ ip: "192.0.2.1" })).toBe("ip:192.0.2.1");
    expect(authenticatedSearchKey()).toBe("ip:anonymous");
  });

  test("limits each authenticated user independently", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: req.get("x-test-user") || "search-user-1" };
      next();
    });
    app.get(
      "/search",
      createAuthenticatedSearchRateLimiter({ skip: () => false }),
      (_req, res) => res.json({ ok: true })
    );

    for (let index = 0; index < AUTHENTICATED_SEARCH_RATE_LIMIT.limit; index += 1) {
      const response = await request(app).get("/search").set("x-test-user", "search-user-1");
      expect(response.status).toBe(200);
    }
    const blocked = await request(app).get("/search").set("x-test-user", "search-user-1");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/temporarily busy/i);

    const otherUser = await request(app).get("/search").set("x-test-user", "search-user-2");
    expect(otherUser.status).toBe(200);
  });
});
