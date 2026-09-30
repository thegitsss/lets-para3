// 0) Env
require("dotenv").config({ quiet: true });
const { assertProductionOriginConfiguration } = require("./utils/productionOrigin");
const { assertLegalDocumentApproval } = require("./utils/legalDocumentApproval");
const { releaseCommit, releaseIdentityMiddleware } = require("./utils/releaseIdentity");

assertProductionOriginConfiguration(process.env);
assertLegalDocumentApproval(process.env);

// 1) Core + Libs
const express = require("express");
const path = require("path");
const { setStaticResponseHeaders } = require("./utils/staticCache");
const { createLogger } = require("./utils/logger");
const { startRealtimeProjectionBridge } = require("./services/realtimeProjectionBridge");
const { requestIdMiddleware } = require("./utils/requestId");
const {
  collectInlineScriptHashes,
  upgradeInsecureRequestsDirective,
} = require("./utils/contentSecurityPolicy");
const { csrfTokenMiddleware, respondToCsrfError } = require("./utils/csrf");
const { createWebNotFoundHandler } = require("./utils/webNotFound");
const mongoose = require("mongoose");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

// 2) App Init + Config
const app = express();
const logger = createLogger("server");
app.use("/api/webhooks/stripe", require("./routes/paymentsWebhook"));
app.set("trust proxy", 1);
const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 5050);
const FRONTEND_DIR = require("./utils/frontendAssets").frontendDirectory();
const PUBLIC_DIR = path.join(__dirname, "../public");

// 3) Global Middleware
app.use(requestIdMiddleware);
app.use(releaseIdentityMiddleware(process.env));
app.use((req, res, next) => {
  if (req.hostname === "lets-paraconnect.com") {
    return res.redirect(301, "https://www.lets-paraconnect.com" + req.url);
  }
  next();
});
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        ...collectInlineScriptHashes(FRONTEND_DIR),
        "https://js.stripe.com",
        "https://challenges.cloudflare.com",
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: [
        "'self'",
        "https://js.stripe.com",
        "https://hooks.stripe.com",
        "https://challenges.cloudflare.com",
      ],
      connectSrc: ["'self'", "https://api.stripe.com", "https://challenges.cloudflare.com"],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://images.unsplash.com",
        "https://challenges.cloudflare.com",
        `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com`,
      ],
      upgradeInsecureRequests: upgradeInsecureRequestsDirective(PROD),
      },
    },
    hsts: PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  })
);
app.use(compression({ threshold: 1024 }));

app.use("/api/auth/login", rateLimit({ windowMs: 60 * 1000, max: 10 }));
app.use("/api/auth/register", rateLimit({ windowMs: 60 * 1000, max: 10 }));
app.use(
  "/api/auth/google",
  rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false })
);
app.use(
  "/api/auth/request-password-reset",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false })
);
app.use(
  "/api/auth/reset-password",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false })
);
app.use(
  ["/api/auth/2fa-verify", "/api/auth/2fa-backup"],
  rateLimit({ windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false })
);
app.use(
  ["/api/auth/passkeys/authentication-options", "/api/auth/passkeys/authenticate"],
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false })
);
app.use(
  ["/api/account/2fa/authenticator/setup", "/api/account/2fa/authenticator/confirm", "/api/account/passkeys/registration-options"],
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false })
);
app.use(
  "/api/auth/resend-verification",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false })
);
app.use(
  "/api/auth/verify-email",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false })
);
app.use(
  "/api/messages",
  rateLimit({
    windowMs: 10 * 1000,
    max: (req) => (req.method === "GET" ? 40 : 15),
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(
  "/api/uploads",
  rateLimit({
    windowMs: 10 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
const casesRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PROD ? 120 : 10000,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many case requests, please try again shortly.",
});

app.use("/api/cases", casesRateLimiter);
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: PROD ? 300 : 10000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use("/api", (_req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res
      .set({ 'Retry-After': '5', 'Cache-Control': 'no-store' })
      .status(503)
      .json({ error: "Service temporarily unavailable. Please try again shortly." });
  }
  next();
});

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// 4) Routers
const authRouter = require("./routes/auth");
const aiAdminRouter = require("./routes/aiAdmin");
const adminKnowledgeRouter = require("./routes/adminKnowledge");
const adminMarketingRouter = require("./routes/adminMarketing");
const adminDirectorsRouter = require("./routes/adminDirectors");
const adminSupportRouter = require("./routes/adminSupport");
const adminWorkspaceRouter = require("./routes/adminWorkspace");
const adminSalesRouter = require("./routes/adminSales");
const adminApprovalsRouter = require("./routes/adminApprovals");
const adminEngineeringRouter = require("./routes/adminEngineering");
const autonomousActionsRouter = require("./routes/autonomousActions");
const adminRouter = require("./routes/admin");
const incidentAdminRouter = require("./routes/incidentAdmin");
const incidentsRouter = require("./routes/incidents");
const casesRouter = require("./routes/cases");
const caseDraftsRouter = require("./routes/caseDrafts");
const messagesRouter = require("./routes/messages");
const uploadsRouter = require("./routes/uploads");
const paymentsRouter = require("./routes/payments");
const usersRouter = require("./routes/users");
const disputesRouter = require("./routes/disputes");
const jobsRouter = require("./routes/jobs");
const applicationsRouter = require("./routes/applications");
const attorneyDashboardRouter = require("./routes/attorneyDashboard");
const paralegalDashboardRouter = require("./routes/paralegalDashboard");
const paralegalsRouter = require("./routes/paralegals");
const checklistRouter = require("./routes/checklist");
const eventsRouter = require("./routes/events");
const verificationRouter = require("./routes/verification");
const publicRouter = require("./routes/public");
const publicParalegalDirectoryRouter = require("./routes/publicParalegalDirectory");
const performanceRouter = require("./routes/performance");
const accountRouter = require("./routes/account");
const notificationRouter = require("./routes/notifications");
const supportRouter = require("./routes/support");
const directorPortalRouter = require("./routes/directorPortal");
const { isCcoAutonomyHarnessEnabled } = require("./utils/ccoAutonomyHarnessAccess");
const { isControlRoomE2eHarnessEnabled } = require("./utils/controlRoomE2eHarnessAccess");
const blocksRouter = require("./routes/blocks");

app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api/incidents", incidentsRouter);
if (isControlRoomE2eHarnessEnabled(process.env)) {
  const controlRoomE2eHarnessRouter = require("./routes/controlRoomE2eHarness");
  app.use("/api/admin/ai-control-room/dev/e2e", controlRoomE2eHarnessRouter);
}
app.use("/api/admin/ai", aiAdminRouter);
app.use("/api/admin/ai-control-room", aiAdminRouter);
app.use("/api/admin/knowledge", adminKnowledgeRouter);
app.use("/api/admin/marketing", adminMarketingRouter);
app.use("/api/admin/directors", adminDirectorsRouter);
app.use("/api/admin/support", adminSupportRouter);
if (isCcoAutonomyHarnessEnabled(process.env)) {
  const ccoAutonomyHarnessRouter = require("./routes/ccoAutonomyHarness");
  app.use("/api/admin/support/dev/cco-autonomy", ccoAutonomyHarnessRouter);
}
app.use("/api/admin/sales", adminSalesRouter);
app.use("/api/director", directorPortalRouter);
app.use("/api/admin/approvals", adminApprovalsRouter);
app.use("/api/admin/engineering", adminEngineeringRouter);
app.use("/api/admin/autonomous-actions", autonomousActionsRouter);
app.use("/api/admin/incidents", incidentAdminRouter);
app.use("/api/admin/workspace", adminWorkspaceRouter);
app.use("/api/admin", adminRouter);
app.use("/api/cases", casesRouter);
app.use("/api/case-drafts", caseDraftsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/checklist", checklistRouter);
app.use("/api/events", eventsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/applications", applicationsRouter);
app.use("/api/attorney/dashboard", attorneyDashboardRouter);
app.use("/api/paralegal/dashboard", paralegalDashboardRouter);
app.use("/api/paralegals", paralegalsRouter);
app.use("/api/users", usersRouter);
app.use("/api/account", accountRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/support", supportRouter);
app.use("/api/blocks", blocksRouter);
app.use("/api/verify", verificationRouter);
app.use("/api/performance", performanceRouter);
app.use("/api/public/paralegals", publicParalegalDirectoryRouter);
app.use("/public/paralegals", publicParalegalDirectoryRouter);
app.use("/api/public", publicRouter);
app.use("/public", publicRouter);
if (usersRouter?.paralegalRouter) {
  app.use("/api/paralegals", usersRouter.paralegalRouter);
}
app.use("/api/disputes", disputesRouter);

// 5) CSRF token route
app.get("/api/csrf", csrfTokenMiddleware, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

app.get("/api/health", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  res.status(dbState === 1 ? 200 : 503).json({
    ok: dbState === 1,
    db: dbState === 1 ? "connected" : "disconnected",
  });
});

app.get("/assets/vendor/simplewebauthn.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.redirect(302, "/assets/vendor/simplewebauthn-13.3.0.js");
});

app.get("/assets/vendor/simplewebauthn-13.3.0.js", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.type("application/javascript");
  res.sendFile(path.join(
    __dirname,
    "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js"
  ));
});

app.get("/assets/vendor/web-vitals-6.1.1.js", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "node_modules/web-vitals/dist/web-vitals.js"));
});

app.get("/assets/vendor/chart-4.5.1.js", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "node_modules/chart.js/dist/chart.umd.js"));
});

// 6) Static documents
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const staticOptions = {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => setStaticResponseHeaders(res, filePath, { production: PROD }),
};
app.use(express.static(PUBLIC_DIR, staticOptions));
app.use(express.static(FRONTEND_DIR, staticOptions));

// 7) Error + 404 Handlers
app.use(createWebNotFoundHandler(FRONTEND_DIR));
app.use((err, req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  logger.error({
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    errorName: String(err?.name || "Error"),
    errorCode: String(err?.code || "UNHANDLED_ERROR"),
    message: "Unhandled request error.",
  });
  res.status(500).send("Server error");
});

// 8) MongoDB Connection & Server start
let mongoRetryTimer = null;
let shuttingDown = false;
let realtimeProjectionBridge = null;

function connectWithRetry() {
  if (shuttingDown) return;
  const uri = process.env.MONGO_URI;
  if (!uri) {
    logger.error("MONGO_URI is not set. Cannot connect to MongoDB.");
    return;
  }
  mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 20000,
    })
    .then(() => {
      logger.info("Connected to MongoDB Atlas.");
      if (!realtimeProjectionBridge) {
        realtimeProjectionBridge = startRealtimeProjectionBridge({ logger });
      }
    })
    .catch((err) => {
      logger.error("MongoDB connection failed.", err);
      if (!shuttingDown) mongoRetryTimer = setTimeout(connectWithRetry, 5000);
    });
}

connectWithRetry();

const server = app.listen(PORT, () => {
  const displayUrl = PROD ? process.env.APP_BASE_URL : `http://localhost:${PORT}`;
  logger.info({
    releaseCommit: releaseCommit(process.env) || undefined,
    url: displayUrl,
    message: "Server is live.",
  });
});

const openSockets = new Set();
server.on("connection", (socket) => {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
});

let shutdownPromise = null;
async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    if (mongoRetryTimer) clearTimeout(mongoRetryTimer);
    mongoRetryTimer = null;
    logger.info({ signal, message: "Shutdown requested; draining LPC." });
    server.closeIdleConnections?.();
    const closed = new Promise((resolve) => {
      server.close((error) => resolve(error || null));
    });
    const forceTimer = setTimeout(() => {
      for (const socket of openSockets) socket.destroy();
    }, 25_000);
    forceTimer.unref?.();


    const closeError = await closed;
    clearTimeout(forceTimer);
    await realtimeProjectionBridge?.stop?.();
    realtimeProjectionBridge = null;
    try {
      await mongoose.disconnect();
    } catch (error) {
      logger.error("MongoDB disconnect failed.", error);
      process.exitCode = 1;
    }
    if (closeError) {
      logger.error("HTTP server close failed.", closeError);
      process.exitCode = 1;
    }
    logger.info("LPC stopped cleanly.");
  })();
  return shutdownPromise;
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    shutdown(signal).catch((error) => {
      logger.error("LPC shutdown failed.", error);
      process.exitCode = 1;
    });
  });
}
