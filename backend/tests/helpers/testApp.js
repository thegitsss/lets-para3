const express = require("express");
const cookieParser = require("cookie-parser");
const authRouter = require("../../routes/auth");

function buildTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/csrf", require("csurf")({cookie:{httpOnly:true,sameSite:"strict",secure:false}}),(req,res)=>res.json({csrfToken:req.csrfToken()}));
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
