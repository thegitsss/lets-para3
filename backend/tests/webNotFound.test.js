const path = require("path");
const fs = require("fs");
const os = require("os");
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

  test.each(["get", "head"])("serves the approved 404 from a hidden build directory for %s", async method => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-not-found-"));
    try {
      const built = path.join(temporary, ".lpc-build", "frontend");
      fs.mkdirSync(built, { recursive: true });
      const document = fs.readFileSync(path.join(frontendDirectory, "404.html"));
      fs.writeFileSync(path.join(built, "404.html"), document);
      const builtApp = express();
      builtApp.use(createWebNotFoundHandler(built));
      builtApp.use((_error, _req, res, _next) => res.status(500).send("Server error"));
      const response = await request(builtApp)[method]("/missing-page");
      expect(response.status).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
      if (method === "get") expect(response.text).toBe(document.toString("utf8"));
      else expect(Number(response.headers["content-length"])).toBe(document.length);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
