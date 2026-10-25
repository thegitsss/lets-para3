const express = require("express");
const request = require("supertest");
const fs = require("fs");
const path = require("path");
const { mountMobileHomepageImages, MOBILE_MOUNTAIN_PATH } = require("../utils/mobileHomepageImages");
const frontend = path.resolve(__dirname, "../../frontend");
function fixture(root = frontend) {
  const app = express();
  app.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", Pragma: "no-cache", Expires: "0" }); next(); });
  mountMobileHomepageImages(app, root);
  app.use(express.static(root));
  app.get("/api/example", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("mobile homepage image delivery", () => {
  test("phones use the content-versioned smaller mountain", async () => {
    const response = await request(fixture()).get("/hero-mountain-restored.jpg").set("User-Agent", "Mozilla/5.0 (iPhone) Mobile Safari");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(MOBILE_MOUNTAIN_PATH);
    expect(response.headers.vary).toContain("User-Agent");
  });
  test("desktop retains the original image and cache headers", async () => {
    const response = await request(fixture()).head("/hero-mountain-restored.jpg").set("User-Agent", "Mozilla/5.0 (Macintosh) Safari");
    expect(response.status).toBe(200);
    expect(Number(response.headers["content-length"])).toBe(fs.statSync(path.join(frontend, "hero-mountain-restored.jpg")).size);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.expires).toBe("0");
  });
  test("only the versioned mobile artwork is immutable and conditionally reusable", async () => {
    const app = fixture();
    const response = await request(app).get(MOBILE_MOUNTAIN_PATH);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers.pragma).toBeUndefined();
    expect(response.headers.expires).toBeUndefined();
    const again = await request(app).get(MOBILE_MOUNTAIN_PATH).set("If-None-Match", response.headers.etag);
    expect(again.status).toBe(304);
    const api = await request(app).get("/api/example");
    expect(api.headers["cache-control"]).toBe("no-store");
  });
});


test("the production build directory serves the same image without exposing hidden files", async () => {
  const temporary = fs.mkdtempSync(path.join(require("os").tmpdir(), "lpc-mobile-image-"));
  const built = path.join(temporary, ".lpc-build", "frontend");
  const target = path.join(built, MOBILE_MOUNTAIN_PATH.slice(1));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const expected = fs.readFileSync(path.join(frontend, MOBILE_MOUNTAIN_PATH.slice(1)));
    fs.writeFileSync(target, expected); fs.writeFileSync(path.join(built, ".private"), "not public");
    const response = await request(fixture(built)).get(MOBILE_MOUNTAIN_PATH);
    expect(response.status).toBe(200); expect(response.body).toEqual(expected);
    expect((await request(fixture(built)).get("/.private")).status).toBe(404);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
