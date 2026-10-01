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

// Exercise the same public document mounts and fallback order used in index.js.
describe("public document routing", () => {
  const app = express();
  app.use(express.static(path.resolve(__dirname, "../../public")));
  app.use(express.static(frontendDirectory));
  app.use(createWebNotFoundHandler(frontendDirectory));
  test.each([
    ["/verify-email.html", "verificationPanel"],
    ["/account-closure.html", "closure-title"],
    ["/404.html", "We couldn’t find that page"],
  ])("serves the intended document at %s", async (url, marker) => {
    const response = await request(app).get(url);
    expect(response.status).toBe(200);
    expect(response.text).toContain(marker);
    expect(response.text).not.toContain("Your caseload grew.");
  });
  test("serves indexing files with their intended types", async () => {
    const robots = await request(app).get("/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.type).toBe("text/plain");
    expect(robots.text).toContain("User-agent: *");
    const sitemap = await request(app).get("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.type).toMatch(/xml/);
    expect(sitemap.text).toContain("<urlset");
    expect(sitemap.text).not.toMatch(/dashboard|admin|account-closure/);
  });
  test("unknown pages stay 404 after static mounts", async () => {
    const response = await request(app).get("/unknown-public-document");
    expect(response.status).toBe(404);
    expect(response.text).toContain("We couldn’t find that page");
  });
});
