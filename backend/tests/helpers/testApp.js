const express = require("express");
const authRouter = require("../../routes/auth");

function buildTestApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/auth", authRouter);
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return app;
}

module.exports = {
  buildTestApp,
};
