const express = require("express");
const request = require("supertest");

// Route imports initialize Stripe; this parser-only test never calls a provider.
process.env.STRIPE_SECRET_KEY = "sk_test_stub";
const mockUploadConfigurations = [];
jest.mock("multer", () => {
  const actual = jest.requireActual("multer");
  const capture = (options) => {
    mockUploadConfigurations.push(options);
    return actual(options);
  };
  return Object.assign(capture, actual);
});
jest.mock("../utils/email", () => jest.fn());

require("../routes/auth");
require("../routes/cases");
require("../routes/uploads");

test("every production multipart parser rejects oversized indexes and still accepts ordinary fields and files", async () => {
  expect(mockUploadConfigurations).toHaveLength(4);
  for (const configuration of mockUploadConfigurations) {
    const app = express();
    const multer = jest.requireActual("multer");
    app.post("/upload", multer(configuration).single("file"), (req, res) => {
      res.json({ name: req.body.name, file: req.file.buffer.toString() });
    });
    app.use((err, _req, res, _next) => res.status(400).json({ code: err.code }));

    // A bounded index makes a missing guard fail without exhausting the runner.
    const rejected = await request(app).post("/upload").field("items[1000]", "x").field("items[key]", "y");
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("LIMIT_FIELD_ARRAY_INDEX");

    const accepted = await request(app).post("/upload").field("name", "Matter document").attach("file", Buffer.from("document"), "document.txt");
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ name: "Matter document", file: "document" });
  }
});
