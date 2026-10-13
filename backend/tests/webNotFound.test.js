const path = require("path");
const express = require("express");
const request = require("supertest");
const { createWebNotFoundHandler } = require("../utils/webNotFound");

const frontendDirectory = path.resolve(__dirname, "../../frontend");

describe("public not-found behavior", () => {
  const app = express();
  app.use(createWebNotFoundHandler(frontendDirectory));

  test("returns a useful no-store HTML page with a real 404 status", async () => {
    const response = await request(app).get("/definitely-not-a-real-page");
    expect(response.status).toBe(404);
    expect(response.type).toBe("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.text).toMatch(/We couldn’t find that page/);
    expect(response.text).toMatch(/noindex, nofollow/);
  });

  test("does not return an HTML document for an unknown mutation", async () => {
    const response = await request(app).post("/definitely-not-a-real-page");
    expect(response.status).toBe(404);
    expect(response.type).toBe("text/plain");
    expect(response.text).toBe("Not found");
  });
});
