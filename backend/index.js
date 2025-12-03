// 0) Env
require("dotenv").config();

// 1) Core + Libs
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const csrf = require("csurf");

// 2) App Init + Config
const app = express();
const PROD = process.env.NODE_ENV === "production";
const PORT = 5050;
const FRONTEND_DIR = path.join(__dirname, "../frontend");

// 3) Global Middleware
app.use((req, res, next) => {
  if (req.hostname === "lets-paraconnect.com") {
    return res.redirect(301, "https://www.lets-paraconnect.com" + req.url);
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  helmet({
    hsts: PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  })
);
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
    },
  })
);

const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    sameSite: PROD ? "strict" : "lax",
    secure: PROD,
  },
});

app.use("/api/auth/login", rateLimit({ windowMs: 60 * 1000, max: 10 }));
app.use("/api/auth/signup", rateLimit({ windowMs: 60 * 1000, max: 10 }));
app.use("/api/messages", rateLimit({ windowMs: 10 * 1000, max: 5 }));
app.use("/api/uploads", rateLimit({ windowMs: 10 * 1000, max: 2 }));
app.use("/api/cases", rateLimit({ windowMs: 60 * 1000, max: 5 }));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, max: 300 }));

// 4) Routers
const waitlistRouter = require("./routes/waitlist");
const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");
const casesRouter = require("./routes/cases");
const messagesRouter = require("./routes/messages");
const uploadsRouter = require("./routes/uploads");
const paymentsRouter = require("./routes/payments");
const paymentsWebhookHandler = require("./routes/paymentsWebhook");
const usersRouter = require("./routes/users");
const disputesRouter = require("./routes/disputes");
const jobsRouter = require("./routes/jobs");
const applicationsRouter = require("./routes/applications");
const attorneyDashboardRouter = require("./routes/attorneyDashboard");
const paralegalDashboardRouter = require("./routes/paralegalDashboard");
const chatRouter = require("./routes/chat");
const checklistRouter = require("./routes/checklist");
const eventsRouter = require("./routes/events");
const verificationRouter = require("./routes/verification");
const { startPurgeWorker } = require("./services/caseLifecycle");

app.use("/api/payments/webhook", express.raw({ type: "application/json" }), paymentsWebhookHandler);
app.use(express.json({ limit: "1mb" }));
app.use("/api/waitlist", waitlistRouter);
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/cases", casesRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/uploads", uploadsRouter);
if (uploadsRouter?.userPhotoRouter) {
  app.use("/api/users", uploadsRouter.userPhotoRouter);
}
app.use("/api/payments", paymentsRouter);
app.use("/api/checklist", checklistRouter);
app.use("/api/events", eventsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/applications", applicationsRouter);
app.use("/api/attorney/dashboard", attorneyDashboardRouter);
app.use("/api/paralegal/dashboard", paralegalDashboardRouter);
app.use("/api/chat", chatRouter);
app.use("/api/users", usersRouter);
app.use("/api/verify", verificationRouter);
if (usersRouter?.paralegalRouter) {
  app.use("/api/paralegals", usersRouter.paralegalRouter);
}
app.use("/api/disputes", disputesRouter);

// 5) CSRF token route
app.get("/api/csrf", csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.get("/ping", (_req, res) => {
  res.json({ ping: "pong" });
});

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// 6) Static + SPA fallback
app.use(express.static(FRONTEND_DIR));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// 7) Error + 404 Handlers
app.use((req, res) => res.status(404).send("Not found"));
app.use((err, _req, res, _next) => {
  console.error("❌ Uncaught error:", err);
  res.status(500).send("Server error");
});

// 8) MongoDB Connection & Server start
function connectWithRetry() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ MONGO_URI is not set. Cannot connect to MongoDB.");
    return;
  }
  mongoose
    .connect(uri)
    .then(() => console.log("✅ Connected to MongoDB Atlas"))
    .catch((err) => {
      console.error("❌ MongoDB Error:", err);
      setTimeout(connectWithRetry, 5000);
    });
}

connectWithRetry();

app.listen(PORT, () => {
  console.log(`🚀 Server is live at http://localhost:${PORT}`);
});

startPurgeWorker();
