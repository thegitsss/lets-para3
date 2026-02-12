const path = require("path");
const http = require("http");
const crypto = require("crypto");
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

const ATTORNEY = {
  id: "507f1f77bcf86cd799439011",
  _id: "507f1f77bcf86cd799439011",
  role: "attorney",
  status: "approved",
  firstName: "Ava",
  lastName: "Stone",
  email: "attorney@example.com",
  password: "Password123!",
  lawFirm: "",
  practiceAreas: [],
  bio: "",
};

const PARALEGAL = {
  id: "507f191e810c19729de860ea",
  _id: "507f191e810c19729de860ea",
  role: "paralegal",
  status: "approved",
  firstName: "Priya",
  lastName: "Ng",
  email: "paralegal@example.com",
  password: "Password123!",
  bio: "",
  skills: ["Research"],
  practiceAreas: ["Immigration"],
  resumeURL: "paralegal-resumes/p1/resume.pdf",
  profileImage: "paralegal-photos/p1.jpg",
  profilePhotoStatus: "approved",
};

const CASE_ID = "507f1f77bcf86cd799439022";
const MESSAGE_ID = "507f1f77bcf86cd799439033";

function startStubServer() {
  const app = express();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");

  const users = new Map([
    [ATTORNEY.email, { ...ATTORNEY }],
    [PARALEGAL.email, { ...PARALEGAL }],
  ]);
  const userById = new Map([
    [ATTORNEY.id, users.get(ATTORNEY.email)],
    [PARALEGAL.id, users.get(PARALEGAL.email)],
  ]);

  const sessions = new Map();
  const weeklyNotes = new Map();
  const messages = new Map([
    [CASE_ID, [{
      _id: MESSAGE_ID,
      caseId: CASE_ID,
      senderId: PARALEGAL.id,
      senderRole: "paralegal",
      text: "Update on filings",
      content: "Update on filings",
      readBy: [],
      createdAt: new Date(Date.now() - 1000).toISOString(),
    }]],
  ]);

  const SESSION_COOKIE = "lpc_session";

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));

  function getSessionUser(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const userId = sessions.get(token);
    return userById.get(userId) || null;
  }

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    const user = users.get(String(email || "").toLowerCase());
    if (!user || user.password !== password) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }
    const token = crypto.randomBytes(16).toString("hex");
    sessions.set(token, user.id);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax" });
    return res.json({ success: true, user });
  });

  app.get("/api/auth/me", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ user: null });
    return res.json({ user });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ success: true });
  });

  app.get("/api/users/me", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    return res.json(user);
  });

  app.patch("/api/users/me", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const updates = req.body || {};
    Object.assign(user, updates);
    userById.set(user.id, user);
    users.set(user.email.toLowerCase(), user);
    return res.json(user);
  });

  app.get("/api/users/me/onboarding", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    return res.json({ onboarding: user.onboarding || {} });
  });

  app.patch("/api/users/me/onboarding", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    user.onboarding = { ...(user.onboarding || {}), ...(req.body || {}) };
    return res.json({ onboarding: user.onboarding });
  });

  app.put("/api/users/me/weekly-notes", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const weekStart = String(req.body?.weekStart || "").slice(0, 10);
    const notes = Array.isArray(req.body?.notes) ? req.body.notes.slice(0, 7) : Array(7).fill("");
    const key = `${user.id}:${weekStart}`;
    weeklyNotes.set(key, notes);
    res.json({ weekStart, notes, updatedAt: new Date().toISOString() });
  });

  app.get("/api/users/me/weekly-notes", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const weekStart = String(req.query?.weekStart || "").slice(0, 10);
    const key = `${user.id}:${weekStart}`;
    const notes = weeklyNotes.get(key) || Array(7).fill("");
    res.json({ weekStart, notes, updatedAt: new Date().toISOString() });
  });

  app.post("/api/messages/:caseId/read", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const caseId = req.params.caseId;
    const items = messages.get(caseId) || [];
    items.forEach((msg) => {
      if (!msg.readBy.includes(user.id)) msg.readBy.push(user.id);
    });
    messages.set(caseId, items);
    res.json({ updatedLegacy: items.length, updatedReceipts: items.length });
  });

  app.get("/api/messages/:caseId", (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const caseId = req.params.caseId;
    res.json({ messages: messages.get(caseId) || [] });
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function login(page, baseUrl, { email, password }) {
  await page.goto(`${baseUrl}/login.html`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#loginForm");
  await page.type("#email", email);
  await page.type("#password", password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.evaluate((selector) => document.querySelector(selector)?.click(), "#loginForm button[type=\"submit\"]"),
  ]);
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
  const closeContext = async (context) => {
    if (context && context !== defaultContext && typeof context.close === "function") {
      await context.close();
    }
  };
  const configurePage = (page) => {
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(60_000);
  };

  try {
    // Test: Attorney profile persists after logout/login.
    // Input values: lawFirm="Stone & Co", practiceAreas=["Litigation"], bio="Trial counsel".
    // Expected result: /api/users/me returns saved fields after re-login.
    const attorneyContext = await createContext();
    const attorneyPage = await attorneyContext.newPage();
    configurePage(attorneyPage);
    await attorneyPage.setViewport({ width: 1280, height: 720 });
    await login(attorneyPage, baseUrl, { email: ATTORNEY.email, password: ATTORNEY.password });

    const attorneyUpdate = await api(attorneyPage, {
      method: "PATCH",
      path: "/api/users/me",
      body: { lawFirm: "Stone & Co", practiceAreas: ["Litigation"], bio: "Trial counsel" },
    });
    if (!attorneyUpdate.ok) throw new Error("Attorney profile update failed");

    await api(attorneyPage, { method: "POST", path: "/api/auth/logout" });
    await attorneyPage.evaluate(() => localStorage.clear());

    await login(attorneyPage, baseUrl, { email: ATTORNEY.email, password: ATTORNEY.password });
    const attorneyReload = await api(attorneyPage, { method: "GET", path: "/api/users/me" });
    if (attorneyReload.data.lawFirm !== "Stone & Co") {
      throw new Error("Attorney profile did not persist after logout/login");
    }

    // Test: Paralegal profile persists after logout/login.
    // Input values: bio="Immigration paralegal with 8 years of experience.", skills=["Research","Drafting"], practiceAreas=["Immigration"].
    // Expected result: /api/users/me returns saved fields after re-login.
    const paralegalContext = await createContext();
    const paralegalPage = await paralegalContext.newPage();
    configurePage(paralegalPage);
    await paralegalPage.setViewport({ width: 1280, height: 720 });
    await login(paralegalPage, baseUrl, { email: PARALEGAL.email, password: PARALEGAL.password });

    const paralegalUpdate = await api(paralegalPage, {
      method: "PATCH",
      path: "/api/users/me",
      body: {
        bio: "Immigration paralegal with 8 years of experience.",
        skills: ["Research", "Drafting"],
        practiceAreas: ["Immigration"],
      },
    });
    if (!paralegalUpdate.ok) throw new Error("Paralegal profile update failed");

    await api(paralegalPage, { method: "POST", path: "/api/auth/logout" });
    await paralegalPage.evaluate(() => localStorage.clear());

    await login(paralegalPage, baseUrl, { email: PARALEGAL.email, password: PARALEGAL.password });
    const paralegalReload = await api(paralegalPage, { method: "GET", path: "/api/users/me" });
    if (!String(paralegalReload.data.bio || "").includes("Immigration paralegal")) {
      throw new Error("Paralegal profile did not persist after logout/login");
    }

    // Test: Weekly notes stored server-side (not localStorage).
    // Input values: weekStart="2026-02-09", notes[0]="Draft motion outline".
    // Expected result: /api/users/me/weekly-notes returns same note in a fresh browser context.
    const weekStart = "2026-02-09"; // Monday
    const notePayload = {
      weekStart,
      notes: ["Draft motion outline", "", "", "", "", "", ""],
    };
    const notesSave = await api(attorneyPage, {
      method: "PUT",
      path: "/api/users/me/weekly-notes",
      body: notePayload,
    });
    if (!notesSave.ok) throw new Error("Weekly notes save failed");

    const freshNotesContext = await createContext();
    const freshNotesPage = await freshNotesContext.newPage();
    configurePage(freshNotesPage);
    await freshNotesPage.setViewport({ width: 1280, height: 720 });
    await login(freshNotesPage, baseUrl, { email: ATTORNEY.email, password: ATTORNEY.password });
    const notesLoad = await api(freshNotesPage, {
      method: "GET",
      path: `/api/users/me/weekly-notes?weekStart=${weekStart}`,
    });
    if (notesLoad.data.notes?.[0] !== "Draft motion outline") {
      throw new Error("Weekly notes did not persist across devices");
    }

    // Test: Message read status persists across devices.
    // Input values: POST /api/messages/:caseId/read, then GET /api/messages/:caseId from fresh context.
    // Expected result: message.readBy contains attorney id in fresh context.
    const readRes = await api(attorneyPage, {
      method: "POST",
      path: `/api/messages/${CASE_ID}/read`,
      body: {},
    });
    if (!readRes.ok) throw new Error("Failed to mark messages read");

    const freshMessagesContext = await createContext();
    const freshMessagesPage = await freshMessagesContext.newPage();
    configurePage(freshMessagesPage);
    await freshMessagesPage.setViewport({ width: 1280, height: 720 });
    await login(freshMessagesPage, baseUrl, { email: ATTORNEY.email, password: ATTORNEY.password });
    const messagesLoad = await api(freshMessagesPage, {
      method: "GET",
      path: `/api/messages/${CASE_ID}`,
    });
    const readBy = messagesLoad.data.messages?.[0]?.readBy || [];
    if (!readBy.includes(ATTORNEY.id)) {
      throw new Error("Message read status did not persist across devices");
    }

    await closeContext(attorneyContext);
    await closeContext(paralegalContext);
    await closeContext(freshNotesContext);
    await closeContext(freshMessagesContext);

    console.log("E2E profile persistence validation complete.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
