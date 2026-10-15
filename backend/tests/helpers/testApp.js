const express = require("express");
const cookieParser = require("cookie-parser");
const authRouter = require("../../routes/auth");
const { csrfTokenMiddleware, respondToCsrfError } = require("../../utils/csrf");

function buildTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/csrf", csrfTokenMiddleware, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });
  app.use("/api/auth", authRouter);
  app.use((err, _req, res, _next) => {
    if (respondToCsrfError(err, res)) return;
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return app;
}

module.exports = {
  buildTestApp,
};
