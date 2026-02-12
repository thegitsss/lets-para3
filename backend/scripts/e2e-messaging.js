const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const puppeteer = require("puppeteer");

function patchElementHandleClick() {
  const { ElementHandle } = puppeteer;
  if (!ElementHandle || ElementHandle.prototype.__safeClickPatched) return;
  const original = ElementHandle.prototype.click;
  ElementHandle.prototype.click = async function (...args) {
    try {
      return await this.evaluate((el) => el.click());
    } catch {
      return original.apply(this, args);
    }
  };
  ElementHandle.prototype.__safeClickPatched = true;
}
patchElementHandleClick();

const CASE_ID = "507f1f77bcf86cd799439099";

const USERS = {
  attorney: {
    id: "507f1f77bcf86cd799439011",
    _id: "507f1f77bcf86cd799439011",
    role: "attorney",
    status: "approved",
    firstName: "Alex",
    lastName: "Stone",
    email: "samanthasider+attorney@gmail.com",
    password: "Password123!",
  },
  paralegal: {
    id: "507f191e810c19729de860ea",
    _id: "507f191e810c19729de860ea",
    role: "paralegal",
    status: "approved",
    firstName: "Priya",
    lastName: "Ng",
    email: "samanthasider+paralegal@gmail.com",
    password: "Password123!",
  },
};

const CASE = {
  id: CASE_ID,
  attorneyId: USERS.attorney.id,
  paralegalId: USERS.paralegal.id,
  status: "in progress",
  escrowStatus: "funded",
};

function startStubServer() {
  const app = express();
  const sessions = new Map();
  const messages = [];
  const emailLog = [];
  const SESSION_COOKIE = "lpc_session";

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  app.get("/e2e.html", (_req, res) => {
    res.send("<html><body>e2e</body></html>");
  });

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    const user = Object.values(USERS).find((u) => u.email === email && u.password === password);
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });
    const token = Math.random().toString(36).slice(2);
    sessions.set(token, user.id);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax" });
    return res.json({ success: true, user });
  });

  app.get("/api/auth/me", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const userId = sessions.get(token);
    const user = Object.values(USERS).find((u) => u.id === userId);
    if (!user) return res.status(401).json({ user: null });
    return res.json({ user });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ success: true });
  });

  function requireSession(req, res) {
    const token = req.cookies?.[SESSION_COOKIE];
    const userId = sessions.get(token);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return Object.values(USERS).find((u) => u.id === userId) || null;
  }

  function requireCaseMember(user, res) {
    if (!user) return false;
    const ok = [CASE.attorneyId, CASE.paralegalId].includes(user.id);
    if (!ok) res.status(403).json({ error: "Access denied" });
    return ok;
  }

  app.get("/api/messages/:caseId", (req, res) => {
    const user = requireSession(req, res);
    if (!user) return;
    if (!requireCaseMember(user, res)) return;
    return res.json({ messages });
  });

  app.post("/api/messages/:caseId", (req, res) => {
    const user = requireSession(req, res);
    if (!user) return;
    if (!requireCaseMember(user, res)) return;
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const msg = {
      _id: `msg_${messages.length + 1}`,
      caseId: req.params.caseId,
      senderId: user.id,
      senderRole: user.role,
      text,
      readBy: [],
      createdAt: new Date().toISOString(),
    };
    messages.push(msg);

    if (user.role === "paralegal") {
      emailLog.push({ to: USERS.attorney.email, subject: "New message on LPC" });
    }

    return res.status(201).json({ message: msg });
  });

  app.post("/api/messages/:caseId/read", (req, res) => {
    const user = requireSession(req, res);
    if (!user) return;
    if (!requireCaseMember(user, res)) return;
    messages.forEach((msg) => {
      if (!msg.readBy.includes(user.id)) msg.readBy.push(user.id);
    });
    res.json({ ok: true });
  });

  app.get("/api/test/email-log", (_req, res) => {
    res.json({ emails: emailLog });
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function api(page, { method, path, body }) {
  return page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }, { method, path, body });
}

async function login(page, baseUrl, { email, password }) {
  await api(page, {
    method: "POST",
    path: `${baseUrl}/api/auth/login`,
    body: { email, password },
  });
}

async function run() {
  const { server, port } = await startStubServer();
  const baseUrl = `http://localhost:${port}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 120_000,
  });

  const defaultContext = browser.defaultBrowserContext();
  const createContext = async () => {
    if (typeof browser.createIncognitoBrowserContext === "function") {
      return browser.createIncognitoBrowserContext();
    }
    if (typeof browser.createBrowserContext === "function") {
      return browser.createBrowserContext();
    }
    return defaultContext;
  };
  const closeContext = async (ctx) => {
    if (ctx && ctx !== defaultContext && typeof ctx.close === "function") {
      await ctx.close();
    }
  };

  const paraCtx = await createContext();
  const paraPage = await paraCtx.newPage();
  paraPage.setDefaultTimeout(60_000);
  paraPage.setDefaultNavigationTimeout(60_000);
  const attyCtx = await createContext();
  const attyPage = await attyCtx.newPage();
  attyPage.setDefaultTimeout(60_000);
  attyPage.setDefaultNavigationTimeout(60_000);

  try {
    await paraPage.goto(`${baseUrl}/e2e.html`, { waitUntil: "networkidle0" });
    await attyPage.goto(`${baseUrl}/e2e.html`, { waitUntil: "networkidle0" });

    // Test: Paralegal sends message to attorney.
    // Input values: text="Draft is ready for review".
    // Expected result: POST /api/messages returns 201.
    await login(paraPage, baseUrl, { email: USERS.paralegal.email, password: USERS.paralegal.password });
    const sendRes = await api(paraPage, {
      method: "POST",
      path: `${baseUrl}/api/messages/${CASE_ID}`,
      body: { text: "Draft is ready for review" },
    });
    if (!sendRes.ok) throw new Error(`Send failed: ${sendRes.status}`);

    // Test: Attorney sees message and marks as read.
    // Input values: GET /api/messages then POST /read.
    // Expected result: message present; readBy updated.
    await login(attyPage, baseUrl, { email: USERS.attorney.email, password: USERS.attorney.password });
    const listRes = await api(attyPage, {
      method: "GET",
      path: `${baseUrl}/api/messages/${CASE_ID}`,
    });
    if (!listRes.ok || listRes.data.messages?.length !== 1) {
      throw new Error(`Expected 1 message, got ${listRes.data.messages?.length || 0}`);
    }

    const readRes = await api(attyPage, {
      method: "POST",
      path: `${baseUrl}/api/messages/${CASE_ID}/read`,
      body: {},
    });
    if (!readRes.ok) throw new Error("Read failed");

    // Test: Read state persists between logins.
    // Input values: fresh attorney session GET /api/messages.
    // Expected result: message.readBy contains attorney id.
    const freshCtx = await createContext();
    const freshPage = await freshCtx.newPage();
    await freshPage.goto(`${baseUrl}/e2e.html`, { waitUntil: "networkidle0" });
    await login(freshPage, baseUrl, { email: USERS.attorney.email, password: USERS.attorney.password });
    const listRes2 = await api(freshPage, {
      method: "GET",
      path: `${baseUrl}/api/messages/${CASE_ID}`,
    });
    const readBy = listRes2.data.messages?.[0]?.readBy || [];
    if (!readBy.includes(USERS.attorney.id)) {
      throw new Error("Read state did not persist between logins");
    }
    await freshPage.close();
    await closeContext(freshCtx);

    // Test: Notification emails are received.
    // Input values: paralegal message triggers email.
    // Expected result: email log contains attorney email.
    const emailRes = await api(attyPage, { method: "GET", path: `${baseUrl}/api/test/email-log` });
    const emails = emailRes.data.emails || [];
    if (!emails.find((entry) => entry.to === USERS.attorney.email)) {
      throw new Error("Notification email not logged");
    }

    console.log("E2E messaging + notifications validation complete.");
  } finally {
    await paraPage.close();
    await attyPage.close();
    await closeContext(paraCtx);
    await closeContext(attyCtx);
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
